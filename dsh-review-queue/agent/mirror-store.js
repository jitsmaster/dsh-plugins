/**
 * A read-only store over the hub's snapshot: the same interface the service reads (get, list, snapshot, onChange), so the service
 * logic for positions, titles, speech and focus runs on every item of every app. The hub's own snapshot id is kept; what the hub
 * computed for display (position, spoken, risks) is dropped because the service computes it again. Writes are not stored here:
 * they go to the hub.
 */
import { createStore } from '../store.js'

const DERIVED = ['position', 'spoken', 'risks']

export function createMirrorStore({ now = Date.now } = {}) {
  const inner = createStore({ now })
  const listeners = new Set()
  let snapshotId = ''
  const refuse = () => false
  return {
    get: (id) => inner.get(id),
    list: (filter) => inner.list(filter),
    findOpen: (q) => inner.findOpen(q),
    snapshot: () => ({ ...inner.snapshot(), snapshotId }),
    isCurrent: (id) => id === snapshotId,
    add: refuse, update: refuse, resolve: refuse, reopen: refuse, resolveSession: refuse, reconcile: refuse, prune() {},
    /** Replace the mirror with a hub snapshot; listeners hear it unless it is the same snapshot again. */
    update(snap) {
      if (snap.snapshotId === snapshotId) return
      const items = [...snap.open, ...snap.resolved].map((item) => Object.fromEntries(Object.entries(item).filter(([k]) => !DERIVED.includes(k))))
      inner.restore({ seq: Math.max(0, ...items.map((i) => i.seq ?? 0)), items })
      snapshotId = snap.snapshotId
      for (const l of [...listeners]) { try { l() } catch { /* one bad listener must not stop the others */ } }
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
