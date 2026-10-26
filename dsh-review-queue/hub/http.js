/**
 * The hub's HTTP surface: a Host allow-list (DNS rebinding) and an Origin check on every POST, then the public routes (health,
 * assetlinks, the phone app files, POST /hub/v1/pair), the phone's own routes (device-routes.js) and the /review-queue/v1/* API with the
 * same URL layout and error mapping as server.js (its send / readJson / outcome are reused). Who may call is decided by hub.identify(req)
 * (hub/roles.js): a paired phone (device), this PC (desktop), nobody. A device is held to 120 requests a minute (the snapshot long poll
 * excluded) and can only do the item actions below; revoking it aborts its open long poll.
 */
import { CONFIRM_BAD_INPUT, MAX_WAIT_MS, PREFIX, outcome, parseSince, readJson, send, stampMatches } from '../server.js'
import { serveMobile } from '../mobile.js'
import { createDeviceRoutes, sendLimited } from './device-routes.js'

export { outcome }
const HEALTH = '/hub/v1/health'
const ASSETLINKS = '/.well-known/assetlinks.json'
const AGENT_PREFIX = '/hub/v1/agent/'
const SHUTDOWN = '/hub/v1/shutdown'
/** The desktop app owns the speakers, the screen and its own selection (D7): never the hub's business. */
const LOCAL_ONLY = new Set(['read', 'read-tip', 'tip-next', 'tip-current', 'tip-peek', 'tip-deeper', 'tip-todo', 'stop', 'ui', 'focus'])
/**
 * What a paired phone may do with an item. It may start todos (todo, todo-confirm, todo-cancel: hub/routing.js sends them to the
 * owner app, or for "Choose for me" to the most recently desktop-active one) but never open sessions: open-session, and every action
 * not listed here, stays on the desktop (403 desktop-only). It may dismiss a paused session (paused-dismiss: it needs no action) but not resume one. thread and post are the chat view of a session (docs/mobile.md "Chat thread").
 */
const DEVICE_ACTIONS = new Set(['reviewed', 'reopen', 'answer', 'late-answer', 'approve', 'approve-similar', 'deny', 'reply', 'archive', 'archive-session', 'paused-dismiss', 'hold', 'hold-release', 'hold-continue', 'todo', 'todo-confirm', 'todo-cancel', 'thread', 'post'])

/** Client input in a log line: only safe characters, cut short (a line cannot be forged or flooded). Not a string: '?'. */
const safeId = (value, max) => (typeof value === 'string' ? value.replace(/[^A-Za-z0-9_-]/g, '?').slice(0, max) : '?')

/** The audit line of a phone's post (docs/hub.md 6.8): the device, the item and the length of the text. The text itself is never logged; the item id is client input, so it is cut to safe characters. */
const postAudit = (deviceId, body) => 'post: device ' + deviceId + ' item ' + safeId(body.id, 40) + ' chars ' + (typeof body.text === 'string' ? body.text.length : 0)

/**
 * The audit lines of a phone that sends a message into an EXISTING session through a follow-up todo (docs/hub.md 6.8), like a post: the device, the item (a confirm),
 * the target session and the length of the text; never the text or the words. undefined for anything that is not a follow-up (the caller is a device and the body is checked here).
 */
function followUpAudit(deviceId, kind, body, store) {
  if (kind === 'todo' && body.followUp !== undefined && body.followUp !== null) return 'followup-add: device ' + deviceId + ' chars ' + (typeof body.text === 'string' ? body.text.trim().length : 0)
  if (kind !== 'todo-confirm') return undefined
  const item = typeof body.id === 'string' ? store?.get(body.id) : undefined
  if (item?.type !== 'todo' || item.kind !== 'followup') return undefined
  const session = body.sessionId === undefined || body.sessionId === null || body.sessionId === '' ? item.suggested?.sessionId : body.sessionId
  return 'followup-confirm: device ' + deviceId + ' item ' + safeId(item.id, 40) + ' session ' + safeId(session, 60) + ' chars ' + (typeof item.text === 'string' ? item.text.length : 0)
}

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
    // The token is judged on the parts the client sent: the snapshot id and, for a client that knows them, the summed session numbers.
    const seen = () => since !== undefined && stampMatches({ snapshotId: hub.snapshotId(), sessions: hub.sessions() }, since)
    const unchanged = () => send(res, 200, { unchanged: true, snapshotId: hub.snapshotId() })
    // The desktop overlay says whether anybody is looking (visible=1): the notifier holds a push while that is so.
    const looking = who.role === 'desktop' && url.searchParams.get('visible') === '1'
    // Somebody looks at the session numbers: a phone, or a desktop overlay that is open (watch=1 from the app's proxy). An agent's own mirror poll is neither.
    if (who.role === 'device' || url.searchParams.get('watch') === '1') hub.noteWatch()
    if (looking) hub.notePresence()
    if (!seen()) return send(res, 200, hub.snapshot())
    if (wait === 0) return unchanged()
    // A wake that changes nothing this client can see (a token without the numbers part meets a change of the numbers only) is not an answer: keep waiting for the rest of the time.
    const deadline = Date.now() + wait
    let gone = false
    req.once('close', () => { gone = true })
    while (!gone && !stopping && seen() && Date.now() < deadline) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); off(); waiters.delete(done); req.off('close', done); resolve() }
        const timer = setTimeout(done, deadline - Date.now())
        const off = hub.onChange(done)
        waiters.set(done, who.deviceId)
        req.once('close', done)
      })
      if (who.deviceId && !hub.devices.isActive(who.deviceId)) break // revoked while it waited
    }
    if (looking) hub.notePresence()
    if (stopping) return send(res, 503, { error: 'shutting-down' })
    if (who.deviceId && !hub.devices.isActive(who.deviceId)) return send(res, 401, { error: 'auth-required' }) // revoked while it waited
    return seen() ? unchanged() : send(res, 200, hub.snapshot())
  }

  async function api(req, res, url, path) {
    const who = authorize(req, res, { longPoll: path === '/v1/snapshot' && Number(url.searchParams.get('wait')) > 0 })
    if (!who) return undefined
    const caller = typeof req.headers['x-rq-instance'] === 'string' ? req.headers['x-rq-instance'] : undefined
    if (path === '/v1/snapshot' || path === '/v1/workspaces') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method' })
      return path === '/v1/snapshot' ? await snapshot(req, res, url, who) : send(res, 200, { workspaces: hub.workspaces({ caller }) })
    }
    if (path === '/v1/model-efforts') { // the efforts of the default model for the New todo form: a phone has no app of its own, so the coordinator app is asked
      if (req.method !== 'GET') return send(res, 405, { error: 'method' })
      return send(res, 200, await hub.modelEfforts(caller))
    }
    if (path === '/v1/follow-up-sessions') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method' })
      // A paired phone may read it too: it already prompts any session (post, follow-up todo), and its Follow up form picks the session in this dropdown.
      return send(res, 200, await hub.followUpSessions(caller))
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
    if (who.deviceId) { // a phone can prompt any session (a post, or a follow-up todo): leave a trace of who, which item and session and how long, never the text
      const line = kind === 'post' ? postAudit(who.deviceId, body.value) : followUpAudit(who.deviceId, kind, body.value, hub.store)
      if (line) log(line)
    }
    return outcome(res, await hub.act(kind, body.value, { role: who.role, caller }), kind === 'todo-confirm' ? CONFIRM_BAD_INPUT : undefined)
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
