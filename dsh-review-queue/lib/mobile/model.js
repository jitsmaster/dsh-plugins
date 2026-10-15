/**
 * What the phone's lists show, derived with the helpers shared with the desktop Task list (core = exports.shared of lib/client.js), so
 * the waiting count, the filter chips, the filter and the search are the desktop's own rules and the two screens cannot drift apart.
 * Pure: no DOM, no state (node-tested against the overlay itself).
 */

/**
 * @param {object} core the shared helpers
 * @param {{ open: object[], resolved: object[] } | null} snap the /v1/snapshot body
 * @param {{ type?: string, query?: string }} filter
 */
export function listModel(core, snap, filter) {
  const f = filter || { type: 'all', query: '' }
  const open = snap ? snap.open : []
  const resolved = snap ? snap.resolved : []
  return {
    waiting: core.waitingCount(open), // a todo that is being started does not wait on the user
    open: core.filterItems(open, f),
    resolved: core.filterItems(resolved, f),
    resolvedCount: resolved.length,
    barVisible: core.filterBarVisible(snap, f),
    chips: core.FILTER_TYPES.map((type) => ({ type, label: type === 'all' ? 'All' : core.typeLabel(type), on: (f.type || 'all') === type })),
  }
}

/** The read-only todo card: the task, SPARC, and the same sentence the desktop card shows for the state (no workspaces are loaded here). */
export function todoView(core, item) {
  return { text: item.text, sparc: !!item.sparc, line: core.todoLine(item, undefined, []), failed: core.todoCardState(item) === 'failed' }
}

/** How long the snapshot long-poll may wait: not at all right after an error, so the first answer (even "unchanged") clears the banner at once. */
export function pollWaitMs(state, waitMs) {
  return state.error || state.auth ? 0 : waitMs
}
