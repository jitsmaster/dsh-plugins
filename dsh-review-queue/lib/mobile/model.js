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

/**
 * The interactive todo card, built with the desktop's own helpers: the sentence under the task (core.todoLine), the dropdown
 * (core.todoSelect: the user's pick, else the workspace the todo was given, else the suggestion) and what the card offers.
 * Awaiting-confirm and failed can be acted on (Start, or Retry when failed, and Cancel); starting, started and cancelled are read-only text.
 * @param {object} core the shared helpers
 * @param {object} item the todo item
 * @param {{ id: string, title: string }[] | null | undefined} workspaces the loaded workspaces (GET /v1/workspaces)
 * @param {string} [pick] the workspace the user chose in the dropdown
 */
export function todoCardModel(core, item, workspaces, pick) {
  const select = core.todoSelect(item, pick, workspaces)
  const failed = core.todoCardState(item) === 'failed'
  const canAct = item.state === 'awaiting-confirm' || item.state === 'failed'
  return {
    text: item.text,
    sparc: !!item.sparc,
    line: core.todoLine(item, pick, workspaces),
    failed,
    canAct,
    selected: select.value,
    options: select.options,
    placeholder: select.placeholder,
    startLabel: failed ? 'Retry' : 'Start',
    canStart: canAct && !!select.value,
  }
}

/** How long the snapshot long-poll may wait: not at all right after an error, so the first answer (even "unchanged") clears the banner at once. */
export function pollWaitMs(state, waitMs) {
  return state.error || state.auth ? 0 : waitMs
}

/** Which screen the phone shows: the pairing screen when the hub refused the phone or the pairing link was opened, else the app. */
export function screenFor(state, route) {
  return state.needsPairing === true || route === '/pair' || route.startsWith('/pair/') ? 'pair' : 'app'
}
