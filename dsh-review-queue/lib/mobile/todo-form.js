/**
 * The phone's "+ New todo" form (route #/new): pure validation, payload and wording, the same rules as the desktop form
 * (core.todoFormProblem: empty, or more than 4000 characters) and the same API (POST /v1/todo { text, workspaceId?, sparc? }).
 * Node-tested; views.js stays thin.
 */

/** The longest task text the server takes. */
export const TODO_MAX = 4000

/** A fresh draft: no text, "Choose for me", SPARC off. The draft is kept in state while the user moves between screens. */
export const emptyTodoDraft = () => ({ text: '', workspaceId: '', sparc: false })

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
