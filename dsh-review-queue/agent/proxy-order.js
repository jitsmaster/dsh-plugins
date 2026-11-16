/**
 * The id stamp and the list ordering of the hub proxy's own By priority switch (agent/proxy.js). Pure: no I/O, input never mutated.
 * The hub lists oldest first; an app that shows the list by priority re-sorts it here and marks the snapshot id so a poll holding the other
 * order's stamp gets a full answer.
 */
import { groupOpen } from '../groups.js'
import { spokenFor } from '../speech.js'

export const TIER_MARK = '~tier'

/** The snapshot id a client sees: the hub's id, marked when this app shows the list by priority (a different order needs its own stamp). */
export const stampTier = (id, tiered) => id + (tiered ? TIER_MARK : '')

/** The reverse of stampTier: the hub's id and whether the mark was on it. */
export const unstampTier = (stamp) => (stamp.endsWith(TIER_MARK) ? { id: stamp.slice(0, -TIER_MARK.length), tiered: true } : { id: stamp, tiered: false })

/** Group members in group order, each carrying its group's id and rank. */
export const flattenGroups = (groups) => groups.flatMap((g) => g.items.map((i) => ({ ...i, groupId: g.id, groupRank: g.rank })))

/** The item at its 1-based place in the list; a spoken line names the place, so it is built again. */
export const atPosition = (item, n) => ({ ...item, position: n + 1, spoken: item.spoken && spokenFor(item, n + 1) })

/** The hub lists oldest first: this app's own By priority switch re-sorts that list by group tier, positions following. */
export const tierSorted = (list) => flattenGroups(groupOpen(list, { order: 'tier' })).map(atPosition)
