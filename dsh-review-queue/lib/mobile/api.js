/**
 * Phone page state: the snapshot (long-poll, same API as the desktop overlay), unsent drafts, and the actions. A tiny observable
 * store: views subscribe through useStore (views.js). Behind the hub every call carries the device token (Authorization: Bearer, kept in
 * localStorage by pair()); a hub that answers auth-required sends the phone back to the pairing screen (needsPairing). Without a token
 * the calls are as before (the DSH cookie, when the page is served by the app itself).
 */
import { TOKEN_KEY, authFailureText, hubBase, isAuthFailure, pairBody, pairErrorText, withAuth } from './auth.js'
import { loadCore } from './core.js'
import { normalizeSettings } from './push-client.js'
import { pollWaitMs } from './model.js'
import { bindDraftFlush, dropStaleEffort, dropStaleWorkspace, emptyTodoDraft, loadTodoDraft, saveTodoDraft } from './todo-form.js'
import { detailOpen, loadToggles, pruneToggles, saveToggles, setDetail } from './toggles.js'
import {
  POST_TIMEOUT_MS, THREAD_TIMEOUT_MS, applyEarlier, applyNewest, expirePending, markSent, mergeMessages, pendingMessage, pollDelay, postErrorText, postKeyFor, postPayload, removeMessage,
  sameThread, shouldPoll, threadErrorText, threadPayload, touchThreads, trimThread,
} from './thread.js'

/** The plugin prefix on this host ("/review-queue", or behind a public URL prefix). */
export const API = location.pathname.replace(/\/m\/.*$/, '')
const WAIT_MS = 20000
const LS_SAVED = 'rq-m.saved'
const LS_FILTER = 'rq-m.filter'
const LS_PUSH = 'rq-m.push'
const LS_DEVICE = 'rq-m.device'

let core
export const getCore = () => core

const storage = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}

export const state = {
  ready: false, snap: null, error: null, auth: false, needsPairing: false, pairMessage: null, skew: 0,
  drafts: {}, replies: {}, busy: {}, errors: {}, filter: { type: 'all', query: '' }, version: 0,
  // The "+ New todo" form: the draft survives moving between screens, a reload and a crash (saved on every change, cleared after a successful start); the workspace dropdown's list.
  todoDraft: loadTodoDraft(storage), workspaces: null, workspacesError: null, efforts: null, followSessions: null, followSessionsError: null,
  // The chat thread of each session item that was opened: { messages, hasMore, cursor, loading, loadingEarlier, error, offline }.
  threads: {},
  // The open/closed choice of the details sections (conversation, full reply, late answer) per item: kept across screens, reloads and restarts (toggles.js).
  toggles: loadToggles(storage),
}
const listeners = new Set()
export const subscribe = (l) => { listeners.add(l); return () => { listeners.delete(l) } }
let saveTimer
export function set(patch) {
  Object.assign(state, patch)
  state.version++
  if ('drafts' in patch || 'replies' in patch) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300) }
  if ('filter' in patch) storage.set(LS_FILTER, JSON.stringify(state.filter))
  if ('todoDraft' in patch) saveTodoDraft(storage, state.todoDraft) // at once, no timer: a crash right after a keystroke loses nothing
  if ('toggles' in patch) saveToggles(storage, state.toggles)
  for (const l of [...listeners]) l()
}
/** Writes the drafts to the page storage now (the page is going away: the 300 ms timer of set() may never run). */
export function saveNow() { clearTimeout(saveTimer); save() }
function save() {
  const keep = core.pruneSaved({ drafts: state.drafts, replies: state.replies }, { open: Object.keys({ ...state.drafts, ...state.replies }).map((id) => ({ id })), resolved: [] })
  storage.set(LS_SAVED, JSON.stringify(keep))
}
function load() {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  try { const j = JSON.parse(storage.get(LS_SAVED) || 'null'); state.drafts = obj(j && j.drafts); state.replies = obj(j && j.replies) } catch { /* none */ }
  try { const f = JSON.parse(storage.get(LS_FILTER) || 'null'); if (f && typeof f.type === 'string') state.filter = { type: f.type, query: typeof f.query === 'string' ? f.query : '' } } catch { /* none */ }
}

let current
let stopped = false
/** The device token of this phone, or null (never paired, or signed out). */
export const getToken = () => storage.get(TOKEN_KEY)
/** A request with the token (when there is one) and the cookie. */
const call = (url, init) => fetch(url, withAuth({ credentials: 'same-origin', ...init }, getToken()))

/** Forgets the token and shows the pairing screen. */
function forgetPairing(message) {
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* private mode */ }
  set({ needsPairing: true, pairMessage: message, error: null })
  if (current) current.abort()
}
/** Called with every answer: true when the hub said this phone is not (or no longer) paired, after the phone was sent back to pairing. */
export function handleAuthFailure(status, body) {
  if (!isAuthFailure(status, body)) return false
  forgetPairing(authFailureText(getToken() !== null))
  return true
}
/** Forget this phone's pairing locally (it stays in the desktop list until it is revoked there). */
export function signOut() { forgetPairing(authFailureText(false)) }

/** Pairs this phone: the code from the desktop and a name go to the hub's public route; the token in the answer is kept. { ok } or { ok: false, message }. */
export async function pair(code, name) {
  let res
  try { res = await fetch(hubBase(API) + '/hub/v1/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pairBody(code, name)) }) } catch { return { ok: false, message: pairErrorText(0) } }
  const body = await res.json().catch(() => null)
  if (!res.ok || !body || typeof body.token !== 'string') return { ok: false, message: pairErrorText(res.status, body, res.headers && res.headers.get && res.headers.get('retry-after')) }
  storage.set(TOKEN_KEY, body.token)
  set({ needsPairing: false, pairMessage: null, error: null, auth: false })
  if (current) current.abort() // the poll starts again with the token
  return { ok: true }
}

let polling = false
async function pollLoop() {
  if (polling) return
  polling = true
  let since
  let fails = 0
  while (!stopped) {
    if (state.needsPairing) { await new Promise((r) => setTimeout(r, 500)); continue } // nothing to ask until the phone is paired again
    const ac = new AbortController()
    current = ac
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; ac.abort() }, WAIT_MS + 15000) // also covers wait=0 (a hung connection)
    try {
      const url = API + '/v1/snapshot?wait=' + pollWaitMs(state, WAIT_MS) + '&client=phone' + (since ? '&since=' + encodeURIComponent(since) : '')
      const res = await call(url, { signal: ac.signal })
      if (res.status === 401 && handleAuthFailure(401, await res.clone().json().catch(() => null))) continue
      if (res.status === 401 || res.status === 403) { set({ auth: true, error: 'Not signed in (HTTP ' + res.status + '). Sign in to DSH in this browser, then reload.' }); await new Promise((r) => setTimeout(r, 5000)); continue }
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = await res.json()
      fails = 0
      if (body.unchanged) { if (state.error || state.auth) set({ error: null, auth: false }); continue }
      since = core.sinceOf(body)
      const kept = core.pruneSaved({ drafts: state.drafts, replies: state.replies }, body)
      const gone = Object.keys(state.drafts).some((k) => !(k in kept.drafts)) || Object.keys(state.replies).some((k) => !(k in kept.replies))
      const toggles = pruneToggles(state.toggles, body) // the choices of items that left the queue go; the same object when none did
      set({ snap: body, error: null, auth: false, ready: true, skew: (body.serverNow || Date.now()) - Date.now(), ...(gone ? kept : {}), ...(toggles !== state.toggles ? { toggles } : {}) })
    } catch (e) {
      if (e && e.name === 'AbortError' && !timedOut) continue // the page woke up or came back online: ask again at once
      fails++
      if (!stopped) set({ error: 'Coding Boss Review Queue unreachable (' + String((e && e.message) || e) + '). Retrying…' })
      await new Promise((r) => setTimeout(r, Math.min(10000, 1000 * fails)))
    } finally { clearTimeout(timeout) }
  }
  polling = false
}

/** The user opened or closed a details section: remembered only when that differs from what is shown now (fallback = its default), so the echo of a controlled <details> changes nothing. */
export function rememberDetail(itemId, kind, open, fallback) {
  if (open === detailOpen(state.toggles, itemId, kind, fallback)) return
  set({ toggles: setDetail(state.toggles, itemId, kind, open) })
}

/** Posts an action; true on success, else the card shows the error text. */
export async function act(path, body, id) {
  set({ busy: { ...state.busy, [id]: true }, errors: { ...state.errors, [id]: undefined } })
  let error
  try {
    const res = await call(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) { const j = await res.json().catch(() => ({})); error = handleAuthFailure(res.status, j) ? 'Signed out: pair this phone again.' : core.errorText(res.status, j) }
  } catch (e) { error = 'Request failed: ' + String((e && e.message) || e) }
  set({ busy: { ...state.busy, [id]: false }, errors: { ...state.errors, [id]: error } })
  return !error
}

/** Loads the workspaces for the todo dropdowns (GET /v1/workspaces); the list or the failure goes to state, the form offers a reload. */
export async function loadWorkspaces() {
  set({ workspacesError: null })
  try {
    const res = await call(API + '/v1/workspaces')
    const body = await res.json().catch(() => null)
    if (handleAuthFailure(res.status, body)) return
    if (!res.ok) { set({ workspacesError: core.errorText(res.status, body || {}) }); return }
    const workspaces = Array.isArray(body && body.workspaces) ? body.workspaces : []
    const draft = dropStaleWorkspace(state.todoDraft, workspaces) // a restored draft may name a workspace that is gone
    set({ workspaces, workspacesError: null, ...(draft !== state.todoDraft ? { todoDraft: draft } : {}) })
  } catch (e) { set({ workspacesError: 'Request failed: ' + String((e && e.message) || e) }) }
}

/** Loads the efforts of the default model for the form's Effort dropdown (GET /v1/model-efforts, answered by the hub); best effort: without them the form has no dropdown. A draft effort the model no longer has is dropped. */
export async function loadEfforts() {
  try {
    const res = await call(API + '/v1/model-efforts')
    const body = await res.json().catch(() => null)
    if (handleAuthFailure(res.status, body)) return
    if (!res.ok || !body || !Array.isArray(body.efforts)) return
    const draft = dropStaleEffort(state.todoDraft, body)
    set({ efforts: body, ...(draft !== state.todoDraft ? { todoDraft: draft } : {}) })
  } catch { /* keep what we have */ }
}

/** The sessions of the Follow up dropdown (GET /v1/follow-up-sessions: sessionId, title, workspaceTitle?, running?); asked again each time the mode is shown. A picked session that is gone is dropped from the draft. */
export async function loadFollowSessions() {
  try {
    const res = await call(API + '/v1/follow-up-sessions')
    const body = await res.json().catch(() => null)
    if (handleAuthFailure(res.status, body)) return
    if (!res.ok || !body || !Array.isArray(body.sessions)) { set({ followSessionsError: 'Could not load the sessions. Reopen the form to try again.' }); return }
    const list = body.sessions.filter((x) => x && typeof x.sessionId === 'string')
    const draft = state.todoDraft
    set({ followSessions: list, followSessionsError: null, ...(list.length && draft.followUp && !list.some((x) => x.sessionId === draft.followUp) ? { todoDraft: { ...draft, followUp: '' } } : {}) })
  } catch { set({ followSessionsError: 'Could not load the sessions. Reopen the form to try again.' }) }
}

/** The unsent "+ New todo" form is thrown away, in state and on disk (after a successful start). */
export const clearTodoDraft = () => set({ todoDraft: emptyTodoDraft() }) // set() writes the saved draft at once

/** Id under which the "+ New todo" form keeps its busy flag and error in state. */
export const NEW_TODO_ID = 'new-todo'

/**
 * Starts a todo (POST /v1/todo; the body comes from newTodoPayload). { ok: true } clears the draft; a failure answers { ok: false, status, body }
 * so the form words the error itself (todoErrorText), and an auth failure sends the phone back to pairing.
 */
export async function startTodo(body) {
  set({ busy: { ...state.busy, [NEW_TODO_ID]: true } })
  let failure
  try {
    const res = await call(API + '/v1/todo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) { const j = await res.json().catch(() => ({})); failure = handleAuthFailure(res.status, j) ? { status: 0, body: null, text: 'Signed out: pair this phone again.' } : { status: res.status, body: j } }
  } catch (e) { failure = { status: 0, body: null, text: 'Request failed: ' + String((e && e.message) || e) } }
  set({ busy: { ...state.busy, [NEW_TODO_ID]: false } })
  if (failure) return { ok: false, ...failure }
  clearTodoDraft()
  return { ok: true }
}

// ---- chat thread (docs/mobile.md "Chat thread"): the past conversation of a session item, follow-up posts, the 5 s refresh -----------
// Nothing here logs: message text never leaves state (the views) and the requests.

const emptyThread = () => ({ messages: [], hasMore: false, cursor: undefined, loading: false, loadingEarlier: false, error: null, offline: false })
const threadOf = (id) => state.threads[id] || emptyThread()
/** Merges the patch into the thread; when the result looks the same to the view (messages by object, paging, flags) nothing is set and nothing renders. True when the state changed. */
function setThread(id, patch) {
  const next = { ...threadOf(id), ...patch }
  if (state.threads[id] && sameThread(state.threads[id], next)) return false
  set({ threads: { ...state.threads, [id]: next } })
  return true
}
const hasLoaded = (id) => threadOf(id).messages.some((m) => !m.pending)
/** The id of the newest message of the log that the thread shows (a pending bubble is not in the log), or undefined. */
const newestShown = (id) => threadOf(id).messages.filter((m) => !m.pending).at(-1)?.id

// Thread requests in flight: cut off after THREAD_TIMEOUT_MS, and aborted when the page goes away or the phone comes back online (the connection they
// were started on is dead or stale, like the snapshot long-poll above): a hung request would otherwise hold the "reading" guard for good.
const inflight = new Set()
const abortThreadFetches = () => { for (const ac of [...inflight]) ac.abort() }
let hooked = false
function hookPage() {
  if (hooked || typeof document === 'undefined' || typeof window === 'undefined') return
  hooked = true
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) abortThreadFetches()
    if (poll.id === null) return
    clearPollTimer()
    if (!document.hidden) pollTick() // back on screen: refresh at once, then at the poll pace
  })
  window.addEventListener('pagehide', () => { abortThreadFetches(); clearPollTimer() })
  window.addEventListener('online', abortThreadFetches)
}

/** POST /v1/thread. { page } on success; { unchanged: true } for the answer to `after`; { auth: true } when the phone was sent back to pairing; { aborted: true } when the page cut it off; else { error: words, offline }. */
async function threadRequest(body) {
  hookPage()
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ac.abort() }, THREAD_TIMEOUT_MS)
  inflight.add(ac)
  try {
    const res = await call(API + '/v1/thread', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal })
    const json = await res.json().catch(() => null)
    if (handleAuthFailure(res.status, json)) return { auth: true }
    if (res.ok && json && json.ok !== false && json.unchanged === true) return { unchanged: true }
    if (res.ok && json && json.ok !== false && Array.isArray(json.messages)) return { page: json }
    return { error: threadErrorText(json && json.error), offline: false }
  } catch {
    if (timedOut) return { error: threadErrorText('timeout'), offline: true }
    if (ac.signal.aborted) return { aborted: true }
    return { error: threadErrorText('offline'), offline: true }
  } finally { clearTimeout(timer); inflight.delete(ac) }
}
const settled = (id, page) => ({ ...applyNewest(threadOf(id), page), error: null, offline: false })

const reading = new Set() // item ids whose newest page is being read (a load or a refresh): one request at a time
const readingEarlier = new Set()
let opened = [] // the ids of the threads in state, the one opened last at the end

/** Remembers that this thread was opened and forgets the threads opened longest ago beyond the limit. */
function openThread(id) {
  const { order, evict } = touchThreads(opened.filter((k) => k in state.threads), id)
  opened = order
  if (!evict.length) return
  const keep = { ...state.threads }
  for (const k of evict) delete keep[k]
  set({ threads: keep })
}

/** Opens the chat of an item: the first load shows a loading state; a chat that is already loaded keeps its messages and refreshes silently. */
export async function loadThread(id) {
  openThread(id)
  if (reading.has(id)) return
  if (hasLoaded(id)) return refreshThread(id)
  reading.add(id)
  setThread(id, { loading: true, error: null, offline: false })
  try {
    const r = await threadRequest(threadPayload(id))
    if (r.page) setThread(id, { ...settled(id, r.page), loading: false })
    else if (r.aborted) setThread(id, { loading: false, error: threadErrorText('offline'), offline: true }) // the next refresh of the open screen fills it in
    else setThread(id, { loading: false, ...(r.auth ? {} : { error: r.error, offline: r.offline }) })
  } finally { reading.delete(id) }
}

/**
 * The refresh: no loading state; a failure keeps what is shown and only sets the note (error, offline). It asks with `after` (the newest message shown), so a log
 * with nothing new is answered without a page, and it changes no state when nothing changed.
 * @returns {Promise<'changed' | 'unchanged' | 'failed' | 'busy'>}
 */
export async function refreshThread(id) {
  if (reading.has(id)) return 'busy'
  reading.add(id)
  try {
    const r = await threadRequest(threadPayload(id, { after: newestShown(id) }))
    if (r.page) { const next = settled(id, r.page); return setThread(id, { ...next, messages: expirePending(next.messages, Date.now()) }) ? 'changed' : 'unchanged' }
    if (r.unchanged) return setThread(id, { messages: expirePending(threadOf(id).messages, Date.now()), error: null, offline: false }) ? 'changed' : 'unchanged'
    if (!r.auth && !r.aborted) setThread(id, { error: r.error, offline: r.offline })
    return 'failed'
  } finally { reading.delete(id) }
}

/** "Load earlier": the page before the oldest message shown, put in front of it. */
export async function loadEarlier(id) {
  const t = threadOf(id)
  if (!t.hasMore || t.cursor === undefined || readingEarlier.has(id)) return
  readingEarlier.add(id)
  setThread(id, { loadingEarlier: true })
  try {
    const r = await threadRequest(threadPayload(id, { before: t.cursor }))
    if (r.page) setThread(id, { ...applyEarlier(threadOf(id), r.page), loadingEarlier: false, error: null })
    else setThread(id, { loadingEarlier: false, ...(r.auth || r.aborted || r.unchanged ? {} : { error: r.error }) })
  } finally { readingEarlier.delete(id) }
}

/**
 * Sends a follow-up to the item's session (POST /v1/post): a pending bubble shows at once. Accepted: the draft (state.replies) is cleared when it still is the posted text (a newer draft stays), the
 * bubble waits (marked sent) until the log shows the message, and the thread is refreshed right away. Refused: the bubble goes, the draft stays and
 * state.errors[id] says why. A post in flight for the item ignores a second call; one that is not answered in POST_TIMEOUT_MS is given up (busy is released,
 * the error says it may have arrived). The screen is never left: only a done item changes state (on the server).
 * @returns {Promise<{ ok: boolean }>}
 */
export async function postFollowUp(id, text) {
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body || state.busy[id]) return { ok: false }
  const sending = postKeyFor(failedPosts.get(id), body)
  failedPosts.set(id, sending)
  const bubble = pendingMessage(body, Date.now())
  setThread(id, { messages: mergeMessages(threadOf(id).messages, [bubble]) })
  set({ busy: { ...state.busy, [id]: true }, errors: { ...state.errors, [id]: undefined } })
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ac.abort() }, POST_TIMEOUT_MS)
  let error
  try {
    const res = await call(API + '/v1/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(postPayload(id, body, sending.key)), signal: ac.signal })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      error = handleAuthFailure(res.status, j) ? 'Signed out: pair this phone again.' : postErrorText(j && j.error) || core.errorText(res.status, j)
    }
  } catch (e) { error = timedOut ? POST_TIMEOUT_TEXT : 'Request failed: ' + String((e && e.message) || e) } finally { clearTimeout(timer) }
  if (error) {
    setThread(id, { messages: removeMessage(threadOf(id).messages, bubble.id) })
    set({ busy: { ...state.busy, [id]: false }, errors: { ...state.errors, [id]: error } })
    return { ok: false }
  }
  failedPosts.delete(id) // accepted: the next message is a new one, with a new key
  setThread(id, { messages: markSent(threadOf(id).messages, bubble.id) })
  const typedSince = (state.replies[id] || '').trim() !== body // more typed (or the draft changed) while the post was in flight: keep it
  set({ replies: typedSince ? state.replies : { ...state.replies, [id]: '' }, busy: { ...state.busy, [id]: false } })
  if (poll.id === id) { poll.unchanged = 0; schedulePoll() } // the user is active: back to the 5 s pace
  await refreshThread(id)
  return { ok: true }
}
// item id -> { text, key } of the last post that was not accepted: a retry of that text reuses the key, so a post that did arrive is not sent twice (docs/mobile.md)
const failedPosts = new Map()
const POST_TIMEOUT_TEXT = 'No answer in time. The message may have been sent: check the conversation before sending it again.'

// The refresh timer: one timer at a time, timed from the end of the last refresh (never overlapping), only while the page is visible, the
// route is the item's screen, the item still has a session and the phone is paired. The item screen starts it and stops it when it goes.
const poll = { id: null, timer: null, unchanged: 0 } // unchanged: refreshes in a row that brought nothing new (they slow the pace, pollDelay)
const routeNow = () => (location.hash || '').replace(/^#/, '') || '/'
const pageVisible = () => typeof document === 'undefined' || !document.hidden
const findItem = (id) => (state.snap ? state.snap.open.find((i) => i.id === id) || state.snap.resolved.find((i) => i.id === id) : undefined)
const clearPollTimer = () => { if (poll.timer) { clearTimeout(poll.timer); poll.timer = null } }
const schedulePoll = () => { clearPollTimer(); if (poll.id !== null) poll.timer = setTimeout(pollTick, pollDelay(poll.unchanged)) }

async function pollTick() {
  poll.timer = null
  const id = poll.id
  if (id === null) return
  if (!shouldPoll({ route: routeNow(), visible: pageVisible(), item: findItem(id), paused: state.needsPairing })) {
    if (pageVisible()) poll.id = null // the screen is gone (or the phone must pair again): nothing more to refresh; a hidden page resumes when it is shown
    return
  }
  const result = await refreshThread(id)
  if (poll.id === id) {
    if (result === 'changed') poll.unchanged = 0
    else if (result === 'unchanged') poll.unchanged++
    schedulePoll()
  }
}

/** Starts the refresh of the open chat of this item (the screen loads the first page itself): every 5 s, slower while nothing changes. */
export function startThreadPolling(id) {
  hookPage()
  poll.id = id
  poll.unchanged = 0
  schedulePoll()
}
/**
 * Stops the refresh (the item screen was left) and trims that item's thread to its newest messages, so a chat that was read a long way back does not stay in
 * memory. With the id of another item than the polled one only that thread is trimmed and the refresh goes on.
 */
export function stopThreadPolling(id) {
  const target = id === undefined ? poll.id : id
  if (target === poll.id) { poll.id = null; poll.unchanged = 0; clearPollTimer() }
  if (target !== null && state.threads[target]) setThread(target, trimThread(state.threads[target]))
}

export async function init() {
  core = await loadCore()
  load()
  set({ ready: false })
  bindDraftFlush(window, document, () => saveTodoDraft(storage, state.todoDraft)) // the latest text once more when the page goes away or to the background
  document.addEventListener('visibilitychange', () => { if (!document.hidden && current) current.abort() }) // a phone that slept has a dead connection
  window.addEventListener('online', () => { if (current) current.abort() })
  window.addEventListener('offline', () => { if (current) current.abort() }) // a long-poll on a dead link would otherwise hide the outage for up to 20 s
  pollLoop()
}

// ---- web push (routes of the push slice: docs/mobile.md "Server") ------------------------------------------------------

async function pushRequest(method, path, body) {
  const init = { method }
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body) }
  const res = await call(API + '/v1/push' + path, init)
  const json = await res.json().catch(() => null)
  handleAuthFailure(res.status, json)
  if (!res.ok) throw new Error(((json && json.error) || 'request failed') + ' (HTTP ' + res.status + ')')
  return json || {}
}

/** The server's VAPID public key, base64url. */
export async function pushKey() {
  const { key } = await pushRequest('GET', '/key')
  if (typeof key !== 'string' || !key) throw new Error('The server sent no push key.')
  return key
}
/** Registers (or updates) this phone's push subscription; payload from buildSubscribePayload. Answers { device }. */
export const pushSubscribe = (payload) => pushRequest('POST', '/subscribe', payload)
/** Forgets a device: { endpoint } for this phone, { id } for one from the device list. */
export const pushUnsubscribe = (target) => pushRequest('POST', '/unsubscribe', target)
/** Sends a test notification to the device with this endpoint. */
export const pushTest = (endpoint) => pushRequest('POST', '/test', { endpoint })
/** Saves the device name, the per-type switches and the quiet hours of the device with this endpoint. */
export const pushSettings = (settings) => pushRequest('POST', '/settings', settings)
export async function pushDevices() {
  const { devices } = await pushRequest('GET', '/devices')
  return Array.isArray(devices) ? devices : []
}

/** This phone's push settings (kept locally; the server holds the copy it needs to decide what to send). */
export function getPushPrefs(tz) {
  let raw
  try { raw = JSON.parse(storage.get(LS_PUSH) || 'null') } catch { raw = null }
  return normalizeSettings(raw, tz)
}
export const setPushPrefs = (prefs) => storage.set(LS_PUSH, JSON.stringify(prefs))
/** The id the server gave this phone, to mark it in the device list. */
export const getDeviceId = () => storage.get(LS_DEVICE)
export function setDeviceId(id) { if (id) storage.set(LS_DEVICE, id); else try { localStorage.removeItem(LS_DEVICE) } catch { /* private mode */ } }

/** Tests give the module the card helpers without loading the overlay bundle. */
export function setCoreForTests(c) { core = c }
