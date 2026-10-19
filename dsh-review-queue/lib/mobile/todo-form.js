/**
 * The phone's "+ New todo" form (route #/new): pure validation, payload and wording, the same rules as the desktop form
 * (core.todoFormProblem: empty, or more than 4000 characters) and the same API (POST /v1/todo { text, workspaceId?, sparc? }).
 * Node-tested; views.js stays thin.
 */

/** The longest task text the server takes. */
export const TODO_MAX = 4000

/** A fresh draft: no text, "Choose for me", SPARC off. The draft is kept in state while the user moves between screens. */
export const emptyTodoDraft = () => ({ text: '', workspaceId: '', sparc: false })

/** The localStorage key of the unsent draft: the text is written there on every change, so a reload or a crash loses nothing. */
export const TODO_DRAFT_KEY = 'rq-m.todoDraft'

/** Writes the draft (text, workspaceId, sparc; nothing else, never shortened) at once. storage is { get, set }; a storage that throws (private mode, quota) is ignored. */
export function saveTodoDraft(storage, draft) {
  const { text, workspaceId, sparc } = { ...emptyTodoDraft(), ...draft }
  try { storage.set(TODO_DRAFT_KEY, JSON.stringify({ text, workspaceId, sparc })) } catch { /* the draft stays in memory */ }
}

/** The saved draft; an empty one for nothing, corrupt or non-object data, and wrong field types fall back to the empty values. */
export function loadTodoDraft(storage) {
  let j
  try { j = JSON.parse(storage.get(TODO_DRAFT_KEY) || 'null') } catch { j = null }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return emptyTodoDraft()
  return { text: typeof j.text === 'string' ? j.text : '', workspaceId: typeof j.workspaceId === 'string' ? j.workspaceId : '', sparc: j.sparc === true }
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

/** The request body for POST /v1/todo, or the message to show instead. The workspace is sent only when one was picked. */
export function newTodoPayload({ text, workspaceId, sparc } = {}) {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return { ok: false, message: 'Type the task first.' }
  if (t.length > TODO_MAX) return { ok: false, message: 'That is too long.' }
  const body = { text: t, sparc: !!sparc }
  if (workspaceId) body.workspaceId = workspaceId
  return { ok: true, body }
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
}

/** The message for a failed POST /v1/todo: friendly text for the codes the phone form can cause, else the desktop's own wording. */
export function todoErrorText(core, status, body) {
  const code = body && typeof body === 'object' ? body.error : undefined
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(FRIENDLY, code)) return FRIENDLY[code]
  return core.errorText(status, body)
}
