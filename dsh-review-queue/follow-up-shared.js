/**
 * Constants and the one cleaner shared by the two halves of the Follow-up todo (docs/hub.md 6.4a): the app side (todo.js, todo-follow-up.js,
 * agent/executor.js) and the hub side (hub/follow-up.js). A tiny leaf module on purpose: it imports nothing, so the hub and the executor can use
 * it without pulling in the todo service, the speech text or the summariser. The old homes re-export these names.
 */
/** The longest todo text (and the longest text of a follow-up message). */
export const MAX_TODO = 4000
/** The longest description of the session a follow-up is for. */
export const MAX_QUERY = 300
/** The most sessions a hub or an app hands to a follow-up (the newest). */
export const SESSIONS_LIMIT = 60
/** The most sessions an app lists for a follow-up (todo-follow-up.js reads at most as many, and the model is given as many): all one number, the hub's. */
export const FOLLOW_UP_LIMIT = SESSIONS_LIMIT
/** The most candidates the model of the suggestion reads. */
export const MAX_CANDIDATES = SESSIONS_LIMIT
/**
 * The most time one app spends on its sessions-list answer (the session list, the titles and the snippets share this one deadline). The hub's
 * timeout for the command (hub/commands.js) must stay above it, or the hub gives an app up that was about to answer.
 */
export const SESSIONS_APP_BUDGET_MS = 4500
/** The warning on a follow-up whose send may have reached the session without the app learning of it (a timeout, an owner that never reported, a restart in the middle of it). */
export const MAY_HAVE_BEEN_SENT = 'May have been sent: check the session before retrying.'
/** How long a prompt call to the session controller may take (the Remote method requires a caller signal). */
export const PROMPT_TIMEOUT_MS = 30_000
/** The most follow-ups that may wait for a confirmation at once (open, state awaiting-confirm): one hub (hub/follow-up.js) and one app on its own (todo-follow-up.js). */
export const MAX_WAITING_FOLLOW_UPS = 10
/** The answer for a follow-up added while that many already wait for a confirmation (the same code on the hub and in a standalone app). */
export const TOO_MANY_FOLLOW_UPS = 'too-many-follow-ups'

/**
 * What a log line says about a failure: the error's code, else its name, else (a string given: an error code that came from another process) the string, cut to safe characters and
 * 40 of them. Never the message: it can carry a path or content. The one copy for the follow-up code; a thrown value that is not an Error and not a string is just 'error'.
 */
export const codeOf = (error) => String(typeof error === 'string' ? error : error?.code ?? error?.name ?? 'error').replace(/[^A-Za-z0-9_:. /-]/g, '?').slice(0, 40)

/**
 * A follow-up todo whose message was SENT: state 'started' (resolved followed-up) with the sessionId of the session it went to. Only this todo has a session of its own that the
 * phone's chat view may read and post to (hub/routing.js and service.js); a todo that is waiting, starting or failed, and every other kind of todo, has none yet. Here, in the leaf
 * module, so the hub bundle can ask without pulling in the todo service.
 */
export const isSentFollowUp = (item) => !!item && item.type === 'todo' && item.kind === 'followup' && item.state === 'started' && typeof item.sessionId === 'string' && item.sessionId !== ''
/** An open todo that waits for the user's confirm (the state a suggestion may still be written into). */
export const isAwaitingConfirm = (item) => item?.status === 'open' && item.state === 'awaiting-confirm'

/**
 * The session id rule of thread.js (isSessionId: SESSION_ID), copied here because thread.js pulls in the log reader and zstd, which the hub bundle must not load. A session id that
 * an app lists ends up in a prompt, a log path and a card, so one that breaks the rule is dropped. test/follow-up-shared.test.mjs keeps the two in step.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const MAX_FIELD = 200
const clip = (value) => value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) : value

/**
 * The sessions an app listed, as plain data: only the known fields with the right types (text cut to 200 characters), entries without a valid
 * session id (the rule of thread.js isSessionId) dropped. owner (when given) is set on every entry, whatever the app said. Never throws.
 */
export function cleanSessions(list, { owner } = {}) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const s of list) {
    if (!s || typeof s !== 'object' || typeof s.sessionId !== 'string' || !SESSION_ID.test(s.sessionId)) continue
    out.push({
      sessionId: s.sessionId,
      ...(typeof s.title === 'string' ? { title: clip(s.title) } : {}),
      ...(typeof s.workspaceId === 'string' && s.workspaceId ? { workspaceId: clip(s.workspaceId) } : {}),
      ...(typeof s.workspaceTitle === 'string' ? { workspaceTitle: clip(s.workspaceTitle) } : {}),
      ...(Number.isFinite(s.updatedAt) ? { updatedAt: s.updatedAt } : {}),
      ...(typeof s.running === 'boolean' ? { running: s.running } : {}),
      ...(typeof s.snippet === 'string' ? { snippet: clip(s.snippet) } : {}),
      ...(owner === undefined ? {} : { owner }),
    })
  }
  return out
}

/** The reason of the deterministic ticket / PR number match: the mark the cards trust (a model that writes it as its reason does not get it). */
export const REF_REASON = 'ticket or PR number in the words'
const NUMBER_WITH_KEYWORD = /(?<![A-Za-z])(?:AB#|PR\s*#?|pull\s+request\s*#?|work\s+item\s*#?|ticket\s*#?)\s*(\d{1,9})(?!\d)|#\s*(\d{1,9})(?!\d)/gi
/**
 * The number as a whole number of the title: not part of a longer digit run, and not glued to another number by - . / : either (a date 2026-10-20, a version 1.10.3, a time 10:30 or
 * a decimal 2.5 holds numbers that are not tickets). A ticket form ("... - 25757", "AB#25757", "PR 6556", "#12", "bug-12", "PR 6556.") has none of these.
 */
const hasWholeNumber = (title, number) => new RegExp('(?<!\\d)(?<!\\d[-./:])' + number + '(?!\\d)(?![-./:]\\d)').test(title)
/** The KEYWORDED ticket / PR numbers of the words (AB#n, #n, ticket n, PR n, pull request n, work item n; a bare number does not count), once each. */
export const refNumbersOf = (query) => new Set(typeof query === 'string' ? [...query.matchAll(NUMBER_WITH_KEYWORD)].map((m) => m[1] ?? m[2]) : [])

/**
 * Deterministic pick: the KEYWORDED ticket / PR numbers in the words that appear as a whole number in exactly one candidate title. One session among them is the pick; none, or two
 * different sessions, is no pick (a number found in several titles is ignored). Here, in the leaf module, so the hub can decide before it asks the apps for their snippets.
 * @returns {{ sessionId: string, title: string, reason: string } | undefined}
 */
export function suggestSessionByRef(query, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return undefined
  const picked = new Map()
  for (const number of refNumbersOf(query)) {
    const hits = candidates.filter((c) => typeof c?.title === 'string' && hasWholeNumber(c.title, number))
    if (hits.length === 1) picked.set(hits[0].sessionId, hits[0])
  }
  if (picked.size !== 1) return undefined
  const [hit] = picked.values()
  return { sessionId: hit.sessionId, title: hit.title, reason: REF_REASON }
}
