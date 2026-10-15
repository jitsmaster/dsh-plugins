/**
 * Stands in for the agent client from the first moment: the hub queue and the proxy are wired to it before any hub exists, and it
 * forwards to the real client once the launcher found a hub (attach). Listeners added earlier move over to the real client.
 * Until then it is a stopped client with an empty mirror whose calls refuse.
 */
const none = { ready: false, snapshot: () => undefined, workspaces: () => [] }

/** @param {{ instanceId: string }} opts */
export function createClientHandle({ instanceId }) {
  const stateListeners = new Set()
  const mirrorListeners = new Set()
  let real
  let detach = () => {}
  const fire = (set, ...args) => { for (const l of [...set]) { try { l(...args) } catch { /* one bad listener must not stop the others */ } } }
  const subscribe = (set, listener) => { set.add(listener); return () => { set.delete(listener) } }

  return {
    instanceId,
    get attached() { return real !== undefined },
    get real() { return real },
    get state() { return real ? real.state : 'stopped' },
    mirror: {
      get ready() { return (real?.mirror ?? none).ready },
      snapshot: () => (real?.mirror ?? none).snapshot(),
      workspaces: () => (real?.mirror ?? none).workspaces(),
      onChange: (listener) => subscribe(mirrorListeners, listener),
    },
    onState: (listener) => subscribe(stateListeners, listener),
    /** A new real client replaces the old one, which ends without a goodbye (the new one registers the same app again). */
    attach(next) {
      detach()
      const old = real
      real = next
      if (old) void old.stop({ bye: false })
      const offState = next.onState((s) => fire(stateListeners, s))
      const offMirror = next.mirror.onChange?.(() => fire(mirrorListeners))
      detach = () => { offState(); offMirror?.() }
    },
    start() { real?.start() },
    async stop(opts) { await real?.stop(opts) },
    async syncWorkspaces() { await real?.syncWorkspaces() },
    async call(kind, body) { return real ? real.call(kind, body) : { ok: false, error: 'hub-unreachable' } },
  }
}
