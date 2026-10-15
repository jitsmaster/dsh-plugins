/**
 * The agent's connection to the hub (docs/hub.md 6.1, 10): register with a full sync of the local store, push ops from the outbox
 * (in batches, acknowledged by the hub, a full sync when the hub asks for one), long-poll commands (the poll is also the heartbeat),
 * run them one at a time and report the result after the ops they caused. Any failure degrades the client, which reconnects with a
 * backoff (1 s to 10 s by default) and syncs again; the local store keeps everything meanwhile. States: stopped, connecting,
 * connected, degraded, upgrade-required (the hub is newer), superseded (a newer instance of this app replaced this one).
 * Sessions: every full sync lists the sessions this app can reach (sessionIds(): live agents, workspaces, captured), so the hub can hand it
 * the items of those sessions that nobody owns (adoptedItems in the answer); a check every sessionCheckMs sends a full sync when that list
 * changed, and at least every resyncEveryMs, because a sync is also when the hub looks for items to hand over.
 */
import { randomBytes } from 'node:crypto'
import { PROTOCOL } from '../hub/protocol.js'
import { createMirror } from './mirror.js'
import { createTransport } from './transport.js'

const AGENT = '/hub/v1/agent/'
const BATCH = 100
const SEEN_CIDS = 500
const CALL_TIMEOUT_MS = 45_000
const SESSION_CHECK_MS = 15_000
const RESYNC_EVERY_MS = 60_000
const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

/**
 * @param {{ baseUrl: string, secret: string, instanceKey: string, adapter: any, executor: any, instanceId?: string, label?: string, pluginVersion?: string, pid?: number,
 *   protocol?: number, workspaces?: () => any[], sessionIds?: () => string[], sessionCheckMs?: number, resyncEveryMs?: number, fetch?: typeof fetch, backoff?: { minMs: number, maxMs: number }, waitMs?: number, log?: (line: string) => void }} opts
 */
export function createAgentClient({ baseUrl, secret, instanceKey, adapter, executor, instanceId = randomBytes(8).toString('hex'), label, pluginVersion, pid = process.pid, protocol = PROTOCOL, workspaces = () => [], sessionIds = () => [], sessionCheckMs = SESSION_CHECK_MS, resyncEveryMs = RESYNC_EVERY_MS, fetch, backoff = { minMs: 1000, maxMs: 10_000 }, waitMs = 25_000, log = () => {} }) {
  const transport = createTransport({ baseUrl, secret, protocol, instanceId, fetch })
  const mirror = createMirror({ transport, waitMs, backoff, log })
  const stateListeners = new Set()
  const seen = new Set() // cids already accepted
  const pending = []
  let state = 'stopped'
  let running = false
  let connecting = false
  let ctl = new AbortController()
  let after = 0
  let flushing
  let again = false
  let draining = false
  let offOp = () => {}
  let sessionTimer
  let wantSync = false
  let reported = { key: '', at: 0, workspaces: '' }

  const setState = (next) => {
    if (state === next) return
    state = next
    for (const l of [...stateListeners]) { try { l(next) } catch { /* ignore */ } }
  }
  const newCycle = () => { ctl.abort(); ctl = new AbortController(); return ctl.signal }
  const ownWorkspaces = () => { try { const list = workspaces(); return Array.isArray(list) ? list : [] } catch { return [] } }
  const ownSessionIds = () => { try { const list = sessionIds(); return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s) : [] } catch { return [] } }
  const sessionKey = () => [...new Set([...adapter.syncPayload({ maxResolved: 0 }).sessionIds, ...ownSessionIds()])].sort().join('\n')
  /** What the hub shows of the workspaces (id, title, folder): a change of any of them is worth a sync. */
  const workspaceKey = () => JSON.stringify(ownWorkspaces().map((w) => [w.id, w.title, w.path]))
  function syncBody() {
    const base = adapter.syncPayload()
    const all = [...new Set([...base.sessionIds, ...ownSessionIds()])]
    const own = ownWorkspaces()
    const key = workspaceKey()
    if (key !== reported.workspaces) log('workspaces reported: ' + own.length)
    reported = { key: [...all].sort().join('\n'), at: Date.now(), workspaces: key }
    return { ...base, sessionIds: all, workspaces: own }
  }
  /** Sends a full sync through the same loop as the ops (so none is in flight meanwhile) when the sessions or workspaces changed or the heartbeat is due. */
  function checkSessions() {
    if (state !== 'connected') return
    if (sessionKey() === reported.key && workspaceKey() === reported.workspaces && Date.now() - reported.at < resyncEveryMs) return
    wantSync = true
    void flush()
  }
  const agent = (name, body, signal) => transport.request('POST', AGENT + name, { body: { instanceId, ...body }, signal })

  function fatal(next) {
    newCycle()
    mirror.stop()
    pending.length = 0
    connecting = false
    log('hub connection ended: ' + next)
    setState(next)
  }
  function degrade(reason) {
    if (!running || connecting || state === 'upgrade-required' || state === 'superseded') return
    log('hub connection lost (' + reason + ')')
    setState('degraded')
    mirror.stop()
    pending.length = 0
    void connect()
  }

  /** What the hub knows better: items resolved elsewhere, items that live with another instance. */
  function applyHubView(answer) {
    for (const id of answer.foreign ?? []) adapter.applyRemote({ op: 'drop', id })
    for (const item of answer.adoptedItems ?? []) { if (item && typeof item.id === 'string') adapter.adopt(item) }
    for (const { id, resolution } of answer.resolved ?? []) adapter.applyRemote({ op: 'resolve', id, resolution })
  }

  // ---- connect: register with a sync, then start the loops ----
  async function register(signal) {
    const sync = syncBody()
    let r
    try { r = await agent('register', { instanceKey, label, pid, pluginVersion, sync }, signal) } catch { return 'retry' }
    if (r.status === 426) return 'upgrade-required'
    if (r.status === 409 && r.json?.error === 'superseded') return 'superseded'
    if (r.status !== 200 || !r.json?.ok) return 'retry'
    adapter.synced(sync.n)
    applyHubView(r.json)
    return 'ok'
  }
  async function connect() {
    if (connecting) return
    connecting = true
    const signal = newCycle()
    let wait = backoff.minMs
    while (running && !signal.aborted) {
      const outcome = await register(signal)
      if (signal.aborted) break
      if (outcome === 'upgrade-required' || outcome === 'superseded') return fatal(outcome)
      if (outcome === 'ok') {
        connecting = false
        after = 0
        setState('connected')
        mirror.start()
        void pollLoop(signal)
        void flush()
        return
      }
      setState('degraded')
      await sleep(wait, signal)
      wait = Math.min(wait * 2, backoff.maxMs)
    }
    connecting = false
  }

  // ---- ops ----
  async function resync() {
    const sync = syncBody()
    let r
    try { r = await agent('sync', { sync }, ctl.signal) } catch { degrade('sync'); return false }
    if (r.status !== 200) { degrade('sync ' + r.status); return false }
    adapter.synced(sync.n)
    applyHubView(r.json)
    return true
  }
  async function flushOnce() {
    for (;;) {
      if (state !== 'connected') return
      if (adapter.needsResync || wantSync) { wantSync = false; if (!(await resync())) return; continue }
      const batch = adapter.outbox().slice(0, BATCH)
      if (!batch.length) return
      let r
      try { r = await agent('ops', { ops: batch }, ctl.signal) } catch { return degrade('ops') }
      const error = r.json?.error
      if (r.status === 426) return fatal('upgrade-required')
      if (r.status === 200 || (r.status === 409 && error === 'id-conflict')) { adapter.ack(r.json.ack); if (error) log('an op was refused: ' + error) }
      else if (r.status === 409 && error === 'resync-needed') { if (!(await resync())) return }
      else return degrade(error ?? 'ops ' + r.status)
      if (adapter.outbox()[0]?.n === batch[0].n) return degrade('no progress')
    }
  }
  function flush() {
    if (state !== 'connected') return Promise.resolve()
    if (flushing) { again = true; return flushing }
    flushing = (async () => { do { again = false; await flushOnce() } while (again && state === 'connected') })().finally(() => {
      flushing = undefined
      if (state === 'connected' && adapter.outbox().length && !adapter.needsResync) void flush()
    })
    return flushing
  }

  // ---- commands ----
  async function pollLoop(signal) {
    while (!signal.aborted) {
      let r
      try { r = await transport.request('GET', AGENT + 'commands?' + new URLSearchParams({ instanceId, after: String(after), wait: String(waitMs) }), { waitMs, signal }) } catch { if (signal.aborted) return; return degrade('poll') }
      if (signal.aborted) return
      if (r.status === 426) return fatal('upgrade-required')
      if (r.status !== 200) return degrade('poll ' + r.status)
      for (const cmd of r.json.commands ?? []) accept(cmd)
    }
  }
  function accept(cmd) {
    after = Math.max(after, cmd.seq)
    if (seen.has(cmd.cid)) return
    seen.add(cmd.cid)
    if (seen.size > SEEN_CIDS) seen.delete(seen.values().next().value)
    pending.push(cmd)
    void drain()
  }
  async function report(cid, result) {
    for (let attempt = 0; attempt < 3 && state === 'connected'; attempt++) {
      try {
        const r = await agent('result', { cid, result }, ctl.signal)
        if (r.status === 200) return
        if (r.status === 409) return degrade('result')
      } catch { await sleep(backoff.minMs, ctl.signal) }
    }
    degrade('result')
  }
  async function drain() {
    if (draining) return
    draining = true
    try {
      while (pending.length && state === 'connected') {
        const cmd = pending.shift()
        const result = await executor.execute(cmd)
        await flush() // the hub must have the ops this command caused before it hears the result
        await report(cmd.cid, result)
      }
    } finally {
      draining = false
      if (pending.length && state === 'connected') void drain()
    }
  }

  return {
    get state() { return state },
    get instanceId() { return instanceId },
    mirror,
    onState(listener) { stateListeners.add(listener); return () => { stateListeners.delete(listener) } },
    start() {
      if (running) return
      running = true
      offOp = adapter.onOp(() => { void flush() })
      setState('connecting')
      void connect()
      sessionTimer = setInterval(checkSessions, sessionCheckMs)
      sessionTimer.unref?.()
    },
    /** Graceful end: flush what is queued, say bye (questions end at once), cancel everything. bye:false just disappears. */
    async stop({ bye = true } = {}) {
      if (!running) return
      running = false
      clearInterval(sessionTimer)
      offOp()
      if (bye && state === 'connected') {
        await Promise.race([flush(), sleep(1500)])
        try { await agent('bye', {}) } catch { /* the hub is gone anyway */ }
      }
      newCycle()
      mirror.stop()
      pending.length = 0
      connecting = false
      setState('stopped')
    },
    /** An action through the hub (POST /review-queue/v1/<kind>); the answer is { ok, ... }, never a throw. */
    async call(kind, body) {
      try {
        const r = await transport.request('POST', '/review-queue/v1/' + kind, { body, timeoutMs: CALL_TIMEOUT_MS })
        return r.json && typeof r.json === 'object' ? r.json : { ok: false, error: 'failed' }
      } catch { return { ok: false, error: 'hub-unreachable' } }
    },
    async presence({ desktopActive }) {
      if (state !== 'connected') return
      try { await agent('presence', { desktopActive: desktopActive === true }, ctl.signal) } catch { /* presence is best effort */ }
    },
    /** The workspace list changed: tell the hub (a full sync, which also carries it). */
    async refreshWorkspaces() { if (state === 'connected') await resync() },
    /** The overlay is about to list the workspaces: when the registry changed since the last report, the hub gets it first. Answers when it has it. */
    async syncWorkspaces() {
      if (state !== 'connected' || workspaceKey() === reported.workspaces) return
      wantSync = true
      await flush()
    },
    flush,
  }
}
