/**
 * createHub: the hub process (docs/hub.md H1, H2). Binds 127.0.0.1 first (the port is the singleton lock), then loads or imports
 * its state, then publishes hub.json. Everything time- or port-dependent is injectable for tests; port 0 picks a free port.
 * Items come in from the agents (hub/agent-api.js, authenticated by hub.secret); the client API routes item actions to the owning
 * agent (hub/routing.js), the phone app files, assetlinks and health are served here. Who is calling comes from hub/roles.js: a paired
 * phone (token, hub/devices.js), this PC itself (desktop), nobody; phones pair with a code (hub/pairing.js) and get push notifications
 * from hub/notifier.js through hub/push.js. The private files (secret, devices, push, vapid) are tightened with icacls (hub/file-acl.js).
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createFileLog } from '../filelog.js'
import { createReviewQueue } from '../service.js'
import { createAgentApi } from './agent-api.js'
import { buildAssetLinks } from './assetlinks.js'
import { createFileIo, readText, writeAtomic } from './atomic-file.js'
import { createCommands } from './commands.js'
import { loadHubConfig } from './config.js'
import { createDevices } from './devices.js'
import { createHardener, hardenedWrite } from './file-acl.js'
import { createHttp } from './http.js'
import { createHubStore } from './hub-store.js'
import { createInstances } from './instances.js'
import { migrateLegacy } from './migrate.js'
import { createNotifier } from './notifier.js'
import { createPairing } from './pairing.js'
import { createPushStore, jsonFileIo, loadOrCreateVapid } from './push.js'
import { createPushRoutes } from './push-routes.js'
import { PROTOCOL } from './protocol.js'
import { createRateLimiter } from './ratelimit.js'
import { createRoles } from './roles.js'
import { ACTION_KINDS, createRouting } from './routing.js'
import { SECRET_FILE, loadOrCreateSecret } from './secret.js'
import { sendPush as realSendPush } from './webpush.js'

export { PROTOCOL }
const IDLE_EXIT_MS = 12 * 3600 * 1000
/** How long after a phone or an open overlay polled the snapshot the apps are told that somebody looks at the session numbers. */
export const WATCH_MS = 60_000
/** The numbers of many apps (each reports on its own tick) wake the long polls at most this often, once, with the final sum. */
export const SESSIONS_WAKE_MS = 3000
const DEVICE_REQUESTS_PER_MINUTE = 120
/** The files only this user may read; tightened after they exist (the temp file of every later write is tightened before it replaces them). */
const PRIVATE_FILES = ['devices.json', 'push.json', 'vapid.json']

const packageVersion = () => {
  try { return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version) } catch { return 'unknown' }
}

/** @param {{ stateDir: string, port?: number, now?: () => number, log?: (line: string) => void, roleOf?: (req: any) => string | undefined,
 *   sendPush?: Function, timers?: { setTimeout: Function, clearTimeout: Function }, sleep?: (ms: number) => Promise<void>, hardener?: ReturnType<typeof createHardener>,
 *   idleExitMs?: number, onIdle?: () => void, tickMs?: number, pid?: number, retentionMs?: number, debounceMs?: number, uuid?: () => string,
 *   secret?: string, onShutdown?: (reason: string) => void, protocol?: number, commandTimeoutsMs?: Record<string, number>, awayMs?: number, graceMs?: number, orphanKeepMs?: number, instanceTickMs?: number }} opts */
export function createHub({ stateDir, port = 0, now = Date.now, log: injectedLog, roleOf, sendPush = realSendPush, timers, sleep, hardener: injectedHardener, idleExitMs = IDLE_EXIT_MS, onIdle, tickMs, pid = process.pid, retentionMs, debounceMs, uuid, secret: injectedSecret, protocol = PROTOCOL, commandTimeoutsMs, awayMs, graceMs, orphanKeepMs, instanceTickMs, onShutdown } = {}) {
  const hubDir = join(stateDir, 'hub')
  const hubJson = join(stateDir, 'hub.json')
  const hubId = randomBytes(8).toString('hex')
  const version = packageVersion()
  let log = injectedLog ?? (() => {})
  let config = loadHubConfig('')
  let store
  let queue
  let server
  let boundPort
  let wroteHubJson = false
  let lastActivity = now()
  let idleFired = false
  let ticks = 0
  let interval
  let instanceInterval
  let instances
  let commands
  let routing
  let agentApi
  let secret
  let stopped
  let hardener
  let devices
  let pairing
  let push
  let vapid
  let roles
  let pushRoutes
  let notifier
  let http
  let desktopSeenAt = -Infinity
  const sessionListeners = new Set() // woken when the summed session numbers change
  let watchedAt = -Infinity // when a phone or an open overlay last polled the snapshot
  let sessionsTimer // the one trailing timer that wakes the listeners for the numbers
  const deviceLimiter = createRateLimiter({ now, limit: DEVICE_REQUESTS_PER_MINUTE, windowMs: 60_000 })

  /** Devices, pairing, push and roles (H4): created once the state folder and the config are known. */
  function startPhoneSide({ tightenSecret }) {
    hardener = injectedHardener ?? createHardener({ log: (l) => log(l) })
    const priv = hardenedWrite({ harden: (file) => hardener.harden(file), mode: 0o600 })
    const keep = [...PRIVATE_FILES.map((name) => join(hubDir, name)), ...(tightenSecret ? [join(stateDir, SECRET_FILE)] : [])]
    for (const file of keep) if (existsSync(file)) hardener.harden(file)
    devices = createDevices({ io: createFileIo(join(hubDir, 'devices.json'), priv), now, log: (l) => log(l), onRevoke: (id) => { const dropped = push.removeByDevice(id); http.abortDevice(id); log('device revoked (' + id + '), ' + dropped + ' push subscription(s) dropped') } })
    pairing = createPairing({ devices, now, ...(sleep ? { sleep } : {}), log: (l) => log(l) })
    roles = createRoles({ devices, port: () => boundPort, config: () => config })
    // The key pair is created on first use (a hub nobody pushes through never writes it); a legacy vapid.json was copied by the migration.
    const vapidIo = jsonFileIo(join(hubDir, 'vapid.json'), { mode: 0o600, prepare: priv.prepare })
    // Apple's push service rejects a mailto on localhost: without an explicit pushSubject the https public origin is the VAPID subject.
    const keyPair = () => (vapid ??= loadOrCreateVapid({ io: vapidIo, subject: config.pushSubject ?? (config.publicOrigin?.startsWith('https://') ? config.publicOrigin : undefined) }))
    push = createPushStore({ io: jsonFileIo(join(hubDir, 'push.json'), { mode: 0o600, prepare: priv.prepare }), now, sendPush, vapid: keyPair })
    pushRoutes = createPushRoutes({ push, publicKey: () => keyPair().publicKey })
  }

  const hub = {
    hubId, protocol, version, idleExitMs, onShutdown, deviceLimiter, now: () => now(),
    get port() { return boundPort },
    get store() { return store },
    get config() { return config },
    get ticks() { return ticks },
    actionKinds: ACTION_KINDS,
    get instances() { return instances },
    get commands() { return commands },
    get agentApi() { return agentApi },
    get devices() { return devices },
    get pairing() { return pairing },
    get push() { return push },
    get roles() { return roles },
    get hardener() { return hardener },
    pushRoutes: (...args) => pushRoutes(...args),
    /** Who is calling: the injected role function (tests) or the real rules of hub/roles.js. */
    identify: (req) => (roleOf ? { role: roleOf(req) } : roles.identify(req)),
    /** A desktop overlay reported that somebody is looking at it (a snapshot poll with visible=1); the notifier holds pushes while that is recent. */
    notePresence() { desktopSeenAt = now() },
    get desktopSeenAt() { return desktopSeenAt },
    /** The snapshot of the store with what the cards need to say why an action may be disabled: owner label and state. */
    snapshot() {
      const snap = queue.snapshot()
      const decorate = (item) => { const v = instances.view(item.owner); return { ...item, ownerLabel: v.label, ownerState: v.state } }
      const sessions = instances.sessionsTotal()
      return { ...snap, ...(sessions ? { sessions } : {}), open: snap.open.map(decorate), resolved: snap.resolved.map(decorate) }
    },
    /** A phone or an open overlay asked for the snapshot: the apps keep their session numbers fresh for the next WATCH_MS. */
    noteWatch() { watchedAt = now() },
    watching: () => now() - watchedAt < WATCH_MS,
    /** "N working / M open" over every online app, or undefined (no app reports). */
    sessions: () => instances?.sessionsTotal(),
    snapshotId: () => store.epoch + ':' + store.rev,
    /** Item changes and changes of the summed session numbers (the long polls wake on both; only the first moves the snapshot id). */
    onChange(listener) {
      const off = store.onChange(listener)
      sessionListeners.add(listener)
      return () => { off(); sessionListeners.delete(listener) }
    },
    workspaces: (opts) => instances.workspaces(opts),
    /** The sessions of every online app for the follow-up form's dropdown: { sessions, skippedApps }. */
    followUpSessions: (caller) => routing.followUpSessions(caller),
    modelEfforts: (caller) => routing.modelEfforts(caller),
    assetLinks: () => buildAssetLinks(config.android),
    /** Any request but a health probe counts as activity for the idle exit. */
    touch() { lastActivity = now() },

    /** One client action (POST /v1/<kind>): hub-local ones are applied here, the rest runs in the owning app (hub/routing.js). */
    act: (kind, body, ctx) => routing.act(kind, body, ctx),

    /** Housekeeping (hourly in the old plugin, every minute here): prune resolved items, fire the idle exit once. */
    tick() {
      ticks++
      store?.prune()
      if (idleExitMs > 0 && !idleFired && now() - lastActivity >= idleExitMs) {
        idleFired = true
        log('idle: no requests for ' + Math.round(idleExitMs / 1000) + ' s')
        onIdle?.()
      }
    },

    /** Bind, load state, publish hub.json. Rejects (EADDRINUSE) before touching any file when the port is taken. */
    async start() {
      http = createHttp({ hub, log: (l) => log(l) })
      hub.shutdownHttp = http.shutdown
      server = createServer(http.handler)
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
      } catch (error) { server.close(); server = undefined; throw error }
      boundPort = server.address().port

      mkdirSync(hubDir, { recursive: true })
      if (!injectedLog) log = createFileLog(join(hubDir, 'hub.log'), { now })
      config = loadHubConfig(stateDir, { log })
      try { migrateLegacy({ stateDir, hubDir, now, log }) } catch (error) { log('legacy import failed: ' + String(error?.code ?? error?.name ?? 'error')) }
      store = createHubStore({ now, uuid, io: createFileIo(join(hubDir, 'queue.json')), retentionMs, debounceMs, log })
      if (store.loadedFrom === 'empty') store.flush(true) // so the legacy import cannot run twice
      store.prune()
      queue = createReviewQueue({ store, capture: {}, controllerOf: () => undefined, now, log })
      secret = injectedSecret ?? loadOrCreateSecret(stateDir)
      startPhoneSide({ tightenSecret: injectedSecret === undefined })
      notifier = createNotifier({ store, push, now, ...(timers ? { timers } : {}), presence: () => desktopSeenAt, log: (l) => log(l) })
      commands = createCommands({ now, timeoutsMs: commandTimeoutsMs })
      instances = createInstances({ store, commands, now, log: (l) => log(l), awayMs, graceMs: graceMs ?? config.staleGraceMs, orphanKeepMs, onSessions: () => {
        if (sessionsTimer) return
        sessionsTimer = (timers ?? globalThis).setTimeout(() => { sessionsTimer = undefined; for (const l of [...sessionListeners]) { try { l() } catch { /* ignore */ } } }, SESSIONS_WAKE_MS)
        sessionsTimer.unref?.()
      } })
      routing = createRouting({ store, queue, instances, commands, log: (l) => log(l), now })
      agentApi = createAgentApi({ hub, instances, commands, store, secret, log: (l) => log(l) })

      lastActivity = now()
      writeAtomic(hubJson, JSON.stringify({ pid, port: boundPort, hubId, version, protocol, startedAt: now() }))
      wroteHubJson = true
      rmSync(join(stateDir, 'hub.lock'), { force: true })
      const every = tickMs ?? (idleExitMs > 0 ? Math.min(60_000, Math.max(50, idleExitMs / 4)) : 60_000)
      if (every > 0) { interval = setInterval(() => hub.tick(), every); interval.unref?.() }
      const instanceEvery = instanceTickMs ?? (tickMs === 0 ? 0 : 10_000)
      if (instanceEvery > 0) { instanceInterval = setInterval(() => instances.tick(), instanceEvery); instanceInterval.unref?.() }
      log('hub started (pid ' + pid + ', protocol ' + protocol + ')')
      return { port: boundPort, hubId }
    },

    /** Graceful: waiting long polls get 503, the queue is flushed, hub.json goes only when it still names this pid. Idempotent. */
    stop() {
      stopped ??= (async () => {
        clearInterval(interval)
        clearInterval(instanceInterval)
        if (sessionsTimer) (timers ?? globalThis).clearTimeout(sessionsTimer)
        sessionsTimer = undefined
        notifier?.dispose()
        devices?.flush()
        hub.shutdownHttp?.()
        agentApi?.stop()
        if (server?.listening) {
          const closed = new Promise((resolve) => server.close(resolve))
          server.closeIdleConnections?.()
          const force = setTimeout(() => server.closeAllConnections?.(), 2000)
          force.unref?.()
          await closed
          clearTimeout(force)
        }
        store?.close()
        if (wroteHubJson) {
          try {
            if (JSON.parse(readText(hubJson) ?? '{}').pid === pid) rmSync(hubJson, { force: true })
          } catch { /* garbled: leave it */ }
        }
        if (existsSync(hubDir)) log('hub stopped')
      })()
      return stopped
    },
  }
  return hub
}
