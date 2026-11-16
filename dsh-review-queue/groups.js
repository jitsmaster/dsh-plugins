/**
 * Grouping of open review-queue items per session (spec: Review Queue Grouping And Priority Design Spec, slice 1). Pure: no I/O, input never mutated.
 * A group is all open items of one session, oldest first; a group is ordered by its oldest open item (oldest-first order is unchanged).
 * Items with no sessionId, and housekeeping types, stay single cards.
 */

const SINGLE_TYPES = new Set(['todo', 'onhold', 'archive', 'pr-merged', 'paused'])

/** The id of the group an item belongs to: its session, or `item:<id>` for a card that stands alone. */
export function groupIdOf(item) {
  if (!item || SINGLE_TYPES.has(item.type) || typeof item.sessionId !== 'string' || !item.sessionId) return 'item:' + item?.id
  return item.sessionId
}

/** Last-update time of an item: `updatedAt` (a merged question), else `createdAt`. */
const at = (i) => (Number.isFinite(i.updatedAt) ? i.updatedAt : Number.isFinite(i.createdAt) ? i.createdAt : Infinity)
/** Oldest first; a missing createdAt sorts last; seq breaks ties (Infinity - Infinity would be NaN). */
const byAge = (a, b) => { const x = at(a); const y = at(b); return x < y ? -1 : x > y ? 1 : (a.seq ?? 0) - (b.seq ?? 0) }

/**
 * Ordered groups `{ id, items, createdAt, count, topTier, rank }` of the open items.
 * `opts.order === 'tier'` with a finite `opts.now` orders groups by effective tier (best item tier, aged by group age, see tier.js), then oldest item;
 * anything else is oldest-first. A group without any tier ranks last.
 */
export function groupOpen(items, opts = {}) {
  const byId = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.status === 'resolved') continue
    const id = groupIdOf(item)
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(item)
  }
  const groups = [...byId].map(([id, list]) => {
    const sorted = [...list].sort(byAge)
    const tiers = sorted.map((i) => i.tier?.tier).filter(Number.isInteger)
    return { id, items: sorted, createdAt: at(sorted[0]), count: sorted.length, topTier: tiers.length ? tiers.reduce((m, t) => (t < m ? t : m), Infinity) : undefined }
  })
  if (opts?.order === 'tier' && Number.isFinite(opts.now)) {
    // Priority only: a group ranks by its own best tier (no aging, no risk or todo exceptions), then by its oldest item; untiered groups rank last.
    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0) // explicit: Infinity - Infinity is NaN
    const rankOf = (g) => (g.topTier === undefined ? Infinity : g.topTier)
    groups.sort((a, b) => cmp(rankOf(a), rankOf(b)) || byAge(a.items[0], b.items[0]))
  } else groups.sort((a, b) => byAge(a.items[0], b.items[0]))
  groups.forEach((g, n) => { g.rank = n + 1 })
  return groups
}
