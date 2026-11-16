/**
 * The review queue's item store: one list of things waiting on the user (completed work, open questions, permission
 * requests), shared by the sidebar tab, the overlay and, later, voice. Open items are numbered by position (oldest = 1);
 * resolved items stay for a week. Persisted as one small JSON file; a missing, corrupt or unwritable file never throws.
 */
import { randomUUID } from 'node:crypto'
import { buildTier, validTier } from './tier.js'
import { groupOpen } from './groups.js'

/** The code-only tier of an item (no model input, no facts): every item has one from the moment it exists. The triage runner may refine it later. */
const codeTier = (item, at) => buildTier({ item }, at)

export const RETENTION_MS = 7 * 24 * 3600 * 1000
/** Items the AI resolved (the Resolved by AI list) are kept longer, so there is time to review them. */
export const AI_RETENTION_MS = 30 * 24 * 3600 * 1000
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
export function createStore({ now = Date.now, uuid = () => randomUUID().slice(0, 12), io, retentionMs = RETENTION_MS, events } = {}) {
  /** One row in the event log (ids, types, tiers only); a failing log never reaches the store. */
  const emit = (event) => { try { events?.record(event) } catch { /* the event log is best effort */ } }
  let shownOrder = 'oldest'
  const shownIds = new Set()
  /** 1-based position of an open item under the current display order. */
  const rankOf = (id) => {
    if (!events) return undefined // nothing records it: skip the sort
    let flat = [...items.values()].filter((i) => i.status === 'open').sort(order)
    if (shownOrder === 'tier') flat = groupOpen(flat, { order: 'tier', now: now() }).flatMap((g) => g.items)
    const n = flat.findIndex((i) => i.id === id)
    return n < 0 ? undefined : n + 1
  }
  const emitTier = (item) => { if (item.tier) emit({ kind: 'tiered', itemId: item.id, type: item.type, tier: item.tier.tier, severity: item.tier.severity, urgency: item.tier.urgency }) }
  const emitResolved = (item) => emit({ kind: 'resolved', itemId: item.id, type: item.type, resolution: item.resolution?.kind, by: item.resolution?.by })
  /** @type {Map<string, any>} */
  const items = new Map()
  const listeners = new Set()
  const addListeners = new Set()
  let seq = 0
  let version = 0
  const epoch = uuid()

  const order = (a, b) => a.createdAt - b.createdAt || a.seq - b.seq

  // Performance: the open items per session, so the per-step lookup of the capture reads one small set instead of cloning every item.
  // Every status or session change of an item goes through reindex.
  const openBy = new Map() // sessionId -> Set of the live open items of that session
  const indexedAs = new Map() // item id -> the sessionId it is indexed under

  function unindex(item) {
    const was = indexedAs.get(item.id)
    if (was === undefined) return
    const set = openBy.get(was)
    set?.delete(item)
    if (set && !set.size) openBy.delete(was)
    indexedAs.delete(item.id)
  }

  function reindex(item) {
    unindex(item)
    if (item.status !== 'open' || typeof item.sessionId !== 'string') return
    const set = openBy.get(item.sessionId) ?? new Set()
    set.add(item)
    openBy.set(item.sessionId, set)
    indexedAs.set(item.id, item.sessionId)
  }

  // The live items, not copies: for a caller that serialises them at once (the hub's file) and must not mutate them.
  const dump = () => ({ seq, items: [...items.values()] })

  function save() {
    if (!io) return
    try { io.write(JSON.stringify({ v: VERSION, ...dump() })) } catch { /* persistence is best effort */ }
  }

  /** Replace everything with saved state; items without an id or a type are skipped. */
  function restore(data) {
    items.clear()
    openBy.clear()
    indexedAs.clear()
    for (const item of data.items) {
      if (item && typeof item.id === 'string' && typeof item.type === 'string') {
        if (!validTier(item.tier) || (item.type === 'todo' && item.status === 'open')) item.tier = codeTier(item, Number.isFinite(item.createdAt) ? item.createdAt : now()) // no or malformed tier (saved before tiers existed); an open todo is always re-derived: it is P0 by design (tier.js) and triage never judges one, so a stored todo tier holds nothing worth keeping
        items.set(item.id, item); reindex(item)
      }
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
      item.tier = codeTier(item, now()) // never taken from the caller: an item cannot arrive with a forged tier
      const replaced = items.get(item.id) // an id given twice replaces the earlier item: it must leave the index too
      if (replaced) unindex(replaced)
      items.set(item.id, item)
      reindex(item)
      changed()
      emitTier(item)
      // The one place new items are announced (AI triage listens here, not in every raiser). A listener runs after the item is stored and can never break the add.
      for (const listener of [...addListeners]) {
        try { listener(copy(item)) } catch { /* one bad listener must not stop the others or lose the item */ }
      }
      return copy(item)
    },
    get: (id) => copy(items.get(id)),
    /** Patch fields of an item (a summary arriving later); false when the id is unknown. */
    update(id, patch) {
      const item = items.get(id)
      if (!item) return false
      const { tier: _ignored, ...rest } = patch ?? {} // a tier never arrives through a generic patch (setTier is the one way)
      Object.assign(item, capped(rest))
      reindex(item)
      changed()
      return true
    },
    /** Replace the tier of an item with a well-formed one (the triage runner, after the judge); false for an unknown id or a malformed tier. */
    setTier(id, tier) {
      const item = items.get(id)
      if (!item || !validTier(tier)) return false
      const was = item.tier?.tier
      if (item.tier && item.tier.severity === tier.severity && item.tier.urgency === tier.urgency && item.tier.tier === tier.tier) return true // nothing changed: no version bump, no persist
      item.tier = { severity: tier.severity, urgency: tier.urgency, tier: tier.tier, at: Number.isFinite(tier.at) ? tier.at : now() }
      changed()
      if (item.tier.tier !== was) emitTier(item)
      return true
    },
    /** Put a resolved item back in the queue, in its old place (a misclicked Reviewed). */
    reopen(id) {
      const item = items.get(id)
      if (!item || item.status !== 'resolved') return false
      item.status = 'open'
      shownIds.delete(id) // back in the queue: it can be shown (and reported) again
      delete item.resolvedAt
      delete item.resolution
      reindex(item)
      changed()
      return true
    },
    /** How many ids `shown` remembers (open items only); for tests. */
    shownCount: () => shownIds.size,
    /** The display order the ranks of `shown` and `acted` events follow ('oldest' or 'tier'); set by the service. */
    setOrder(value) { shownOrder = value === 'tier' ? 'tier' : 'oldest' },
    /** Records `shown` once per item (first time in view) with its current rank; false when the item is not open. Ids, type and rank only. */
    shown(id) {
      const item = items.get(id)
      if (!item || item.status !== 'open') return false
      if (shownIds.has(id)) return true
      shownIds.add(id)
      emit({ kind: 'shown', itemId: id, type: item.type, rank: rankOf(id) })
      return true
    },
    /** Move an open item to resolved, once. */
    resolve(id, resolution) {
      const item = items.get(id)
      if (!item || item.status !== 'open') return false
      // `acted` = a card action that resolves the item here (by:'card'); the rank is the server display order, not the client's held order. Answers that go through update() are not counted (documented limit).
      if (resolution?.by === 'card') emit({ kind: 'acted', itemId: id, type: item.type, rank: rankOf(id) }) // the user's own action, with the rank held at that moment
      item.status = 'resolved'
      shownIds.delete(id) // the set only holds open items
      item.resolvedAt = now()
      item.resolution = { ...resolution }
      reindex(item)
      changed()
      emitResolved(item)
      return true
    },
    /** Resolve an open item only when test(item) holds, read in the same tick (a throwing test counts as false). */
    resolveIf(id, test, resolution) {
      const item = copy(items.get(id))
      if (!item || item.status !== 'open') return false
      try { if (!test(item)) return false } catch { return false }
      return this.resolve(id, resolution)
    },
    resolveSession(sessionId, resolution) {
      let any = false
      for (const item of items.values()) {
        if (item.sessionId === sessionId && item.status === 'open') {
          item.status = 'resolved'; shownIds.delete(item.id); item.resolvedAt = now(); item.resolution = { ...resolution }; reindex(item); emitResolved(item); any = true
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
          item.status = 'resolved'; shownIds.delete(item.id); item.resolvedAt = now(); item.resolution = { kind: 'session-ended' }; reindex(item); emitResolved(item); any = true
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
    /**
     * The LIVE open items of one session, oldest first (no copies: the caller must not mutate them). For the hot per-step check of the
     * capture; everything else uses list() / get(), which hand out copies.
     */
    peekOpen: (sessionId) => [...(openBy.get(sessionId) ?? [])].sort(order),
    /** How many items the test accepts, looking at the LIVE items (no copies: the test must not mutate them). For a cap or a counter that would otherwise clone every item with list(). */
    count(test) { let n = 0; for (const item of items.values()) if (test(item)) n++; return n },
    list: ({ status } = {}) => [...items.values()].filter((i) => status === undefined || i.status === status).sort(order).map(copy),
    /** Open items, oldest first, each with its position (1 = oldest); resolved items, newest first. */
    snapshot({ order: queueOrder } = {}) {
      const all = [...items.values()]
      let flat = all.filter((i) => i.status === 'open').sort(order)
      const info = new Map()
      const groups = groupOpen(flat, queueOrder === 'tier' ? { order: 'tier', now: now() } : {})
      for (const g of groups) for (const i of g.items) info.set(i.id, { groupId: g.id, groupRank: g.rank })
      if (queueOrder === 'tier') flat = groups.flatMap((g) => g.items) // group by group, best effective tier first; position follows
      const open = flat.map((i, n) => ({ ...copy(i), position: n + 1, ...info.get(i.id) }))
      const resolved = all.filter((i) => i.status === 'resolved').sort((a, b) => b.resolvedAt - a.resolvedAt || b.seq - a.seq).map(copy)
      return { snapshotId: epoch + ':' + version, open, resolved }
    },
    isCurrent: (snapshotId) => snapshotId === epoch + ':' + version,
    prune() {
      const at = now()
      let any = false
      for (const [id, item] of items) {
        if (item.status === 'resolved' && item.resolvedAt < at - (item.resolution?.kind === 'ai-resolved' ? AI_RETENTION_MS : retentionMs)) { items.delete(id); shownIds.delete(id); any = true }
      }
      if (any) changed()
    },
    dump,
    restore,
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** listener(item copy) after every add (not update, not restore); returns the unsubscribe. */
    onAdd(listener) {
      addListeners.add(listener)
      return () => { addListeners.delete(listener) }
    },
  }
}
