/**
 * The instance's /review-queue/v1/* in hub mode (docs/hub.md 5.1, 6.1, 10; D7, D8). Mode 'hub': actions, workspaces and the snapshot go
 * to the hub with the agent secret, X-RQ-Role: desktop and X-RQ-Instance, same paths and JSON as the standalone server.js, so the overlay
 * is unchanged. read / read-tip / stop / ui / focus stay with this instance (the local router), and the hub's snapshot gets this instance's
 * focusId / reading / ui merged in, and, while the merged list is empty, the tip of the day of this instance's service (the hub knows no tip). The
 * numbers part of the long-poll token goes to the hub (it sums the session numbers of every app); the tip part is judged here. Any other mode ('starting', 'standalone', 'degraded') answers from the local service exactly as
 * server.js does, the snapshot carrying a notice; degraded also lists the last known items of the other apps, read-only. The wiring drives
 * setMode (or driveModeFromClient); a request that finds the hub gone is answered locally and reported through onHubUnreachable.
 * The overlay going away aborts the request to the hub. The devices page of the overlay (pairing code, device list, rename, revoke) is forwarded
 * to the hub's /hub/v1/* as the desktop role (the user passed DSH's own login to get here); it needs a working hub.
 */
import { Readable } from 'node:stream'
import { PROTOCOL } from '../hub/protocol.js'
import { MAX_WAIT_MS, PREFIX, outcome, parseSince, readJson, send, stampMatches } from '../server.js'
import { spokenFor } from '../speech.js'

const MODES = ['starting', 'hub', 'standalone', 'degraded']
const LOCAL_ROUTES = new Set(['/v1/read', '/v1/read-tip', '/v1/tip-deeper', '/v1/tip-todo', '/v1/stop', '/v1/ui', '/v1/focus'])
const HUB_ACTIONS = new Set(['/v1/answer', '/v1/late-answer', '/v1/approve', '/v1/deny', '/v1/reviewed', '/v1/archive', '/v1/paused-resume', '/v1/paused-dismiss', '/v1/reply', '/v1/reopen', '/v1/approve-similar', '/v1/todo', '/v1/todo-confirm', '/v1/todo-cancel', '/v1/thread', '/v1/post'])
/** A hub that answers one of these is as good as gone for this request (wrong secret, newer hub, shutting down). */
const GONE_STATUS = new Set([401, 426, 503])
const REFUSED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'])
const DEVICE_ID = '[A-Za-z0-9_-]{1,64}'
const AGAIN = Symbol('again')
const TIMEOUT_MS = 45_000
const WORKSPACE_SYNC_MS = 2_000

/** The devices-page routes of the overlay and the hub path and method each one has; undefined for any other path. */
function deviceRoute(path) {
  if (path === '/v1/pairing-code') return { method: 'POST', hubPath: '/hub/v1/pairing-codes' }
  if (path === '/v1/devices') return { method: 'GET', hubPath: '/hub/v1/devices' }
  const m = new RegExp('^/v1/devices/(' + DEVICE_ID + ')(/revoke)?$').exec(path)
  return m ? { method: m[2] ? 'POST' : 'PATCH', hubPath: '/hub/v1/devices/' + m[1] + (m[2] ?? '') } : undefined
}

const plain = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)

/** The one-line banner of the overlay for a mode (6.6, 10). */
export function noticeFor(mode, reason) {
  if (mode === 'standalone') return { level: 'warn', text: 'Phone sync is off: hub not running (' + (plain(reason) || 'unknown') + '). This app shows only its own items.' }
  if (mode === 'degraded') return { level: 'warn', text: "Phone sync is off: hub unreachable. This app shows only its own items; the other apps' items are read-only." }
  return undefined
}

/**
 * @param {{ queue: { snapshot: () => any, onChange?: (l: () => void) => () => void }, serve: (req: any, res: any) => any,
 *   hubUrl: () => string | undefined, secret: () => string | undefined, instanceId: () => string | undefined,
 *   mirror?: () => any, fetch?: typeof fetch, protocol?: number, timeoutMs?: number, onHubUnreachable?: (reason: string) => void, log?: (line: string) => void,
 *   refreshWorkspaces?: () => Promise<any>, workspaceSyncMs?: number }} deps
 *   queue: the service the local router runs on (own items; in hub mode the mirror view, which holds focus / reading); serve: that router (server.js createRouter);
 *   mirror: the agent's last hub snapshot (for the degraded list); refreshWorkspaces: has the hub updated with this app's current workspaces (waited for at most workspaceSyncMs)
 *   before the hub is asked for the list, so a workspace that was added after the app registered is in it.
 */
export function createProxy({ queue, serve, hubUrl, secret, instanceId, mirror = () => undefined, fetch: doFetch = globalThis.fetch, protocol = PROTOCOL, timeoutMs = TIMEOUT_MS, onHubUnreachable, log = () => {}, refreshWorkspaces, workspaceSyncMs = WORKSPACE_SYNC_MS }) {
  let mode = 'starting'
  let reason
  let modeSeq = 0
  let lastNote = { reason: undefined, at: 0 }
  const modeListeners = new Set()
  const wakers = new Set() // woken by a mode change or a local change
  const wake = () => { for (const w of [...wakers]) { try { w() } catch { /* ignore */ } } }
  const subscribe = (fn, withNumbers = false) => {
    wakers.add(fn)
    const off = queue.onChange?.(fn)
    const offNumbers = withNumbers ? queue.onSessionsChange?.(fn) : undefined // the local numbers only matter where no hub sum is served
    return () => { wakers.delete(fn); off?.(); offNumbers?.() }
  }
  const sleepUntilWoken = (ms, signal) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); off(); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    const off = subscribe(done, true)
    signal.addEventListener('abort', done, { once: true })
  })

  /** The local service's tip (it starts a generation when the slot is over). Never throws. */
  const tipOf = () => { try { return queue.tip?.() } catch { return undefined } }
  let lastFull // { id, empty }: what the last full answer of the hub said about its list, the one live source of "is the merged list empty"
  /**
   * The id of the tip the desktop shows for the hub snapshot with this id, '' for none: only while the hub's list is empty, as its last full answer said. The
   * agent's mirror of the hub list is only a hint before there was such an answer: a lagging mirror can cost one full fetch, never a loop.
   */
  const tipIdFor = (snapshotId) => ((lastFull && lastFull.id === snapshotId ? lastFull.empty : mirror()?.open?.length === 0) ? tipOf()?.id ?? '' : '')
  const localState = () => { const s = queue.snapshot(); return { focusId: s.focusId, reading: s.reading, ui: s.ui } }

  // ---- the hub ----
  async function callHub(method, path, { body, signal, extraMs = 0, hubPath = false } = {}) {
    const base = hubUrl()
    const key = secret()
    if (!base || !key) return { unreachable: 'no hub address' }
    const abort = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; abort.abort() }, timeoutMs + extraMs)
    const onAbort = () => abort.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) abort.abort()
    try {
      const res = await doFetch(base + (hubPath ? '' : PREFIX) + path, {
        method,
        headers: { authorization: 'Bearer ' + key, 'x-rq-role': 'desktop', 'x-rq-instance': String(instanceId() ?? ''), 'x-rq-protocol': String(protocol), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      })
      const text = await res.text()
      if (GONE_STATUS.has(res.status)) return { unreachable: 'hub answered ' + res.status }
      let json
      try { json = JSON.parse(text) } catch { /* not JSON */ }
      return json && typeof json === 'object' ? { status: res.status, json } : { badGateway: true }
    } catch (error) {
      if (signal?.aborted) return { aborted: true }
      const code = String(error?.cause?.code ?? error?.code ?? '')
      if (!timedOut && REFUSED.has(code)) return { unreachable: code }
      return timedOut ? { unknown: true } : { unreachable: code || 'network' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  function noteUnreachable(why) {
    if (why !== lastNote.reason || Date.now() - lastNote.at > 30_000) { lastNote = { reason: why, at: Date.now() }; log('hub not reachable (' + why + ')') }
    try { onHubUnreachable?.(why) } catch { /* the hook must not break the request */ }
  }

  // ---- local answers (every mode but hub, and the fallback of a hub request) ----
  const effective = () => (mode === 'hub' ? 'degraded' : mode)
  const foreignOf = (own) => {
    const snap = effective() === 'degraded' || mode === 'hub' ? mirror() : undefined
    const me = instanceId()
    const mine = new Set([...own.open, ...own.resolved].map((i) => i.id))
    const pick = (list) => (Array.isArray(list) ? list : []).filter((i) => i.owner !== undefined && i.owner !== me && !mine.has(i.id))
    return { snap, open: pick(snap?.open), resolved: pick(snap?.resolved) }
  }
  function fallbackSnapshot(want) {
    const own = queue.snapshot(want)
    const eff = effective()
    if (eff === 'starting') return own
    const foreign = eff === 'degraded' ? foreignOf(own) : { open: [], resolved: [] }
    const gone = (i) => ({ ...i, ownerState: 'gone' })
    const open = [...own.open, ...foreign.open.map((i, n) => { const position = own.open.length + n + 1; return { ...gone(i), position, spoken: spokenFor(i, position) } })]
    return { ...own, snapshotId: own.snapshotId + '~' + modeSeq + (foreign.snap?.snapshotId ? '~' + foreign.snap.snapshotId : ''), open, resolved: [...own.resolved, ...foreign.resolved.map(gone)], notice: noticeFor(eff, reason) }
  }
  const foreignIds = () => { const f = foreignOf(queue.snapshot()); return new Set([...f.open, ...f.resolved].map((i) => i.id)) }
  /** The local router reads the body itself, so a body already read is handed to it again. */
  const replayed = (req, value) => {
    const bytes = Buffer.from(JSON.stringify(value))
    return Object.assign(Readable.from([bytes]), { headers: { ...req.headers, 'content-type': 'application/json', 'content-length': String(bytes.length) }, method: req.method, url: req.url })
  }
  async function localAction(req, res, value) {
    if (value.id !== undefined && (effective() === 'degraded') && foreignIds().has(String(value.id))) return outcome(res, { ok: false, error: 'owner-offline' })
    return serve(replayed(req, value), res)
  }

  async function localRound({ res, since, remaining, closed, want }) {
    const snap = fallbackSnapshot(want)
    if (since === undefined || !stampMatches(snap, since)) return send(res, 200, snap)
    if (remaining <= 0) return send(res, 200, { unchanged: true, snapshotId: snap.snapshotId })
    await sleepUntilWoken(remaining, closed.signal)
    return closed.signal.aborted ? undefined : AGAIN
  }

  async function hubRound({ res, since, remaining, closed, visible, want }) {
    const local = localState()
    const parts = since?.split('|')
    const tipId = want.tip ? tipIdFor(parts?.[0]) : ''
    // A client that knows the tip part (six parts) must have the tip that is current now; an older page is not held to it.
    const sameLocal = parts !== undefined && parts[1] === (local.focusId ?? '') && parts[2] === (local.reading ?? '') && parts[3] === String(local.ui?.seq ?? 0) && (parts.length < 6 || parts[5] === tipId)
    const query = new URLSearchParams()
    if (sameLocal) { query.set('since', parts[0] + '|||0' + (parts.length > 4 ? '|' + parts[4] : '')); query.set('wait', String(remaining)) }
    if (visible) query.set('visible', '1')
    if (want.watch) query.set('watch', '1') // the hub tells the apps that somebody looks at the session numbers
    const abort = new AbortController()
    const off = subscribe(() => abort.abort())
    const onClosed = () => abort.abort()
    closed.signal.addEventListener('abort', onClosed, { once: true })
    let r
    try { r = await callHub('GET', '/v1/snapshot' + (query.size ? '?' + query : ''), { signal: abort.signal, extraMs: remaining }) } finally { off(); closed.signal.removeEventListener('abort', onClosed) }
    if (closed.signal.aborted) return undefined
    if (r.aborted) return AGAIN
    if (r.status !== 200 || (!r.json.unchanged && !Array.isArray(r.json.open))) {
      noteUnreachable(r.unreachable ?? (r.unknown ? 'no answer' : 'status ' + r.status))
      return localRound({ res, since, remaining, closed, want })
    }
    // A list that is not empty hides the tip: its reading ends too (before the local state is read for the answer).
    if (!r.json.unchanged && r.json.open.length) { try { queue.stopTip?.() } catch { /* nothing to stop */ } }
    const now = localState()
    if (r.json.unchanged) {
      const same = now.focusId === local.focusId && now.reading === local.reading && now.ui?.seq === local.ui?.seq && (want.tip ? tipIdFor(parts?.[0]) : '') === tipId
      return same ? send(res, 200, { unchanged: true, snapshotId: r.json.snapshotId }) : AGAIN
    }
    const empty = r.json.open.length === 0
    lastFull = { id: r.json.snapshotId, empty }
    const tip = empty && want.tip ? tipOf() : undefined
    return send(res, 200, { ...r.json, focusId: now.focusId, reading: now.reading, ui: now.ui, ...(tip ? { tip } : {}) })
  }

  async function snapshot(req, res, url) {
    const since = parseSince(url.searchParams.get('since') ?? undefined)
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), MAX_WAIT_MS)
    const visible = url.searchParams.get('visible') === '1'
    // tip=1: the overlay is open, so the tip is wanted; watch: somebody looks at the session numbers (an open overlay, the phone).
    const tip = url.searchParams.get('tip') === '1'
    const want = { tip, watch: tip || url.searchParams.get('client') === 'phone' }
    const closed = new AbortController()
    res.once('close', () => { if (!res.writableFinished) closed.abort() })
    const deadline = Date.now() + wait
    while (!closed.signal.aborted) {
      const remaining = Math.max(0, deadline - Date.now())
      const round = mode === 'hub' ? hubRound : localRound
      if ((await round({ res, since, remaining, closed, visible, want })) !== AGAIN) return
    }
  }

  /** The hub learns this app's current workspaces first; a refresh that fails or is slow must not keep the overlay from its list. */
  async function updateHubWorkspaces() {
    if (!refreshWorkspaces) return
    let timer
    try { await Promise.race([refreshWorkspaces(), new Promise((resolve) => { timer = setTimeout(resolve, workspaceSyncMs) })]) } catch { /* the list is answered from what the hub has */ } finally { clearTimeout(timer) }
  }
  let listed // how many workspaces the hub listed the last time; a change is logged (an empty list is what "I cannot pick a workspace" looks like)
  function noteListed(json) {
    const n = Array.isArray(json?.workspaces) ? json.workspaces.length : undefined
    if (n === undefined || n === listed) return
    listed = n
    log(n === 0 ? 'workspaces: the hub lists none' : 'workspaces: the hub lists ' + n)
  }

  async function workspaces(req, res) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method' })
    if (mode !== 'hub') return serve(req, res)
    await updateHubWorkspaces()
    const r = await callHub('GET', '/v1/workspaces')
    if (r.status !== undefined) { noteListed(r.json); return send(res, r.status, r.json) }
    if (r.badGateway) return send(res, 502, { error: 'bad-gateway' })
    noteUnreachable(r.unreachable ?? 'no answer')
    return serve(req, res)
  }

  /** The sessions of every app for the follow-up form's dropdown: the hub's union; this app's own when the hub cannot answer. */
  async function followUpSessions(req, res) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method' })
    if (mode !== 'hub') return serve(req, res)
    const r = await callHub('GET', '/v1/follow-up-sessions')
    if (r.status !== undefined) return send(res, r.status, r.json)
    if (r.badGateway) return send(res, 502, { error: 'bad-gateway' })
    noteUnreachable(r.unreachable ?? 'no answer')
    return serve(req, res)
  }

  async function devices(req, res, route) {
    if (req.method !== route.method) return send(res, 405, { error: 'method' })
    let body
    if (route.method !== 'GET') {
      const read = await readJson(req)
      if (!read.value) return send(res, read.status, { error: 'bad-request' })
      body = read.value
    }
    if (mode !== 'hub') return send(res, 503, { error: 'hub-unavailable' })
    const r = await callHub(route.method, route.hubPath, { body, hubPath: true })
    if (r.status !== undefined) return send(res, r.status, r.json)
    if (r.badGateway) return send(res, 502, { error: 'bad-gateway' })
    if (r.unknown) return send(res, 504, { error: 'unknown-outcome' })
    noteUnreachable(r.unreachable)
    return send(res, 503, { error: 'hub-unavailable' })
  }

  async function action(req, res, path) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method' })
    const body = await readJson(req)
    if (!body.value) return send(res, body.status, { error: 'bad-request' })
    if (mode !== 'hub') return localAction(req, res, body.value)
    const r = await callHub('POST', path, { body: body.value })
    if (r.status !== undefined) return send(res, r.status, r.json)
    if (r.badGateway) return send(res, 502, { ok: false, error: 'bad-gateway' })
    // delivered or not, nobody knows: the outcome is not repeated locally
    if (r.unknown) return outcome(res, { ok: false, error: 'unknown-outcome' })
    noteUnreachable(r.unreachable)
    return localAction(req, res, body.value)
  }

  return {
    /** The handler for the route the plugin registers; req.url is relative to /review-queue. */
    async handle(req, res) {
      try {
        const url = new URL(req.url ?? '/', 'http://local')
        const path = url.pathname
        if (path === '/v1/snapshot') {
          if (req.method !== 'GET') return send(res, 405, { error: 'method' })
          return await snapshot(req, res, url)
        }
        if (path === '/v1/workspaces') return await workspaces(req, res)
        if (path === '/v1/follow-up-sessions') return await followUpSessions(req, res)
        const device = deviceRoute(path)
        if (device) return await devices(req, res, device)
        if (HUB_ACTIONS.has(path) && !LOCAL_ROUTES.has(path)) return await action(req, res, path)
        return await serve(req, res)
      } catch {
        send(res, 500, { error: 'internal' })
      }
    },
    getMode: () => mode,
    getReason: () => reason,
    /** @returns {boolean} true when the mode or the reason changed. */
    setMode(next, why) {
      if (!MODES.includes(next)) return false
      const text = why === undefined ? undefined : plain(why)
      if (next === mode && text === reason) return false
      mode = next
      reason = text
      modeSeq++
      log('mode: ' + mode + (reason ? ' (' + reason + ')' : ''))
      for (const l of [...modeListeners]) { try { l(mode, reason) } catch { /* one bad listener must not stop the others */ } }
      wake()
      return true
    },
    onModeChange(listener) { modeListeners.add(listener); return () => { modeListeners.delete(listener) } },
  }
}

/**
 * Drives a proxy from the agent client: hub while connected with a ready mirror, degraded when a hub that was there is lost, standalone
 * (with the reason) for a newer hub or a newer window of this app; a client still connecting changes nothing. Returns the unsubscribe.
 */
export function driveModeFromClient(proxy, client) {
  const sync = () => {
    const state = client.state
    if (state === 'connected') {
      if (client.mirror.ready) proxy.setMode('hub')
      else if (proxy.getMode() === 'hub') proxy.setMode('degraded', 'hub connection lost')
    } else if (state === 'upgrade-required') proxy.setMode('standalone', 'hub is newer, restart DSH')
    else if (state === 'superseded') proxy.setMode('standalone', 'a newer window of this app took over')
    else if (state === 'degraded' && proxy.getMode() === 'hub') proxy.setMode('degraded', 'hub connection lost')
  }
  const offState = client.onState?.(sync)
  const offMirror = client.mirror.onChange?.(sync)
  sync()
  return () => { offState?.(); offMirror?.() }
}
