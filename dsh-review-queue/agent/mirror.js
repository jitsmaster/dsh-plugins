/**
 * The agent's copy of the hub's snapshot: a long poll on /review-queue/v1/snapshot (and the workspace union next to it), kept while
 * the agent is connected. ready is true after the first answer and false again when the hub stops answering.
 */
const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

/** @param {{ transport: ReturnType<import('./transport.js').createTransport>, waitMs?: number, backoff?: { minMs: number, maxMs: number }, log?: (line: string) => void }} deps */
export function createMirror({ transport, waitMs = 25_000, backoff = { minMs: 1000, maxMs: 10_000 }, log = () => {} }) {
  const listeners = new Set()
  let snap
  let workspaces = []
  let ready = false
  let ctl

  const emit = () => { for (const l of [...listeners]) { try { l() } catch { /* one bad listener must not stop the others */ } } }
  const setReady = (value) => { if (ready !== value) { ready = value; emit() } }

  async function refreshWorkspaces(signal) {
    const r = await transport.request('GET', '/review-queue/v1/workspaces', { signal })
    if (r.status === 200 && Array.isArray(r.json?.workspaces)) workspaces = r.json.workspaces
  }

  async function loop(signal) {
    let wait = backoff.minMs
    while (!signal.aborted) {
      try {
        const since = snap ? '?since=' + encodeURIComponent(snap.snapshotId + '|||0') + '&wait=' + waitMs : ''
        const r = await transport.request('GET', '/review-queue/v1/snapshot' + since, { waitMs: since ? waitMs : 0, signal })
        if (r.status !== 200) throw new Error('status ' + r.status)
        const changed = !r.json.unchanged && Array.isArray(r.json.open)
        if (changed) snap = r.json
        await refreshWorkspaces(signal)
        wait = backoff.minMs
        if (changed) emit()
        setReady(true)
      } catch {
        if (signal.aborted) return
        setReady(false)
        await sleep(wait, signal)
        wait = Math.min(wait * 2, backoff.maxMs)
      }
    }
  }

  return {
    get ready() { return ready },
    snapshot: () => snap,
    workspaces: () => workspaces,
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    start() { if (ctl && !ctl.signal.aborted) return; ctl = new AbortController(); void loop(ctl.signal).catch((e) => log('mirror stopped: ' + String(e?.name ?? 'error'))) },
    stop() { ctl?.abort(); setReady(false) },
  }
}
