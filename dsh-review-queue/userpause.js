/**
 * Helpers on the running top-level sessions of this app, shared by the session count (sessions.js) and the running-sessions
 * route (service.js). (The old "Pause all and quit" button and its paused-by-user record are gone: a normal quit leaves logs
 * that the paused scan in paused.js finds by itself.)
 */

/** A session of the user's own (not a subagent or a child session): the ones the session count is about. */
export const isTopLevel = (i) => !i?.parentSessionId && i?.origin !== 'subagent'

/** The running top-level sessions of this app (no subagent or child sessions), from the session controller; throws when the list call fails. */
export async function listRunningSessions(controller, timeoutMs = 15_000) {
  const listed = await controller.list({}, AbortSignal.timeout(timeoutMs))
  return (listed?.items ?? []).filter((i) => i?.running === true && isTopLevel(i))
}
