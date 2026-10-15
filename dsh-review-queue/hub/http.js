/**
 * The hub's HTTP surface: a Host allow-list (DNS rebinding) and an Origin check on every POST, then the public routes (health,
 * assetlinks, the phone app files, POST /hub/v1/pair), the phone's own routes (device-routes.js) and the /review-queue/v1/* API with the
 * same URL layout and error mapping as server.js (its send / readJson / outcome are reused). Who may call is decided by hub.identify(req)
 * (hub/roles.js): a paired phone (device), this PC (desktop), nobody. A device is held to 120 requests a minute (the snapshot long poll
 * excluded) and can only do the item actions below; revoking it aborts its open long poll.
 */
import { MAX_WAIT_MS, PREFIX, outcome, parseSince, readJson, send, stampOf } from '../server.js'
import { serveMobile } from '../mobile.js'
import { createDeviceRoutes, sendLimited } from './device-routes.js'

export { outcome }
const HEALTH = '/hub/v1/health'
const ASSETLINKS = '/.well-known/assetlinks.json'
const AGENT_PREFIX = '/hub/v1/agent/'
const SHUTDOWN = '/hub/v1/shutdown'
/** The desktop app owns the speakers, the screen and its own selection (D7): never the hub's business. */
const LOCAL_ONLY = new Set(['read', 'stop', 'ui', 'focus'])
/**
 * What a paired phone may do with an item. It may start todos (todo, todo-confirm, todo-cancel: hub/routing.js sends them to the
 * owner app, or for "Choose for me" to the most recently desktop-active one) but never open sessions: open-session, and every action
 * not listed here, stays on the desktop (403 desktop-only).
 */
const DEVICE_ACTIONS = new Set(['reviewed', 'reopen', 'answer', 'late-answer', 'approve', 'approve-similar', 'deny', 'reply', 'archive', 'todo', 'todo-confirm', 'todo-cancel'])

/** @param {{ hub: any, log?: (line: string) => void }} deps */
export function createHttp({ hub, log = () => {} }) {
  /** @type {Map<() => void, string | undefined>} wake function -> the device that waits, so a revoke can end its poll */
  const waiters = new Map()
  let stopping = false

  const hostOk = (req) => {
    const host = String(req.headers.host ?? '').toLowerCase()
    return host === '127.0.0.1:' + hub.port || host === 'localhost:' + hub.port || (!!hub.config.publicHost && host === hub.config.publicHost.toLowerCase())
  }
  const originOk = (req) => {
    const origin = req.headers.origin
    if (origin === undefined) return true
    const allowed = ['http://127.0.0.1:' + hub.port, 'http://localhost:' + hub.port, hub.config.publicOrigin]
    return allowed.some((o) => o && o.toLowerCase() === String(origin).toLowerCase())
  }

  /** The caller, or undefined after the refusal (401 / 403 / 429) was sent. */
  function authorize(req, res, { longPoll = false } = {}) {
    const who = hub.identify(req)
    if (who.error) { send(res, who.error === 'login-not-allowed' ? 403 : 401, { error: who.error }); return undefined }
    if (!who.role) { send(res, 401, { error: 'auth-required' }); return undefined }
    if (who.role === 'device' && who.deviceId && !longPoll) {
      const taken = hub.deviceLimiter.take(who.deviceId)
      if (!taken.ok) { sendLimited(res, taken.retryAfterMs); return undefined }
    }
    return who
  }
  const deviceRoutes = createDeviceRoutes({ hub, originOk, authorize })

  async function snapshot(req, res, url, who) {
    const since = parseSince(url.searchParams.get('since') ?? undefined)
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), MAX_WAIT_MS)
    const current = () => stampOf({ snapshotId: hub.snapshotId() })
    const unchanged = () => send(res, 200, { unchanged: true, snapshotId: hub.snapshotId() })
    // The desktop overlay says whether anybody is looking (visible=1): the notifier holds a push while that is so.
    const looking = who.role === 'desktop' && url.searchParams.get('visible') === '1'
    if (looking) hub.notePresence()
    if (since === undefined || current() !== since) return send(res, 200, hub.snapshot())
    if (wait === 0) return unchanged()
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); off(); waiters.delete(done); req.off('close', done); resolve() }
      const timer = setTimeout(done, wait)
      const off = hub.onChange(done)
      waiters.set(done, who.deviceId)
      req.once('close', done)
    })
    if (looking) hub.notePresence()
    if (stopping) return send(res, 503, { error: 'shutting-down' })
    if (who.deviceId && !hub.devices.isActive(who.deviceId)) return send(res, 401, { error: 'auth-required' }) // revoked while it waited
    return current() === since ? unchanged() : send(res, 200, hub.snapshot())
  }

  async function api(req, res, url, path) {
    const who = authorize(req, res, { longPoll: path === '/v1/snapshot' && Number(url.searchParams.get('wait')) > 0 })
    if (!who) return undefined
    const caller = typeof req.headers['x-rq-instance'] === 'string' ? req.headers['x-rq-instance'] : undefined
    if (path === '/v1/snapshot' || path === '/v1/workspaces') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method' })
      return path === '/v1/snapshot' ? await snapshot(req, res, url, who) : send(res, 200, { workspaces: hub.workspaces({ caller }) })
    }
    if (path.startsWith('/v1/push/')) {
      if (req.method === 'POST' && !originOk(req)) return send(res, 403, { error: 'bad-origin' })
      return await hub.pushRoutes(req, res, path, { readJson, send }, who)
    }
    const kind = path.slice('/v1/'.length)
    if (LOCAL_ONLY.has(kind)) return send(res, 403, { ok: false, error: 'local-only' })
    if (!hub.actionKinds.includes(kind)) return send(res, 404, { error: 'unknown-action' })
    if (who.role === 'device' && !DEVICE_ACTIONS.has(kind)) return send(res, 403, { error: 'desktop-only' })
    if (req.method !== 'POST') return send(res, 405, { error: 'method' })
    if (!originOk(req)) return send(res, 403, { error: 'bad-origin' })
    const body = await readJson(req)
    if (!body.value) return send(res, body.status, { error: 'bad-request' })
    return outcome(res, await hub.act(kind, body.value, { role: who.role, caller }))
  }

  function assetlinks(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' })
    const body = JSON.stringify(hub.assetLinks())
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://local')
      const path = url.pathname
      if (!hostOk(req)) return send(res, 403, { error: 'bad-host' })
      if (stopping) return send(res, 503, { error: 'shutting-down' })
      if (path === HEALTH) {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' })
        return send(res, 200, { ok: true, service: 'dsh-review-queue-hub', hubId: hub.hubId, protocol: hub.protocol, version: hub.version })
      }
      hub.touch()
      if (path.startsWith(AGENT_PREFIX)) return await hub.agentApi.handle(req, res, url, path, { originOk })
      if (path === SHUTDOWN) return await hub.agentApi.shutdown(req, res, { originOk, onShutdown: hub.onShutdown })
      if (path === ASSETLINKS) return assetlinks(req, res)
      if (path.startsWith('/hub/v1/') && (await deviceRoutes(req, res, path))) return
      if (path === PREFIX + '/m' || path.startsWith(PREFIX + '/m/')) { if (await serveMobile(req, res, path.slice(PREFIX.length))) return }
      if (path.startsWith(PREFIX + '/v1/')) return await api(req, res, url, path.slice(PREFIX.length))
      return send(res, 404, { error: 'not-found' })
    } catch (error) {
      log('request failed: ' + String(error?.code ?? error?.name ?? 'error'))
      send(res, 500, { error: 'internal' })
    }
  }

  return {
    handler,
    /** Answer every waiting long poll with 503 shutting-down and refuse new requests. */
    shutdown() { stopping = true; for (const wake of [...waiters.keys()]) wake() },
    /** A device was revoked: its waiting snapshot poll ends now (and answers 401). */
    abortDevice(deviceId) { for (const [wake, id] of [...waiters]) if (id === deviceId) wake() },
  }
}
