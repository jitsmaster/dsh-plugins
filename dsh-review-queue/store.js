/**
 * The review queue's item store: one list of things waiting on the user (completed work, open questions, permission
 * requests), shared by the sidebar tab, the overlay and, later, voice. Open items are numbered by position (oldest = 1);
 * resolved items stay for a week. Persisted as one small JSON file; a missing, corrupt or unwritable file never throws.
 */
import { randomUUID } from 'node:crypto'

export const RETENTION_MS = 7 * 24 * 3600 * 1000
const MAX_TEXT = 20000
const VERSION = 1

const clip = (value) => (typeof value === 'string' && value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value)

/** Strings anywhere in a payload are capped so one huge reply cannot bloat the file or the API. */
function capped(value, depth = 0) {
  if (typeof value === 'string') return clip(value)
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => capped(v, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capped(v, depth + 1)]))
}

/**
 * @param {{ now?: () => number, uuid?: () => string, io?: { read: () => string | undefined, write: (text: string) => void }, retentionMs?: number }} [opts]
 */
export function createStore({ now = Date.now, uuid = () => randomUUID().slice(0, 12), io, retentionMs = RETENTION_MS } = {}) {
  /** @type {Map<string, any>} */
  const items = new Map()
  const listeners = new Set()
  let seq = 0
  let version = 0
  const epoch = uuid()

  const order = (a, b) => a.createdAt - b.createdAt || a.seq - b.seq

  // The live items, not copies: for a caller that serialises them at once (the hub's file) and must not mutate them.
  const dump = () => ({ seq, items: [...items.values()] })

  function save() {
    if (!io) return
    try { io.write(JSON.stringify({ v: VERSION, ...dump() })) } catch { /* persistence is best effort */ }
  }

  /** Replace everything with saved state; items without an id or a type are skipped. */
  function restore(data) {
    items.clear()
    for (const item of data.items) {
      if (item && typeof item.id === 'string' && typeof item.type === 'string') items.set(item.id, item)
    }
    seq = Number.isFinite(data.seq) ? data.seq : items.size
  }

  function changed() {
    version++
    save()
    for (const listener of [...listeners]) {
      try { listener() } catch { /* one bad listener must not stop the others */ }
    }
  }

  function load() {
    if (!io) return
    try {
      const text = io.read()
      if (!text) return
      const data = JSON.parse(text)
      if (!data || data.v !== VERSION || !Array.isArray(data.items)) return
      restore(data)
    } catch { items.clear() }
  }
  load()

  const copy = (item) => (item === undefined ? undefined : structuredClone(item))

  return {
    /** opts.id / opts.createdAt: an item captured elsewhere keeps its id and time (the hub). */
    add(input, { id, createdAt } = {}) {
      const item = { ...capped(input), id: id ?? uuid(), seq: ++seq, status: 'open', createdAt: createdAt ?? now() }
      items.set(item.id, item)
      changed()
      return copy(item)
    },
    get: (id) => copy(items.get(id)),
    /** Patch fields of an item (a summary arriving later); false when the id is unknown. */
    update(id, patch) {
      const item = items.get(id)
      if (!item) return false
      Object.assign(item, capped(patch))
      changed()
      return true
    },
    /** Put a resolved item back in the queue, in its old place (a misclicked Reviewed). */
    reopen(id) {
      const item = items.get(id)
      if (!item || item.status !== 'resolved') return false
      item.status = 'open'
      delete item.resolvedAt
      delete item.resolution
      changed()
      return true
    },
    /** Move an open item to resolved, once. */
    resolve(id, resolution) {
      const item = items.get(id)
      if (!item || item.status !== 'open') return false
      item.status = 'resolved'
      item.resolvedAt = now()
      item.resolution = { ...resolution }
      changed()
      return true
    },
    resolveSession(sessionId, resolution) {
      let any = false
      for (const item of items.values()) {
        if (item.sessionId === sessionId && item.status === 'open') {
          item.status = 'resolved'; item.resolvedAt = now(); item.resolution = { ...resolution }; any = true
        }
      }
      if (any) changed()
      return any
    },
    /** Resolve open items whose session is not in liveIds (after a restart, or when sessions were deleted). */
    reconcile(liveIds) {
      let any = false
      for (const item of items.values()) {
        if (item.status === 'open' && !liveIds.has(item.sessionId)) {
          item.status = 'resolved'; item.resolvedAt = now(); item.resolution = { kind: 'session-ended' }; any = true
        }
      }
      if (any) changed()
      return any
    },
    findOpen({ type, sessionId, key }) {
      for (const item of [...items.values()].sort(order)) {
        if (item.status !== 'open') continue
        if (type !== undefined && item.type !== type) continue
        if (sessionId !== undefined && item.sessionId !== sessionId) continue
        if (key !== undefined && item.key !== key) continue
        return copy(item)
      }
      return undefined
    },
    list: ({ status } = {}) => [...items.values()].filter((i) => status === undefined || i.status === status).sort(order).map(copy),
    /** Open items, oldest first, each with its position (1 = oldest); resolved items, newest first. */
    snapshot() {
      const all = [...items.values()]
      const open = all.filter((i) => i.status === 'open').sort(order).map((i, n) => ({ ...copy(i), position: n + 1 }))
      const resolved = all.filter((i) => i.status === 'resolved').sort((a, b) => b.resolvedAt - a.resolvedAt || b.seq - a.seq).map(copy)
      return { snapshotId: epoch + ':' + version, open, resolved }
    },
    isCurrent: (snapshotId) => snapshotId === epoch + ':' + version,
    prune() {
      const limit = now() - retentionMs
      let any = false
      for (const [id, item] of items) {
        if (item.status === 'resolved' && item.resolvedAt < limit) { items.delete(id); any = true }
      }
      if (any) changed()
    },
    dump,
    restore,
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
