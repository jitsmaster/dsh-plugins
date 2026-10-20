/**
 * dsh-review-queue — host half. Collects what is waiting on the user across every session (finished work, open
 * questions, permission requests) into one queue and serves it to the browser half (lib/client.js: a sidebar tab and
 * a full-screen overlay) under /review-queue on the Host web server.
 *
 * The hub (docs/hub.md): by default each app is an agent of one shared hub process (agent/wire.js) so every app and the phone see
 * one list; `hub: false` or env DSH_RQ_HUB=0 keeps the plugin standalone exactly as it was. Config: `hubPort` (env DSH_RQ_HUB_PORT, default
 * 47615), `hubNode` (the node executable that runs the hub), `instanceLabel` (how this app is named, default "DSH :<port>").
 *
 * Paused sessions (paused.js): at startup and again after the quiet time the plugin scans ~/.dsh/sessions for sessions a restart cut off and lists
 * them (type 'paused'); `paused: false` or env DSH_RQ_PAUSED=0 turns it off, and it is off in node --test runs unless `pausedScan` (a replacement
 * for the scan, called with { root, startedAt, liveIds, skipIds }) is given. `pausedStartMs` (default 5000) and `pausedRescanMs`
 * (default the quiet time plus 15 s, 0 = never) time the two scans.
 *
 * `taskbarBadge` (default on, Windows only; env DSH_RQ_TASKBAR=0 turns it off): the number of waiting items as a badge on the app's taskbar button (taskbar.js).
 *
 * Config (all optional): `sparcCommandPath` (the modes:sparc command file a "Use SPARC" todo inlines, default ~/.claude/commands/modes/sparc.md), `stateDir` (where queue.json lives), `ttsClient` (path of dsh-hooks-tts's tts-client.ps1, default the
 * sibling plugin folder), `voice` ('male' default, or 'female') for the play button, `dev` (true, or env DSH_REVIEW_QUEUE_DEV=1, enables the
 * /v1/dev/ask route that creates fake questions, permissions and completions for testing the UI), `pushSubject` (the mailto: or https: contact
 * the push services see in the VAPID token) and `sendPush` (replaces the real Web Push delivery, for tests).
 */
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { awaitPort, hubEnabled, instanceKeyOf, instanceLabelOf } from './agent/config.js'
import { hubPortOf } from './agent/launcher.js'
import { createStoreAdapter } from './agent/store-adapter.js'
import { wireHub } from './agent/wire.js'
import { createStore } from './store.js'
import { createSummarizer } from './summary.js'
import { createTuner } from './todo-tune.js'
import { installCapture, cancelStalePending } from './capture.js'
import { installTicketSessions } from './ticket-session.js'
import { createReviewQueue } from './service.js'
import { createReader } from './reader.js'
import { listWorkspaces } from './todo.js'
import { createRouter, PREFIX } from './server.js'
import { createPushStore, loadOrCreateVapid, jsonFileIo } from './hub/push.js'
import { createPushRoutes } from './hub/push-routes.js'
import { createFileLog } from './filelog.js'
import { STALE_MS, createDismissals, createPausedTracker, scanSessionLogs } from './paused.js'
import { readThread } from './thread.js'
import { createTaskbarBadge } from './taskbar.js'
import { createDesktop } from './desktop.js'
import { createPauseRecord, logMtimeOf, mergeCandidates, pausedByUserCandidates, pauseRunningSessions } from './userpause.js'

export const name = 'review-queue'

const HERE = dirname(fileURLToPath(import.meta.url))
const safe = (fn) => { try { return fn() } catch { return undefined } }

/** Atomic-ish JSON file: write a temp file, then rename over the target. */
function fileIo(file) {
  return {
    read: () => { try { return readFileSync(file, 'utf8') } catch { return undefined } },
    write: (text) => { const tmp = file + '.tmp'; writeFileSync(tmp, text); renameSync(tmp, file) },
  }
}

/**
 * Builds every piece of the plugin and returns { queue, local, store, agent, proxy }: queue is what other plugins get as reviewQueue (the hub
 * queue, or the local service when the hub is off), agent the hub connection (undefined when the hub is off); apply() is the DSH entry.
 * config.ui: a { seq, cmd } show/hide state of its own (several apps in one process, tests); config.hubDeps: { launcher, agent, retryMs } overrides for tests.
 */
export function createReviewQueuePlugin(ctx, config = {}) {
  let stateDir
  try {
    stateDir = resolve(config.stateDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'review-queue'))
    mkdirSync(stateDir, { recursive: true })
  } catch (error) { ctx.logger?.warn?.('review-queue: state directory unusable (' + String(error) + '); the queue is not persisted'); stateDir = undefined }

  // The web port names this app at the hub. It is read here when the host already has it; otherwise the agent waits for it a moment before it
  // registers (the host may run this callback, or bind the port, after the plugin was applied). The route is registered in the same step and answers once the pieces below exist.
  let webPort
  let handle = (req, res) => { res.statusCode = 503; res.end() }
  // Same pattern as dsh-git-view: ride the Host web server so the browser, Desktop and remote access all reach it, behind
  // the Host's own Host/Origin fence and cookie authentication.
  try {
    ctx.inject(['connection', 'webServer'], (webCtx) => {
      webPort = Number(webCtx.webServer?.port) || undefined
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => {
          const admission = webCtx.connection.admit(req)
          if ('rejection' in admission) { res.statusCode = admission.rejection; res.end(); return }
          req.url = (req.url ?? '/').slice(PREFIX.length) || '/'
          handle(req, res)
        },
      }), 'review-queue: routes')
    })
  } catch (error) { ctx.logger?.warn?.('review-queue: routes not registered: ' + String(error)) }

  // Every log line also goes to review-queue.log next to queue.json (size capped), so a silent failure can be traced later.
  const fileLog = stateDir ? createFileLog(join(stateDir, 'review-queue.log')) : undefined
  const log = (line) => { ctx.logger?.info?.('review-queue: ' + line); fileLog?.('review-queue: ' + line) }
  const useHub = hubEnabled(config) && stateDir !== undefined
  const instanceId = randomBytes(8).toString('hex')
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const servicePort = () => { try { return Number(ctx.get?.('webServer')?.port) || undefined } catch { return undefined } }
  const portNow = () => webPort ?? servicePort()
  const instanceKey = instanceKeyOf({ dshHome, port: portNow() }) // names the local file; a pid key when the port is not known yet
  let store
  if (useHub) {
    // Own items live in local/<instanceKey>.json (also the outbox for the hub); the hub imports the old shared queue.json itself.
    mkdirSync(join(stateDir, 'local'), { recursive: true })
    store = createStoreAdapter({ instanceId, io: fileIo(join(stateDir, 'local', instanceKey + '.json')) })
    log('hub on')
  } else {
    store = createStore({ io: stateDir ? fileIo(join(stateDir, 'queue.json')) : undefined })
    cancelStalePending(store, { log }) // with the hub on, the hub settles the dead requests of an earlier run (agent/wire.js)
  }
  store.prune()

  const llmService = () => { try { return ctx.get?.('llm') ?? ctx.llm } catch { return undefined } }
  const llm = { listProviders: () => llmService().listProviders(), listModels: (p) => llmService().listModels(p), prepareCall: (...a) => llmService().prepareCall(...a) }
  const summarizer = createSummarizer({ llm, log })
  // The new-todo form's Tune prompt button: the same llm service, rules from config.promptTunePath (default: the prompt-tune skill file, else an embedded copy).
  const tuner = createTuner({ llm, rulesPath: config.promptTunePath, log })
  // Question auto-answer: questionAutoAnswer (default on), questionAutoAnswerLeadSeconds (0 = off) and questionWindowSeconds (the window of a question
  // the model gave no timeout: must match the ask_user_question timeout row). A value that is not a finite number in range is passed on as undefined: capture.js applies its defaults.
  const msOf = (seconds, zeroOk) => (Number.isFinite(seconds) && (seconds > 0 || (zeroOk && seconds === 0)) ? seconds * 1000 : undefined)
  const capture = installCapture(ctx, {
    store, summarizer, log, autoAnswer: config.questionAutoAnswer !== false,
    autoAnswerLeadMs: msOf(config.questionAutoAnswerLeadSeconds, true), defaultWindowMs: msOf(config.questionWindowSeconds, false),
    keepDone: config.doneKeepPerSession, // capture.js falls back to its default (20) for anything that is not a positive integer
  })
  const controllerOf = () => { try { return ctx.get?.('sessionController') ?? ctx.sessionController } catch { return undefined } }
  // A prompt typed into a session that mentions an Azure DevOps ticket renames the session "Fix: <ticket title> - <number>" (off with ticketSessionTitles: false).
  installTicketSessions(ctx, { controllerOf, log, enabled: () => config.ticketSessionTitles !== false })
  // The play button speaks through the sibling dsh-hooks-tts plugin's TTS client (same server, mute switch and stop hotkey).
  const reader = createReader({
    spawn,
    script: join(HERE, 'scripts', 'read-aloud.ps1'),
    clientScript: resolve(config.ttsClient ?? join(HERE, '..', 'dsh-hooks-tts', 'scripts', 'tts-client.ps1')),
    powershell: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    stateDir: process.env.DSH_TTS_STATE_DIR || join(process.env.TEMP || tmpdir(), 'dsh-tts'),
    gender: config.voice === 'female' ? 'female' : 'male',
    log,
  })
  const identify = async () => {
    const waitMs = config.hubDeps?.portWaitMs
    const port = await awaitPort(portNow, waitMs === undefined ? {} : { timeoutMs: waitMs })
    log('instance key from ' + (port ? 'the web port ' + port : 'the pid (no web port; items are adopted by session)'))
    return { key: port ? instanceKeyOf({ dshHome, port }) : instanceKey, label: instanceLabelOf(config, port) }
  }
  const agentsOf = () => { try { return ctx.get?.('agents') ?? ctx.agents } catch { return undefined } }
  const registryOf = () => { try { return ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry } catch { return undefined } }
  // Todo: recent session titles help the model pick a workspace (best effort), and a SPARC todo inlines the modes:sparc text like dsh-hooks-tts does.
  const titlesOf = async (ids) => {
    const titles = new Map()
    try {
      const query = ctx.get?.('sessionQuery')
      if (!ids.length || typeof query?.readTitleSnapshots !== 'function') return titles
      const results = await query.readTitleSnapshots(ids)
      results.forEach((r, i) => { if (r?.status === 'fulfilled' && typeof r.value?.title?.title === 'string') titles.set(ids[i], r.value.title.title) })
    } catch { /* titles are a bonus */ }
    return titles
  }
  const sparcText = () => {
    try { return readFileSync(resolve(config.sparcCommandPath ?? join(homedir(), '.claude', 'commands', 'modes', 'sparc.md')), 'utf8').replace(/^---[\s\S]*?\n---\s*/, '') } catch { return '' }
  }
  // Every session this app can reach: live agents, the sessions of the workspaces, the ones capture has seen. The hub gives the app the unowned items of these.
  const reachableSessionIds = () => {
    const ids = new Set(capture.seenSessionIds())
    try { for (const agent of agentsOf()?.list?.() ?? []) if (typeof agent?.id === 'string') ids.add(agent.id) } catch { /* the live agents are a bonus */ }
    for (const workspace of listWorkspaces(registryOf) ?? []) for (const id of workspace.sessionIds) ids.add(id)
    return [...ids]
  }
  const speaker = config.speaker ?? reader
  // Paused sessions: what a restart cut off, from the session logs. A session this app has seen or has loaded is live; an archived one is skipped.
  const startedAt = Date.now()
  const pausedWanted = typeof config.pausedScan === 'function' || config.paused === true
    || (config.paused !== false && process.env.DSH_RQ_PAUSED !== '0' && process.env.NODE_TEST_CONTEXT === undefined)
  const archivedIds = () => new Set((safe(() => registryOf()?.archivedSessionIds) ?? []).map(String))
  const liveSessionIds = () => new Set([...capture.seenSessionIds(), ...(safe(() => agentsOf()?.list?.()) ?? []).map((a) => a?.id).filter((id) => typeof id === 'string')])
  // Pause all remembers the sessions it paused (userpause.js) and the scan lists them as paused until they run again.
  const pauseRecord = createPauseRecord({ io: stateDir ? fileIo(join(stateDir, 'paused-by-user.json')) : undefined })
  const sessionsRoot = join(dshHome, 'sessions')
  const pausedScan = async () => {
    const result = await (config.pausedScan ?? scanSessionLogs)({ root: sessionsRoot, startedAt, liveIds: liveSessionIds(), skipIds: archivedIds() })
    if (!pauseRecord.size) return result
    return mergeCandidates(result, await pausedByUserCandidates({ record: pauseRecord, logMtime: (id) => logMtimeOf(sessionsRoot, id), skipIds: archivedIds() }))
  }
  const paused = pausedWanted
    ? createPausedTracker({
      store, scan: pausedScan, log,
      dismissals: createDismissals({ io: stateDir ? fileIo(join(stateDir, 'paused-dismissed.json')) : undefined }),
    })
    : undefined
  // The chat view of the phone reads the thread of a session from the same folder.
  const threadOf = (opts) => readThread({ root: join(dshHome, 'sessions'), log, ...opts })
  const desktop = config.desktop ?? createDesktop({
    spawn, script: join(HERE, 'scripts', 'desktop-quit.ps1'), log,
    powershell: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  })
  const power = {
    canQuit: () => desktop.canQuit(), quitSoon: () => desktop.quitSoon(),
    pauseSessions: () => pauseRunningSessions({ controller: controllerOf(), record: pauseRecord, titlesOf, log }),
  }
  const queue = createReviewQueue({ store, capture, controllerOf, instanceId, registryOf, speaker, llm, tuner, titlesOf, sparcText, log, paused, threadOf, power, ...(config.ui ? { ui: config.ui } : {}) })
  const pausedTimers = []
  if (paused) {
    const later = (ms) => { const t = setTimeout(() => { void paused.scan() }, ms); t.unref?.(); pausedTimers.push(t) }
    later(config.pausedStartMs ?? 5000)
    const again = config.pausedRescanMs ?? STALE_MS + 15_000
    if (again > 0) later((config.pausedStartMs ?? 5000) + again)
  }

  const pruneTimer = setInterval(() => store.prune(), 3600_000)
  pruneTimer.unref?.()
  let wiring
  ctx.effect?.(() => async () => { clearInterval(pruneTimer); pausedTimers.forEach(clearTimeout); capture.dispose(); reader.stop(); await taskbar?.dispose(); await wiring?.dispose() }, 'review-queue: stop')

  // Dev route: drive the real handlers with a fake agent so the whole path (item, card answer, expiry) can be tried
  // without a model. Off unless asked for.
  let dev
  if (config.dev === true || process.env.DSH_REVIEW_QUEUE_DEV === '1') {
    let n = 0
    const never = () => new Promise(() => {})
    dev = {
      async ask(body) {
        const agent = { id: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : 'dev-' + ++n, devTitle: String(body.title ?? 'Dev session'), session: { header: { cwd: 'D:/dev' }, deriveMessages: () => [{ role: 'assistant', content: String(body.reply ?? 'Done.') }] } }
        if (body.kind === 'question') {
          const ac = new AbortController()
          const seconds = Number.isInteger(body.timeoutSec) ? body.timeoutSec : 0
          const callId = 'dev-call-' + n
          if (seconds > 0) {
            await capture.handlers['tools/pre-execute']({ name: 'ask_user_question', callId, arguments: { timeout: seconds }, agent }, async () => ({}))
            setTimeout(() => ac.abort(Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' })), seconds * 1000).unref?.()
          }
          void capture.handlers['user-questions/request']({ agent, questions: body.questions, signal: ac.signal, wait: { callId, timed: seconds > 0 } }, never).catch(() => {})
        } else if (body.kind === 'permission') {
          const callId = 'dev-perm-' + n
          await capture.handlers['tools/pre-execute']({ name: String(body.toolName ?? 'shell'), callId, arguments: { command: String(body.command ?? 'echo hi') }, agent }, async () => ({}))
          void capture.handlers['approval/request']({ agent, toolName: String(body.toolName ?? 'shell'), callId }, never).catch(() => {})
        } else {
          await capture.handlers['agent/turn-stopping']({ agent })
        }
        return { ok: true }
      },
    }
  }
  // Phone notifications. Standalone (hub off): the VAPID key pair and the registered devices live next to queue.json (private files); delivery is injectable.
  // With the hub on they belong to the hub (hub/hub.js: key pair, subscriptions per paired device, notifier), so this app keeps none and has no push routes.
  let pushRoutes
  if (!useHub) {
    const vapid = loadOrCreateVapid({ io: stateDir ? jsonFileIo(join(stateDir, 'vapid.json'), { mode: 0o600 }) : undefined, subject: config.pushSubject })
    const push = createPushStore({ io: stateDir ? jsonFileIo(join(stateDir, 'push.json'), { mode: 0o600 }) : undefined, vapid, ...(typeof config.sendPush === 'function' ? { sendPush: config.sendPush } : {}) })
    pushRoutes = createPushRoutes({ push, publicKey: vapid.publicKey })
  }
  const makeServe = (served) => createRouter({ queue: served, dev, pushRoutes })

  // Hub mode: reads and actions go through the hub, the instance routes through the proxy; the local service stays alive underneath.
  let provided = queue
  if (useHub) {
    wiring = wireHub({
      stateDir, port: hubPortOf({ hubPort: config.hubPort }), hubNode: config.hubNode, instanceKey, instanceId, label: instanceLabelOf(config, webPort), adapter: store, local: queue, makeServe, speaker,
      controllerOf, workspaces: () => listWorkspaces(registryOf) ?? [], sessionIds: reachableSessionIds, identify, log, deps: config.hubDeps,
    })
    provided = wiring.hubQueue
    handle = (req, res) => wiring.proxy.handle(req, res)
    wiring.start()
  } else handle = makeServe(queue)

  // The waiting count as a badge on the taskbar button. Off in node --test runs (they set NODE_TEST_CONTEXT) unless a test asks with taskbarBadge: true.
  const badgeWanted = config.taskbarBadge === true || (config.taskbarBadge !== false && process.env.DSH_RQ_TASKBAR !== '0' && process.env.NODE_TEST_CONTEXT === undefined)
  const taskbar = badgeWanted
    ? createTaskbarBadge({
      queue: provided, spawn: config.badgeDeps?.spawn ?? spawn, script: join(HERE, 'scripts', 'taskbar-badge.ps1'), pid: process.pid, log,
      powershell: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ...(config.badgeDeps ?? {}),
    })
    : undefined

  // Other plugins (voice) reach the queue through the context.
  try { ctx.provide?.('reviewQueue', provided) } catch { /* optional */ }
  return { queue: provided, local: queue, agent: wiring?.client, proxy: wiring?.proxy, store }
}

export function apply(ctx, config = {}) {
  return createReviewQueuePlugin(ctx, config).queue
}
