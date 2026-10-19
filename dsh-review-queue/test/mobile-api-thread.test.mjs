import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// The chat thread at the api layer (docs/mobile.md "Chat thread"): loading the newest page and earlier pages, the silent 5 s refresh, the
// optimistic follow-up bubble, and the polling rule. A fake fetch plays the hub; the DOM is a few fake objects.
globalThis.location = { pathname: '/review-queue/m/', hash: '#/item/i1' }
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
const handlers = { visibilitychange: [], pagehide: [] }
const fire = (type) => { for (const h of [...handlers[type]]) h() }
const listen = (type, fn) => { if (type in handlers) handlers[type].push(fn) }
globalThis.document = { hidden: false, addEventListener: listen }
globalThis.window = { addEventListener: listen }
const api = await import('../lib/mobile/api.js')
const { POLL_MS } = await import('../lib/mobile/thread.js')

const TOKEN = 'rqd_' + 'B'.repeat(43)
const core = {
  errorText: (status, body) => 'E' + status + ':' + (body && body.error),
  pruneSaved: (saved) => saved,
}
const msg = (id, role, text, extra = {}) => ({ id, role, text, ...extra })
const itemOf = (id = 'i1', over = {}) => ({ id, type: 'completed', sessionId: 's-' + id, sessionTitle: 'Title ' + id, summary: 'x', ...over })
const flush = () => new Promise((r) => setImmediate(r))

let calls, routes
/** routes: { '/v1/thread': (body, call) => ({ status, body }) | Promise, '/v1/post': ... }; a thrown error is a network failure. */
beforeEach(() => {
  api.stopThreadPolling()
  calls = []
  routes = {}
  store.clear()
  store.set('rq-m.token', TOKEN)
  globalThis.location.hash = '#/item/i1'
  globalThis.document.hidden = false
  api.setCoreForTests(core)
  api.set({ needsPairing: false, pairMessage: null, error: null, auth: false, errors: {}, busy: {}, replies: {}, threads: {}, snap: { open: [itemOf('i1')], resolved: [itemOf('r1', { type: 'question' })] } })
  globalThis.fetch = async (url, init = {}) => {
    const path = url.replace('/review-queue', '')
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    const entry = { url, path, method: init.method ?? 'GET', headers: init.headers ?? {}, body }
    calls.push(entry)
    const handler = routes[path]
    const r = handler ? await handler(body, entry) : { status: 200, body: { ok: true } }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.body }
  }
})
const thread = (id = 'i1') => api.state.threads[id]
const sentTo = (path) => calls.filter((c) => c.path === path)
const page = (messages, extra = {}) => ({ status: 200, body: { ok: true, sessionId: 's-i1', title: 'Title i1', messages, hasMore: false, ...(messages.length ? { cursor: messages[0].id } : {}), ...extra } })

// ---- loadThread -------------------------------------------------------------------------------------------------------------------

test('loadThread asks for the newest 40 with the device token and keeps the messages, the paging state and the session title', async () => {
  let during
  routes['/v1/thread'] = () => { during = { ...thread() }; return page([msg(3, 'user', 'hi'), msg(4, 'assistant', 'hello')], { hasMore: true }) }
  await api.loadThread('i1')
  assert.deepEqual(calls[0].body, { id: 'i1', limit: 40 })
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.authorization, 'Bearer ' + TOKEN)
  assert.equal(during.loading, true, 'the first load shows a loading state')
  const t = thread()
  assert.deepEqual(t.messages.map((m) => m.id), [3, 4])
  assert.deepEqual([t.hasMore, t.cursor, t.loading, t.error], [true, 3, false, null])
  assert.equal('loadedAt' in t, false, 'nothing reads a load time')
  assert.equal('sessionTitle' in t, false, 'the item has the title; the thread state does not copy it')
})

test('a failed load says why in words, shows no messages and can be retried', async () => {
  routes['/v1/thread'] = () => ({ status: 409, body: { ok: false, error: 'no-log' } })
  await api.loadThread('i1')
  assert.match(thread().error, /log/i)
  assert.deepEqual([thread().messages, thread().loading], [[], false])
  routes['/v1/thread'] = () => page([msg(1, 'user', 'back')])
  await api.loadThread('i1')
  assert.deepEqual([thread().error, thread().messages.length], [null, 1])
})

test('a timeout answer and an unknown code use the sentences of the thread errors', async () => {
  routes['/v1/thread'] = () => ({ status: 504, body: { ok: false, error: 'owner-timeout' } })
  await api.loadThread('i1')
  assert.match(thread().error, /try again/i)
  routes['/v1/thread'] = () => ({ status: 500, body: { ok: false, error: 'whatever' } })
  await api.loadThread('i1')
  assert.match(thread().error, /could not load/i)
})

test('a network failure on the first load is an error with a retry, marked offline', async () => {
  routes['/v1/thread'] = () => { throw new TypeError('Failed to fetch') }
  await api.loadThread('i1')
  assert.deepEqual([thread().loading, thread().offline], [false, true])
  assert.match(thread().error, /connection|offline/i)
})

test('an auth failure sends the phone back to pairing and shows no thread error', async () => {
  routes['/v1/thread'] = () => ({ status: 401, body: { error: 'auth-required' } })
  await api.loadThread('i1')
  assert.equal(api.state.needsPairing, true)
  assert.equal(thread().error, null)
  assert.equal(thread().loading, false)
})

test('loading again while a load is running does not send a second request', async () => {
  let release
  routes['/v1/thread'] = () => new Promise((r) => { release = () => r(page([msg(1, 'user', 'a')])) })
  const first = api.loadThread('i1')
  await flush()
  await api.loadThread('i1')
  release()
  await first
  assert.equal(sentTo('/v1/thread').length, 1)
})

test('opening a chat that was already loaded shows its messages at once and refreshes them without a loading state', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  let during
  routes['/v1/thread'] = () => { during = thread().loading; return page([msg(1, 'user', 'a'), msg(2, 'assistant', 'b')]) }
  await api.loadThread('i1')
  assert.equal(during, false)
  assert.deepEqual(thread().messages.map((m) => m.id), [1, 2])
})

// ---- loadEarlier ------------------------------------------------------------------------------------------------------------------

test('Load earlier asks for the page before the oldest message and puts it in front', async () => {
  routes['/v1/thread'] = () => page([msg(5, 'user', 'e'), msg(6, 'assistant', 'f')], { hasMore: true })
  await api.loadThread('i1')
  let during
  routes['/v1/thread'] = () => { during = thread().loadingEarlier; return page([msg(3, 'user', 'c'), msg(4, 'assistant', 'd')], { hasMore: false }) }
  await api.loadEarlier('i1')
  assert.deepEqual(sentTo('/v1/thread')[1].body, { id: 'i1', limit: 40, before: 5 })
  assert.equal(during, true)
  assert.deepEqual(thread().messages.map((m) => m.id), [3, 4, 5, 6])
  assert.deepEqual([thread().hasMore, thread().cursor, thread().loadingEarlier], [false, 3, false])
})

test('Load earlier does nothing without an earlier page or while one is loading', async () => {
  routes['/v1/thread'] = () => page([msg(5, 'user', 'e')], { hasMore: false })
  await api.loadThread('i1')
  await api.loadEarlier('i1')
  assert.equal(sentTo('/v1/thread').length, 1)
  await api.loadEarlier('nothing-loaded')
  assert.equal(sentTo('/v1/thread').length, 1)
})

test('a failed Load earlier keeps the messages and says why; the button stays for another try', async () => {
  routes['/v1/thread'] = () => page([msg(5, 'user', 'e')], { hasMore: true })
  await api.loadThread('i1')
  routes['/v1/thread'] = () => ({ status: 504, body: { ok: false, error: 'owner-away' } })
  await api.loadEarlier('i1')
  assert.deepEqual([thread().messages.length, thread().hasMore, thread().loadingEarlier], [1, true, false])
  assert.match(thread().error, /not answering/i)
})

// ---- refreshThread ----------------------------------------------------------------------------------------------------------------

test('a refresh is silent: no loading state, new messages are added, the older pages stay', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a'), msg(2, 'assistant', 'b')], { hasMore: true })
  await api.loadThread('i1')
  let during
  routes['/v1/thread'] = () => { during = [thread().loading, thread().loadingEarlier]; return page([msg(1, 'user', 'a'), msg(2, 'assistant', 'b'), msg(3, 'user', 'c')], { hasMore: true }) }
  await api.refreshThread('i1')
  assert.deepEqual(during, [false, false])
  assert.deepEqual(thread().messages.map((m) => m.id), [1, 2, 3])
})

test('a failed refresh keeps the messages and shows an offline note; the next good one clears it', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  routes['/v1/thread'] = () => { throw new TypeError('Failed to fetch') }
  await api.refreshThread('i1')
  assert.deepEqual(thread().messages.map((m) => m.id), [1])
  assert.equal(thread().offline, true)
  assert.match(thread().error, /connection|offline/i)
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a'), msg(2, 'assistant', 'b')])
  await api.refreshThread('i1')
  assert.deepEqual([thread().offline, thread().error, thread().messages.length], [false, null, 2])
})

test('a refresh the server refuses keeps the messages and keeps the reason as the note', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  routes['/v1/thread'] = () => ({ status: 409, body: { ok: false, error: 'owner-offline' } })
  await api.refreshThread('i1')
  assert.equal(thread().messages.length, 1)
  assert.match(thread().error, /not running/i)
  assert.equal(thread().offline, false)
})

test('two refreshes at the same time make one request', async () => {
  let release
  routes['/v1/thread'] = () => new Promise((r) => { release = () => r(page([msg(1, 'user', 'a')])) })
  const a = api.refreshThread('i1')
  const b = api.refreshThread('i1')
  await flush()
  release()
  await Promise.all([a, b])
  assert.equal(sentTo('/v1/thread').length, 1)
})

test('a refresh that finds an auth failure stops quietly: pairing screen, no error note', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  routes['/v1/thread'] = () => ({ status: 401, body: { error: 'auth-required' } })
  await api.refreshThread('i1')
  assert.equal(api.state.needsPairing, true)
  assert.equal(thread().error, null)
  assert.equal(thread().messages.length, 1)
})

// ---- postFollowUp -----------------------------------------------------------------------------------------------------------------

test('a follow-up goes to /v1/post trimmed, shows a pending bubble at once, and the draft is cleared when it was accepted', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done')])
  await api.loadThread('i1')
  api.set({ replies: { i1: '  please continue  ' } })
  let during
  routes['/v1/post'] = () => { during = { busy: api.state.busy.i1, messages: thread().messages.map((m) => [m.text, !!m.pending]) }; return { status: 200, body: { ok: true } } }
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done')]) // the log has not caught up yet
  const result = await api.postFollowUp('i1', '  please continue  ')
  assert.deepEqual(result, { ok: true })
  const sent = sentTo('/v1/post')[0].body
  assert.deepEqual({ id: sent.id, text: sent.text }, { id: 'i1', text: 'please continue' })
  assert.match(sent.key, /^[A-Za-z0-9_-]{1,64}$/, 'every post carries a client key')
  assert.equal(sentTo('/v1/post')[0].headers.authorization, 'Bearer ' + TOKEN)
  assert.deepEqual(during, { busy: true, messages: [['done', false], ['please continue', true]] })
  assert.equal(api.state.replies.i1, '')
  assert.equal(api.state.busy.i1, false)
  assert.equal(api.state.errors.i1, undefined)
})

test('after an accepted post the thread is refreshed at once and the bubble gives way to the logged message', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done')])
  await api.loadThread('i1')
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done'), msg(2, 'user', 'go on')])
  await api.postFollowUp('i1', 'go on')
  assert.equal(sentTo('/v1/thread').length, 2, 'a refresh followed the post')
  assert.deepEqual(thread().messages.map((m) => [m.id, !!m.pending]), [[1, false], [2, false]])
})

test('while the log has not caught up the sent bubble stays, marked sent, until a refresh shows the message', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done')])
  await api.loadThread('i1')
  await api.postFollowUp('i1', 'go on')
  const bubble = thread().messages.at(-1)
  assert.deepEqual([bubble.text, bubble.pending, bubble.sent], ['go on', true, true])
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done'), msg(2, 'user', 'go on')])
  await api.refreshThread('i1')
  assert.deepEqual(thread().messages.map((m) => !!m.pending), [false, false])
})

test('a queued prompt that reaches the log late: the sent bubble survives refreshes for ten minutes, and is given up after fifteen', async (t) => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done')])
  await api.loadThread('i1')
  await api.postFollowUp('i1', 'go on')
  now += 10 * 60_000
  await api.refreshThread('i1')
  assert.deepEqual(thread().messages.map((m) => [m.text, !!m.pending, !!m.sent]), [['done', false, false], ['go on', true, true]], 'still waiting for the log after ten minutes')
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done'), msg(2, 'user', 'go on')])
  await api.refreshThread('i1')
  assert.deepEqual(thread().messages.map((m) => !!m.pending), [false, false], 'the log message takes the bubble place')
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done'), msg(2, 'user', 'go on')])
  await api.postFollowUp('i1', 'never logged')
  now += 15 * 60_000 + 1000
  await api.refreshThread('i1')
  assert.deepEqual(thread().messages.map((m) => m.text), ['done', 'go on'], 'a bubble the log never showed is given up after fifteen minutes')
})

test('a failed post removes the bubble, keeps the draft and says why in words; the screen is not left', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done')])
  await api.loadThread('i1')
  api.set({ replies: { i1: 'my draft' } })
  routes['/v1/post'] = () => ({ status: 409, body: { ok: false, error: 'no-controller' } })
  const result = await api.postFollowUp('i1', 'my draft')
  assert.deepEqual(result, { ok: false })
  assert.deepEqual(thread().messages.map((m) => m.id), [1])
  assert.equal(api.state.replies.i1, 'my draft')
  assert.equal(api.state.errors.i1, 'E409:no-controller')
  assert.equal(api.state.busy.i1, false)
  assert.equal(location.hash, '#/item/i1')
  assert.equal(sentTo('/v1/thread').length, 1, 'no refresh after a failure')
})

test('the errors that are only meaningful for a chat get their own sentences', async () => {
  routes['/v1/post'] = () => ({ status: 409, body: { ok: false, error: 'not-a-session' } })
  await api.postFollowUp('i1', 'x')
  assert.match(api.state.errors.i1, /not a session/i)
})

test('a network failure of the post is reported and keeps the draft', async () => {
  api.set({ replies: { i1: 'keep me' } })
  routes['/v1/post'] = () => { throw new TypeError('Failed to fetch') }
  assert.deepEqual(await api.postFollowUp('i1', 'keep me'), { ok: false })
  assert.match(api.state.errors.i1, /Request failed/)
  assert.equal(api.state.replies.i1, 'keep me')
})

test('an auth failure on a post sends the phone back to pairing and keeps the draft', async () => {
  api.set({ replies: { i1: 'keep me' } })
  routes['/v1/post'] = () => ({ status: 401, body: { error: 'auth-required' } })
  await api.postFollowUp('i1', 'keep me')
  assert.equal(api.state.needsPairing, true)
  assert.equal(api.state.replies.i1, 'keep me')
  assert.match(api.state.errors.i1, /pair this phone again/i)
})

test('an empty or blank follow-up sends nothing', async () => {
  for (const text of ['', '   \n ', undefined]) assert.deepEqual(await api.postFollowUp('i1', text), { ok: false })
  assert.deepEqual(calls, [])
})

test('a second tap while the first post is in flight sends nothing', async () => {
  let release
  routes['/v1/post'] = () => new Promise((r) => { release = () => r({ status: 200, body: { ok: true } }) })
  const first = api.postFollowUp('i1', 'once')
  await flush()
  assert.deepEqual(await api.postFollowUp('i1', 'once'), { ok: false })
  release()
  assert.deepEqual(await first, { ok: true })
  assert.equal(sentTo('/v1/post').length, 1)
  assert.equal(thread().messages.filter((m) => m.pending).length <= 1, true)
})

// ---- the idempotency key of a post (docs/mobile.md "Chat thread") ---------------------------------------------------------------------

const keysOf = () => sentTo('/v1/post').map((c) => c.body.key)

test('a retry of the same text after an error reuses the key of the first attempt, so a post that did arrive is not sent twice', async () => {
  routes['/v1/post'] = () => { throw new TypeError('Failed to fetch') }
  await api.postFollowUp('i1', 'retry me K1')
  routes['/v1/post'] = () => ({ status: 409, body: { ok: false, error: 'post-failed' } })
  await api.postFollowUp('i1', '  retry me K1  ')
  routes['/v1/post'] = () => ({ status: 200, body: { ok: true } })
  await api.postFollowUp('i1', 'retry me K1')
  const keys = keysOf()
  assert.equal(keys.length, 3)
  assert.match(keys[0], /^[A-Za-z0-9_-]{1,64}$/)
  assert.equal(new Set(keys).size, 1, 'one key for the three attempts')
})

test('a different text gets a new key, and so does the same text again after it was accepted', async () => {
  routes['/v1/post'] = () => ({ status: 409, body: { ok: false, error: 'no-controller' } })
  await api.postFollowUp('i1', 'first text K3')
  await api.postFollowUp('i1', 'edited text K3')
  routes['/v1/post'] = () => ({ status: 200, body: { ok: true } })
  await api.postFollowUp('i1', 'edited text K3')
  await api.postFollowUp('i1', 'edited text K3')
  const keys = keysOf()
  assert.equal(keys.length, 4)
  assert.notEqual(keys[0], keys[1], 'the text changed')
  assert.equal(keys[1], keys[2], 'the retry of the edited text')
  assert.notEqual(keys[2], keys[3], 'accepted once: the next message is a new one')
})

test('the key of one item is not used for another', async () => {
  routes['/v1/post'] = () => ({ status: 409, body: { ok: false, error: 'no-controller' } })
  await api.postFollowUp('i1', 'same words K4')
  await api.postFollowUp('r1', 'same words K4')
  const keys = keysOf()
  assert.notEqual(keys[0], keys[1])
})

test('nothing in the api layer logs message text', async (t) => {
  const lines = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, m, (...a) => { lines.push(a.join(' ')) })
  routes['/v1/thread'] = () => page([msg(1, 'user', 'SECRET-TEXT')])
  routes['/v1/post'] = () => ({ status: 409, body: { ok: false, error: 'no-controller' } })
  await api.loadThread('i1')
  await api.postFollowUp('i1', 'SECRET-TEXT 2')
  assert.deepEqual(lines, [])
})

// ---- polling ----------------------------------------------------------------------------------------------------------------------

test('the open chat is refreshed every 5 seconds, one request at a time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  api.startThreadPolling('i1')
  assert.equal(sentTo('/v1/thread').length, 0, 'the screen loads the first page itself')
  t.mock.timers.tick(POLL_MS - 1)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 0)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 1)
  t.mock.timers.tick(POLL_MS)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 2)
  api.stopThreadPolling()
})

test('a slow refresh is never overlapped: the next one is timed from the end of the last', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  routes['/v1/thread'] = () => new Promise((r) => { release = () => r(page([msg(1, 'user', 'a')])) })
  api.startThreadPolling('i1')
  t.mock.timers.tick(POLL_MS)
  await flush()
  t.mock.timers.tick(POLL_MS * 3)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 1)
  release()
  await flush()
  t.mock.timers.tick(POLL_MS)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 2)
  api.stopThreadPolling()
  release() // the request that is still open must not leak into the next test
  await flush()
})

test('stopping the polling (leaving the screen) cancels the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  api.startThreadPolling('i1')
  api.stopThreadPolling()
  t.mock.timers.tick(POLL_MS * 4)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 0)
})

test('polling stops by itself when the route is no longer the item screen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  api.startThreadPolling('i1')
  globalThis.location.hash = '#/resolved'
  t.mock.timers.tick(POLL_MS * 3)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 0)
})

test('polling does not run for an item that has no session or is a todo', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  api.set({ snap: { open: [itemOf('i1', { type: 'todo' })], resolved: [] } })
  api.startThreadPolling('i1')
  t.mock.timers.tick(POLL_MS * 2)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 0)
})

test('a hidden page stops polling; becoming visible refreshes at once and goes on every 5 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  api.startThreadPolling('i1')
  globalThis.document.hidden = true
  fire('visibilitychange')
  t.mock.timers.tick(POLL_MS * 3)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 0, 'nothing while hidden')
  globalThis.document.hidden = false
  fire('visibilitychange')
  await flush()
  assert.equal(sentTo('/v1/thread').length, 1, 'immediate refresh')
  t.mock.timers.tick(POLL_MS)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 2)
  api.stopThreadPolling()
})

test('pagehide stops the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  api.startThreadPolling('i1')
  fire('pagehide')
  t.mock.timers.tick(POLL_MS * 2)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 0)
})

test('the pairing screen stops the polling: nothing is asked while the phone is not paired', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  api.startThreadPolling('i1')
  api.set({ needsPairing: true })
  t.mock.timers.tick(POLL_MS * 3)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 0)
})

test('starting the polling again does not stack timers or listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  const before = handlers.visibilitychange.length
  api.startThreadPolling('i1')
  api.startThreadPolling('i1')
  api.startThreadPolling('i1')
  assert.ok(handlers.visibilitychange.length <= Math.max(before, 1))
  t.mock.timers.tick(POLL_MS)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 1)
  api.stopThreadPolling()
})

test('a poll that fails keeps the timer running (the next try is in 5 seconds)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = () => { throw new TypeError('Failed to fetch') }
  api.startThreadPolling('i1')
  t.mock.timers.tick(POLL_MS)
  await flush()
  t.mock.timers.tick(POLL_MS)
  await flush()
  assert.equal(sentTo('/v1/thread').length, 2)
  api.stopThreadPolling()
})

test('a draft typed while the follow-up was in flight is kept: only the posted text is cleared', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done')])
  await api.loadThread('i1')
  api.set({ replies: { i1: 'first part' } })
  routes['/v1/post'] = () => { api.set({ replies: { ...api.state.replies, i1: 'first part and more typed meanwhile' } }); return { status: 200, body: { ok: true } } }
  assert.deepEqual(await api.postFollowUp('i1', 'first part'), { ok: true })
  assert.equal(api.state.replies.i1, 'first part and more typed meanwhile')
  assert.equal(api.state.busy.i1, false)
})

test('a draft emptied by the user while the follow-up was in flight stays empty', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done')])
  await api.loadThread('i1')
  api.set({ replies: { i1: 'gone soon' } })
  routes['/v1/post'] = () => { api.set({ replies: { ...api.state.replies, i1: '' } }); return { status: 200, body: { ok: true } } }
  await api.postFollowUp('i1', 'gone soon')
  assert.equal(api.state.replies.i1, '')
})

test('a draft that differs from the posted text only by surrounding blanks is cleared', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done')])
  await api.loadThread('i1')
  api.set({ replies: { i1: 'same text ' } })
  await api.postFollowUp('i1', 'same text')
  assert.equal(api.state.replies.i1, '')
})
