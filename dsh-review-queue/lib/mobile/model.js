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
/** The order of the Waiting tabs (the desktop chip order puts Done first; the phone leads with what needs a decision). */
const WAITING_TAB_ORDER = ['all', 'permission', 'question', 'completed', 'pr-merged', 'todo', 'paused']

let listMemo = { core: null, snap: null, filter: null, model: null }
/** The lists and counts of the phone screens. Memoised on (core, snap, filter) identity: every screen and the app shell ask on each store change, the answer only moves with a new snapshot or filter. */
export function listModel(core, snap, filter) {
  if (listMemo.model && listMemo.core === core && listMemo.snap === snap && listMemo.filter === filter) return listMemo.model
  const model = buildListModel(core, snap, filter)
  listMemo = { core, snap, filter, model }
  return model
}

function buildListModel(core, snap, filter) {
  const f = filter || { type: 'all', query: '' }
  const open = snap ? snap.open : []
  const resolved = snap ? snap.resolved : []
  const nav = navCounts(core, snap)
  const selectedType = f.type || 'all'
  const resolvedType = f.resolvedType || 'all' // the Type select of the Resolved view: its own choice, not the Waiting tab
  const typeOrder = [...WAITING_TAB_ORDER.filter((t) => core.FILTER_TYPES.includes(t)), ...core.FILTER_TYPES.filter((t) => !WAITING_TAB_ORDER.includes(t))]
  // One pass over the open items for the search; the tab counts and the list are read from it. 'all' leaves the held queue out, as the desktop does.
  const found = core.filterItems(open, { type: 'all', query: f.query })
  const byType = {}
  for (const it of found) byType[it.type] = (byType[it.type] || 0) + 1
  const typeCount = (type) => (type === 'all' ? found.length : byType[type] || 0)
  // The same for Resolved: the search and the type once, then who resolved it.
  const resolvedFound = core.filterItems(resolved, { type: resolvedType, query: f.query })
  const resolvedCounts = core.resolvedCounts(resolved, { type: resolvedType, query: f.query }) // the one counting rule, shared with the desktop
  return {
    waiting: nav.waiting, // a todo that is being started, or a paused session, does not wait on the user
    paused: nav.paused, // sessions a restart cut off: read only here, resumed at the PC
    held: nav.held, // sessions on hold: their own tab, never waiting, never in All
    heldOpen: core.filterItems(open, { type: 'onhold', query: f.query }),
    sessions: nav.sessions, // "N working / M open" like the desktop header; '' while unknown
    open: selectedType === 'all' ? found : core.filterItems(open, f),
    resolved: core.filterItems(resolvedFound, { resolvedBy: f.resolvedBy }), // honours f.resolvedBy
    resolvedCount: nav.resolvedCount,
    aiUnseen: nav.aiUnseen,
    // The Waiting tabs: a count for what the tab would list now (the search applies); a type with nothing is hidden unless it is All, Paused (always reachable) or the selected one.
    tabs: typeOrder.map((type) => ({ type, label: type === 'all' ? 'All' : core.typeLabel(type), count: typeCount(type), on: selectedType === type }))
      .filter((t) => t.type === 'all' || t.type === 'paused' || t.on || t.count > 0),
    // The Resolved tabs (who resolved it): every count follows the Type select and the search; the AI tab adds an "N new" pill for the AI items nobody has looked at (whatever the filter).
    resolvedTabs: Array.from(core.RESOLVED_BY).map((value) => {
      const hot = value === 'ai' && nav.aiUnseen > 0
      return { value, label: core.RESOLVED_LABELS[value], on: (f.resolvedBy || 'all') === value, count: resolvedCounts[value], countText: hot ? nav.aiUnseen + ' new' : undefined, hot }
    }),
    chips: core.FILTER_TYPES.map((type) => ({ type, label: type === 'all' ? 'All' : core.typeLabel(type), on: selectedType === type })),
  }
}

let navMemo = { core: null, snap: null, counts: null }
/** What the app shell needs (the header counts and the bottom nav badges) without building any list. Memoised per snapshot. */
export function navCounts(core, snap) {
  if (navMemo.counts && navMemo.core === core && navMemo.snap === snap) return navMemo.counts
  const open = snap ? snap.open : []
  const resolved = snap ? snap.resolved : []
  const counts = {
    waiting: core.waitingCount(open),
    paused: core.pausedCount(open),
    held: core.heldCount(open),
    resolvedCount: resolved.length,
    aiUnseen: core.aiUnseenCount(resolved), // AI-resolved items nobody has seen or reviewed, whatever the filter
    sessions: core.sessionsText(snap && snap.sessions),
  }
  navMemo = { core, snap, counts }
  return counts
}

/** Whether the item a bottom sheet acts on is no longer in the snapshot (the sheet is then closed). False for no sheet. */
export function sheetGone(sheet, snap) {
  if (!sheet || !snap) return false
  return !snap.open.some((i) => i.id === sheet.id) && !snap.resolved.some((i) => i.id === sheet.id)
}
/** The indicator line for sessions a restart cut off (undefined for none). The phone only lists them: acting on them is for the PC. */
export function pausedNote(n) {
  if (!n) return undefined
  return n === 1
    ? '1 session was paused by a restart. Resume it at the PC, or dismiss it here.'
    : n + ' sessions were paused by a restart. Resume them at the PC, or dismiss them here.'
}

/** The card of a paused session: the facts the desktop card shows (core.pausedFacts) and where to act. Resume is for the PC; Dismiss is on the card (views.js PausedBody). */
export function pausedView(core, item, now) {
  return { facts: core.pausedFacts(item, now), note: 'To resume this session, use the Coding Boss Review Queue on the PC. If it needs no action, dismiss it here.' }
}

/** The card of a session on hold: the facts the desktop card shows (core.heldFacts); Continue and Release are on the card (views.js HeldBody). */
export function heldView(core, item, now) {
  return { facts: core.heldFacts(item, now) }
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
  const canAct = core.stageOf(item).canAct // the stage table (client.js stageOf): todo-confirm and todo-failed
  const followUp = isFollowUp(item)
  return {
    kind: followUp ? 'followup' : 'todo',
    text: item.text,
    sparc: !!item.sparc,
    effort: typeof item.effort === 'string' ? item.effort : '',
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
export const backHref = () => '#/'

/** The words of the Resolved link of the bottom nav: how many AI-resolved items nobody has looked at, of how many resolved in all (the badge shows only one of the two). */
export function resolvedNavLabel(nav) {
  return nav.resolvedCount ? 'Resolved: ' + nav.aiUnseen + ' unseen AI of ' + nav.resolvedCount + ' total' : 'Resolved: nothing yet'
}

/** The error a card shows for an item: none while a sheet of that item is open, because the sheet shows it (one place, not two). */
export function cardError(sheet, id, error) {
  return sheet && sheet.id === id ? undefined : error
}

/** What the Mark wrong sheet needs from its text: the trimmed correction that is sent, whether Send correction is off (blank text, or an action running), and whether the answer already went to the session. */
export function markWrongView(item, text, busy) {
  const correction = String(text || '').trim()
  return { confirmDisabled: !!busy || !correction, unsent: item.type === 'question' || item.type === 'permission', correction }
}

/** The tab a key moves to in a row of count tabs: Left / Right wrap around, Home / End jump; -1 for any other key. */
export function nextTabIndex(index, count, key) {
  if (!count || count < 1) return -1
  if (key === 'ArrowRight') return (index + 1) % count
  if (key === 'ArrowLeft') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return -1
}
