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
    waiting: core.waitingCount(open), // a todo that is being started, or a paused session, does not wait on the user
    paused: core.pausedCount(open), // sessions a restart cut off: read only here, resumed at the PC
    sessions: core.sessionsText(snap && snap.sessions), // "N working / M open" like the desktop header; '' while unknown
    open: core.filterItems(open, f),
    resolved: core.filterItems(resolved, f),
    resolvedCount: resolved.length,
    barVisible: core.filterBarVisible(snap, f),
    chips: core.FILTER_TYPES.map((type) => ({ type, label: type === 'all' ? 'All' : core.typeLabel(type), on: (f.type || 'all') === type })),
  }
}

/** The indicator line for sessions a restart cut off (undefined for none). The phone only lists them: acting on them is for the PC. */
export function pausedNote(n) {
  if (!n) return undefined
  return n === 1
    ? '1 session was paused by a restart. Resume or dismiss it at the PC.'
    : n + ' sessions were paused by a restart. Resume or dismiss them at the PC.'
}

/** The read-only card of a paused session: the facts the desktop card shows (core.pausedFacts) and where to act. No actions. */
export function pausedView(core, item, now) {
  return { facts: core.pausedFacts(item, now), note: 'To resume this session, use the Task list on the PC.' }
}

/** The read-only todo card: the task, SPARC, and the same sentence the desktop card shows for the state (no workspaces are loaded here). */
export function todoView(core, item) {
  return { text: item.text, sparc: !!item.sparc, line: core.todoLine(item, undefined, []), failed: core.todoCardState(item) === 'failed' }
}

/**
 * The interactive todo card, built with the desktop's own helpers: the sentence under the task (core.todoLine), the dropdown
 * (core.todoSelect: the user's pick, else the workspace the todo was given, else the suggestion) and what the card offers.
 * Awaiting-confirm and failed can be acted on (Start, or Retry when failed, and Cancel); starting, started and cancelled are read-only text.
 * A follow-up (item.kind 'followup': the text goes to an EXISTING session) is the same card with sessions in place of workspaces: the helpers of core
 * do the sentence and the dropdown (the user's pick, else the session sent to before, else the suggestion), the button reads Send (Retry when failed),
 * and the workspaces are never needed.
 * @param {object} core the shared helpers
 * @param {object} item the todo item
 * @param {{ id: string, title: string }[] | null | undefined} workspaces the loaded workspaces (GET /v1/workspaces)
 * @param {string} [pick] the workspace the user chose in the dropdown
 */
export function todoCardModel(core, item, workspaces, pick) {
  const select = core.todoSelect(item, pick, workspaces)
  const failed = core.todoCardState(item) === 'failed'
  const canAct = item.state === 'awaiting-confirm' || item.state === 'failed'
  const followUp = isFollowUp(item)
  return {
    kind: followUp ? 'followup' : 'todo',
    text: item.text,
    sparc: !!item.sparc,
    line: core.todoLine(item, pick, workspaces),
    failed,
    canAct,
    selected: select.value,
    options: select.options,
    placeholder: select.placeholder,
    selectLabel: followUp ? 'Session' : 'Workspace',
    startLabel: failed ? 'Retry' : followUp ? 'Send' : 'Start',
    canStart: canAct && !!select.value,
    needsWorkspaces: canAct && !followUp, // a follow-up lists its own candidates
  }
}

/** A todo that is a follow-up for an existing session. */
// Source of truth for what a follow-up item is: kind 'followup' of todo-follow-up.js (a browser copy of that check).
const isFollowUp = (item) => !!item && item.kind === 'followup'

/** The body of POST /v1/todo-confirm (Start, Send or Retry): the chosen session of a follow-up, else the chosen workspace. */
export const todoConfirmBody = (item, selected) => (isFollowUp(item) ? { id: item.id, sessionId: selected } : { id: item.id, workspaceId: selected })

/** The body of POST /v1/todo-cancel. */
export const todoCancelBody = (item) => ({ id: item.id })

/** How long the snapshot long-poll may wait: not at all right after an error, so the first answer (even "unchanged") clears the banner at once. */
export function pollWaitMs(state, waitMs) {
  return state.error || state.auth ? 0 : waitMs
}

/** Which screen the phone shows: the pairing screen when the hub refused the phone or the pairing link was opened, else the app. */
export function screenFor(state, route) {
  return state.needsPairing === true || route === '/pair' || route.startsWith('/pair/') ? 'pair' : 'app'
}

/**
 * Where Back on an item card goes. Always the Waiting list, also for a resolved item: the phone must never take the user to the
 * Resolved tab on its own (it is opened only by tapping that tab).
 */
export const backHref = (_item) => '#/'
