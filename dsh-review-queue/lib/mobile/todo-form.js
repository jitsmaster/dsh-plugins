/**
 * The phone's "+ New todo" form (route #/new): pure validation, payload and wording, the same rules as the desktop form
 * (core.todoFormProblem: empty, or more than 4000 characters) and the same API (POST /v1/todo { text, workspaceId?, sparc? }, or { text, followUp }
 * in Follow up mode: the text is sent as a queued prompt to an EXISTING session found from the words in followUp, after the user confirms it on the card).
 * Node-tested; views.js stays thin.
 */

/** The longest task text the server takes. */
export const TODO_MAX = 4000

/** The longest description of the session a follow-up is for (the server's MAX_QUERY, the desktop's FOLLOWUP_MAX). */
export const FOLLOWUP_MAX = 300
export const FOLLOWUP_TEXT_PLACEHOLDER = 'What should the existing session do next?'
export const FOLLOWUP_QUERY_PLACEHOLDER = 'Which session? Describe it in your own words'
export const FOLLOWUP_HINT = 'Nothing is sent until you confirm the session.'

/**
 * A fresh draft: no text, "Choose for me", SPARC off, New session. The draft is kept in state while the user moves between screens.
 * Follow up mode and its description are extra keys (mode: 'followup', followUp: words) that exist only while they are set, so an old draft is a New session one.
 */
export const emptyTodoDraft = () => ({ text: '', workspaceId: '', sparc: false })

/** The localStorage key of the unsent draft: the text is written there on every change, so a reload or a crash loses nothing. */
export const TODO_DRAFT_KEY = 'rq-m.todoDraft'

/** True for a draft in Follow up mode. */
export const isFollowUpDraft = (draft) => !!draft && draft.mode === 'followup'

/** The draft in another mode: 'followup' sets it, anything else is New session and drops the key. The description stays (the desktop keeps it too). */
export function withTodoMode(draft, mode) {
  const { mode: _gone, ...rest } = draft || {}
  return mode === 'followup' ? { ...rest, mode: 'followup' } : rest
}

/** Writes the draft (text, workspaceId, sparc, and only when set: effort, mode followup, followUp; nothing else, never shortened) at once. storage is { get, set }; a storage that throws (private mode, quota) is ignored. */
export function saveTodoDraft(storage, draft) {
  const { text, workspaceId, sparc } = { ...emptyTodoDraft(), ...draft }
  const saved = { text, workspaceId, sparc, ...(draft && typeof draft.effort === 'string' && draft.effort ? { effort: draft.effort } : {}), ...(isFollowUpDraft(draft) ? { mode: 'followup' } : {}), ...(draft && typeof draft.followUp === 'string' && draft.followUp ? { followUp: draft.followUp } : {}) }
  try { storage.set(TODO_DRAFT_KEY, JSON.stringify(saved)) } catch { /* the draft stays in memory */ }
}

/** The saved draft; an empty one for nothing, corrupt or non-object data, and wrong field types fall back to the empty values. */
export function loadTodoDraft(storage) {
  let j
  try { j = JSON.parse(storage.get(TODO_DRAFT_KEY) || 'null') } catch { j = null }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return emptyTodoDraft()
  return {
    text: typeof j.text === 'string' ? j.text : '', workspaceId: typeof j.workspaceId === 'string' ? j.workspaceId : '', sparc: j.sparc === true,
    ...(typeof j.effort === 'string' && j.effort ? { effort: j.effort } : {}),
    ...(j.mode === 'followup' ? { mode: 'followup' } : {}), ...(typeof j.followUp === 'string' && j.followUp ? { followUp: j.followUp } : {}),
  }
}

/**
 * The draft without a workspace the loaded list does not contain (the workspace was closed since the draft was saved): the dropdown then reads
 * "Choose for me" instead of showing one thing and sending another. The same draft object comes back when nothing changes; an empty or missing list
 * is "not known yet" (the app may not have its workspaces) and changes nothing.
 */
export function dropStaleWorkspace(draft, workspaces) {
  if (!draft || !draft.workspaceId || !Array.isArray(workspaces) || !workspaces.length) return draft
  return workspaces.some((w) => w && w.id === draft.workspaceId) ? draft : { ...draft, workspaceId: '' }
}

/** Throws the saved draft away (after a successful start). */
export const forgetTodoDraft = (storage) => saveTodoDraft(storage, emptyTodoDraft())

/** Calls flush when the page is going away (pagehide) or goes to the background (visibilitychange to hidden); returns the remover. */
export function bindDraftFlush(win, doc, flush) {
  const onHide = () => { if (doc.visibilityState === 'hidden' || doc.hidden === true) flush() }
  win.addEventListener('pagehide', flush)
  doc.addEventListener('visibilitychange', onHide)
  return () => { win.removeEventListener('pagehide', flush); doc.removeEventListener('visibilitychange', onHide) }
}

/**
 * The request body for POST /v1/todo, or the message to show instead. The workspace is sent only when one was picked.
 * A follow-up draft sends only { text, followUp } (no workspace, no SPARC), with the desktop's messages for a missing or too long description.
 */
export function newTodoPayload({ text, workspaceId, sparc, effort, mode, followUp } = {}) {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return { ok: false, message: 'Type the task first.' }
  if (t.length > TODO_MAX) return { ok: false, message: 'That is too long.' }
  if (mode === 'followup') {
    const q = typeof followUp === 'string' ? followUp.trim() : ''
    if (!q) return { ok: false, message: 'Say which session this is for.' }
    if (q.length > FOLLOWUP_MAX) return { ok: false, message: 'Describe the session in ' + FOLLOWUP_MAX + ' characters or fewer.' }
    return { ok: true, body: { text: t, followUp: q } }
  }
  const body = { text: t, sparc: !!sparc }
  if (workspaceId) body.workspaceId = workspaceId
  if (typeof effort === 'string' && effort) body.effort = effort // only another than Default; this session alone uses it
  return { ok: true, body }
}

/** The efforts the model lists ({ efforts: [{ id, name }] }, from GET /v1/model-efforts), [] while they are not known. */
const effortList = (e) => (e && Array.isArray(e.efforts) ? e.efforts.filter((x) => x && typeof x.id === 'string') : [])

/** The name of an effort (its id when the list does not have it). */
export function effortName(efforts, id) {
  const x = effortList(efforts).find((c) => c.id === id)
  return x ? x.name || x.id : id
}

/** The Effort dropdown: "Default (<the effort the model uses now>)" first, then every effort; [] (no dropdown) for a model without efforts or before the list is known. */
export function effortChoices(efforts) {
  const list = effortList(efforts)
  if (!list.length) return []
  const label = efforts.defaultEffort ? 'Default (' + effortName(efforts, efforts.defaultEffort) + ')' : 'Default'
  return [{ value: '', label }, ...list.map((x) => ({ value: x.id, label: x.name || x.id }))]
}

/** The draft without an effort the model does not have (it may have changed since the draft was saved); the same object when nothing changes or the list is not known yet. */
export function dropStaleEffort(draft, efforts) {
  const list = effortList(efforts)
  if (!draft || !draft.effort || !list.length) return draft
  if (list.some((x) => x.id === draft.effort)) return draft
  const { effort: _gone, ...rest } = draft
  return rest
}

/** The workspace dropdown: "Choose for me" first, then every workspace by title. */
export function workspaceChoices(workspaces) {
  return [{ value: '', label: 'Choose for me' }, ...(workspaces || []).map((w) => ({ value: w.id, label: w.title }))]
}

/** Why the dropdown is bare, when it is: a failed load or an empty list says so; a loaded list or "not loaded yet" is silent. */
export function workspacesNote(workspaces, error) {
  if (error) return 'Could not load the workspaces (' + error + '). "Choose for me" still works.'
  if (Array.isArray(workspaces) && workspaces.length === 0) return 'No workspace is listed by DSH on your computer. "Choose for me" still works.'
  return null
}

const FRIENDLY = {
  empty: 'Type the task first.',
  'too-long': 'That is longer than ' + TODO_MAX + ' characters.',
  'unknown-workspace': 'That workspace is not available any more. Pick another one or choose "Choose for me".',
  'no-registry': 'DSH is not reachable on your computer, so no todo can start. Check that it is running.',
  'owner-offline': 'The DSH app that owns that workspace is not running.',
  // A follow-up (the desktop's own words; no-session is the shared core's)
  'empty-query': 'Say which session this is for.',
  'unknown-session': 'That session is not in the list any more. Pick another one.',
  'too-many-follow-ups': 'Too many follow-ups are waiting: confirm or cancel one first.',
}

/** The message for a failed POST /v1/todo: friendly text for the codes the phone form can cause, else the desktop's own wording. */
export function todoErrorText(core, status, body) {
  const code = body && typeof body === 'object' ? body.error : undefined
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(FRIENDLY, code)) return FRIENDLY[code]
  return core.errorText(status, body)
}
