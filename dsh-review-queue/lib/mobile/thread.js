/**
 * The pure part of the phone's chat view (docs/mobile.md "Chat thread"): merging pages and polls by message id, the optimistic bubble of a
 * follow-up that is on its way, the words of the errors, and the rules for when to poll and when to scroll. No DOM, no state, no network:
 * api.js owns the state and the requests, views.js the screen.
 */

/** A thread request is cut off after this long, a post after the longer one (the PC may be busy reading a log or queueing the prompt). */
export const THREAD_TIMEOUT_MS = 20_000
export const POST_TIMEOUT_MS = 40_000
/** Messages per page ("Load earlier" asks for the same size). */
export const PAGE_SIZE = 40
/** How often the open chat asks for the newest page. */
export const POLL_MS = 5000
/** The reader counts as "at the bottom" within this many pixels of the end. */
const NEAR_BOTTOM_PX = 80

const isPending = (message) => message.pending === true
const same = (a) => String(a && a.text).trim()
/** Two copies of a message that look the same on screen (the one that is shown is kept when the server sends an equal one). */
const sameMessage = (a, b) => a.id === b.id && a.role === b.role && a.text === b.text && a.time === b.time && a.truncated === b.truncated && a.pending === b.pending && a.sent === b.sent

/**
 * The messages of a thread after a page or a poll arrived: unique by id (the incoming copy wins, except that an equal one leaves the object already shown), ascending, and the local pending
 * messages (a follow-up that is not in the log yet) last, in the order they were typed. Inputs are not changed.
 */
export function mergeMessages(existing, incoming) {
  const byId = new Map()
  const pending = []
  for (const message of [...(existing || []), ...(incoming || [])]) {
    if (isPending(message)) { if (!pending.some((p) => p.id === message.id)) pending.push(message) } else {
      const known = byId.get(message.id)
      byId.set(message.id, known && sameMessage(known, message) ? known : message) // the object that is shown stays when nothing changed: the view skips it
    }
  }
  return [...[...byId.values()].sort((a, b) => a.id - b.id), ...pending]
}

let pendingSeq = 0
/** A local bubble for a follow-up that was just sent: the id cannot clash with a log id (those are numbers). */
export function pendingMessage(text, now) {
  return { id: 'p-' + ++pendingSeq, role: 'user', text, pending: true, time: now }
}

/**
 * Merges what the server sent and drops the pending bubbles it has caught up with: each NEW user message (an id not shown before)
 * whose text equals a pending bubble's text takes that bubble's place, one bubble per message.
 */
export function reconcile(existing, incoming) {
  const known = new Set((existing || []).filter((m) => !isPending(m)).map((m) => m.id))
  const arrived = (incoming || []).filter((m) => !known.has(m.id) && m.role === 'user').map(same)
  const kept = (existing || []).filter((m) => {
    if (!isPending(m)) return true
    const at = arrived.indexOf(same(m))
    if (at === -1) return true
    arrived.splice(at, 1)
    return false
  })
  return mergeMessages(kept, incoming)
}

/** The messages without the one with this id (a follow-up that failed to send). */
export const removeMessage = (messages, id) => (messages || []).filter((m) => m.id !== id)

/** The body of POST /v1/thread: the newest page, or the page before the message id `before`. `after` (newest page only): the id of the newest message already shown; the answer is then { ok: true, unchanged: true } when nothing is newer. */
export function threadPayload(id, { before, after } = {}) {
  return { id, limit: PAGE_SIZE, ...(before === undefined ? {} : { before }), ...(before === undefined && after !== undefined ? { after } : {}) }
}
/** The body of POST /v1/post; key is the idempotency key of the composed message (postKeyFor). */
export const postPayload = (id, text, key) => ({ id, text: String(text).trim(), ...(key === undefined ? {} : { key }) })
/** A random idempotency key (1 to 64 of letters, digits, _ and -; the server ignores any other): crypto.randomUUID, or a random string where it is missing (an insecure origin). */
export function newPostKey() {
  try { return globalThis.crypto.randomUUID() } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2) }
}
/**
 * The key to send for `text` given the entry kept for the item ({ text, key } of the last post that did not succeed, or undefined): the same text
 * is a retry of that message and keeps its key (the first attempt may have arrived although its answer did not), any other text is a new message.
 * @returns {{ text: string, key: string }}
 */
export const postKeyFor = (kept, text, make = newPostKey) => (kept && kept.text === text ? kept : { text, key: make() })

const THREAD_ERRORS = {
  'not-found': 'That item no longer exists.',
  'no-session': 'This item has no session to show.',
  'no-log': 'The log of this session is not on the PC any more, so its conversation cannot be shown.',
  'too-large': 'The log of this session is too big to show on the phone.',
  'no-zstd': 'The PC cannot read session logs (its Node has no zstd).',
  unreadable: 'The log of this session could not be read.',
  'no-reader': 'This app cannot read session logs.',
  'owner-offline': 'The DSH app of this session is not running, so the conversation cannot be loaded.',
  'owner-away': 'The DSH app of this session is not answering at the moment.',
  'owner-timeout': 'The DSH app did not answer in time. Try again.',
  'unknown-outcome': 'No answer came back. Try again.',
  'session-unavailable': 'That session is not available in any running DSH app, so its conversation cannot be loaded.',
  busy: 'The PC is busy reading other conversations. Try again in a moment.',
  offline: 'No connection: showing the last messages that were loaded.',
  timeout: 'The PC did not answer in time. Try again.',
}
const THREAD_GENERIC = 'Could not load the conversation.'
/** A sentence for the code of a failed thread request; any other code gets the generic one. */
export const threadErrorText = (code) => (typeof code === 'string' && Object.hasOwn(THREAD_ERRORS, code) ? THREAD_ERRORS[code] : THREAD_GENERIC)

const POST_ERRORS = {
  'not-a-session': 'This item is not a session, so nothing can be sent to it.',
  'no-session': 'That session is not running in this app any more, so the message was not sent.',
  'session-unavailable': 'That session is not available in any running DSH app, so the message was not sent.',
  'post-failed': 'The message could not be sent to the session. Try again.',
  paused: 'This session was paused by a restart. Resume it at the PC first.',
  onhold: 'This session is on hold. Continue it first (or release it), then write to it.',
  busy: 'A message to this session is already on its way. Wait for it, then try again.',
}
/** The sentence for a failed post whose code the shared errorText words poorly; undefined leaves it to the shared text. */
export const postErrorText = (code) => (typeof code === 'string' && Object.hasOwn(POST_ERRORS, code) ? POST_ERRORS[code] : undefined)

/** The conversation of an item can be read when it has a session (every type except a todo, which has none of its own; a paused item too). A follow-up todo that was sent has the session it went to, but the phone never reads or posts into it (hub/routing.js refuses both to a phone): its card only says where it was sent. */
export const hasThread = (item) => !!item && item.type !== 'todo' && typeof item.sessionId === 'string' && item.sessionId !== ''
/** A follow-up can be written to such an item, except a paused one (resuming it is done at the PC) and one on hold (Continue it first). */
export const canPost = (item) => hasThread(item) && item.type !== 'paused' && item.type !== 'onhold'

/** The chat polls only on the screen of such an item, while the page is visible and nothing (a pairing screen) pauses it. */
export function shouldPoll({ route, visible, item, paused }) {
  return /^\/item\/./.test(String(route)) && visible === true && !paused && hasThread(item)
}

/** Whether a scroll box is at (within a few pixels of) its end. */
export const isNearBottom = ({ scrollTop, clientHeight, scrollHeight }) => scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_PX

/**
 * What to do when `added` messages arrived: follow them to the bottom when the reader was near it (or just posted), otherwise leave the
 * scroll position alone and offer a "new messages" pill with the count.
 */
export function scrollPlan({ wasNearBottom, added, posted = false }) {
  if (!added) return { stick: false, pill: 0 }
  return wasNearBottom || posted ? { stick: true, pill: 0 } : { stick: false, pill: added }
}

// ---- applying a page or a poll to what is shown -----------------------------------------------------------------------------------

/**
 * How long a follow-up that was sent stays as a local bubble when the log never shows it (the bubble is then given up). A posted prompt is
 * queued, so the log shows it only when the queue drains, which can take many minutes behind a long turn.
 */
export const SENT_BUBBLE_MS = 15 * 60_000

/**
 * What the chat shows after the newest page (the first load, or a poll) arrived. `shown` is { messages, hasMore, cursor }, `page` the server's
 * answer. A poll keeps the older pages the reader loaded (and their cursor); when the page has nothing in common with what is shown and
 * there is more before it, so something may lie between, the page replaces it (Load earlier brings the rest back).
 */
export function applyNewest(shown, page) {
  const confirmed = shown.messages.filter((m) => !isPending(m))
  const overlaps = page.messages.some((m) => confirmed.some((c) => c.id === m.id))
  if (!confirmed.length || (!overlaps && page.messages.length && page.hasMore)) {
    return { messages: reconcile(shown.messages.filter(isPending), page.messages), hasMore: page.hasMore, cursor: page.cursor }
  }
  return { messages: reconcile(shown.messages, page.messages), hasMore: shown.hasMore, cursor: shown.cursor }
}

/** What the chat shows after "Load earlier" brought the page before the oldest message. */
export function applyEarlier(shown, page) {
  return { messages: mergeMessages(shown.messages, page.messages), hasMore: page.hasMore, cursor: page.cursor === undefined ? shown.cursor : page.cursor }
}

/** A pending bubble whose post was accepted: it waits for the log to show the message. */
export const markSent = (messages, id) => (messages || []).map((m) => (m.id === id ? { ...m, sent: true } : m))

/** Gives up the bubbles of sent follow-ups that the log never showed (a text the server stored differently). */
export function expirePending(messages, now, maxAgeMs = SENT_BUBBLE_MS) {
  const list = messages || []
  const kept = list.filter((m) => !(isPending(m) && m.sent && now - m.time > maxAgeMs))
  return kept.length === list.length ? list : kept // the same array when nothing was given up
}

// ---- keeping the screen still when nothing changed ----------------------------------------------------------------------------------------

/** Whether two thread states look the same to the view: the messages (by object), the paging, the loading flags and the error flags. */
export function sameThread(a, b) {
  return a.hasMore === b.hasMore && a.cursor === b.cursor && a.loading === b.loading && a.loadingEarlier === b.loadingEarlier && a.error === b.error && a.offline === b.offline
    && a.messages.length === b.messages.length && a.messages.every((m, i) => m === b.messages[i])
}

/** Whether a bubble has to be drawn again: another message object, or another minute (the age under it moves on). */
export const bubbleChanged = (prev, next) => prev.m !== next.m || prev.minute !== next.minute

// ---- the composer draft -------------------------------------------------------------------------------------------------------------------

/** Typing reaches the global state this long after the last keystroke. */
export const DRAFT_SAVE_MS = 250

/**
 * The text of the composer, kept out of the global state while it is typed: set() keeps the text here and writes it to the state (write) 250 ms after the
 * last call, flush() writes it at once (blur, page hide, send, leaving the screen), adopt() takes a change that came from outside (a post cleared the draft)
 * unless a write is waiting. read() gives the stored draft; nothing is written when it already is the text.
 */
export function createDraftBuffer({ read, write, delay = DRAFT_SAVE_MS }) {
  let value = read()
  let timer = null
  const cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null } }
  const flush = () => { cancel(); if (value !== read()) write(value) }
  return {
    value: () => value,
    set(text) { value = text; cancel(); timer = setTimeout(flush, delay) },
    flush,
    adopt(external) {
      if (timer !== null || external === value) return undefined
      value = external
      return external
    },
    dispose: flush,
  }
}

// ---- polling back-off, trimming, the thread limit -------------------------------------------------------------------------------------------

/** The wait before the next refresh: 5 s, 10 s after 3 answers in a row that brought nothing new, 20 s after 6. */
export const pollDelay = (unchanged) => (!Number.isFinite(unchanged) || unchanged < 3 ? POLL_MS : unchanged < 6 ? 2 * POLL_MS : 4 * POLL_MS)

/** At most this many threads stay in the phone's memory (the ones opened last). */
export const MAX_THREADS = 10

/**
 * A thread that was left keeps only its newest PAGE_SIZE messages (and the pending bubbles); Load earlier brings the rest back. The very same
 * object when there is nothing to cut.
 */
export function trimThread(thread, keep = PAGE_SIZE) {
  const confirmed = thread.messages.filter((m) => !isPending(m))
  if (confirmed.length <= keep) return thread
  const kept = confirmed.slice(-keep)
  return { ...thread, messages: [...kept, ...thread.messages.filter(isPending)], hasMore: true, cursor: kept[0].id }
}

/** The order of the opened threads (last opened last) after `id` was opened, and the ones to forget beyond `max`. */
export function touchThreads(order, id, max = MAX_THREADS) {
  const next = order.filter((x) => x !== id).concat(id)
  const evict = []
  while (next.length > max) evict.push(next.shift())
  return { order: next, evict }
}
