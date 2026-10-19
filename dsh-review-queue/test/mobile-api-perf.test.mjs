import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Review follow-up (performance) at the api layer of the phone's chat (docs/mobile.md "Chat thread"): no state change (and so no render) when a poll brings
// nothing new, the unchanged answer of the server, the poll back-off, timeouts and aborts that release the guards, the memory of the open threads.
globalThis.location = { pathname: '/review-queue/m/', hash: '#/item/i1' }
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
const handlers = { visibilitychange: [], pagehide: [], online: [] }
const fire = (type) => { for (const h of [...handlers[type]]) h() }
const listen = (type, fn) => { if (type in handlers) handlers[type].push(fn) }
globalThis.document = { hidden: false, addEventListener: listen }
globalThis.window = { addEventListener: listen }
const api = await import('../lib/mobile/api.js')
const { POLL_MS, THREAD_TIMEOUT_MS, POST_TIMEOUT_MS, MAX_THREADS } = await import('../lib/mobile/thread.js')

const TOKEN = 'rqd_' + 'B'.repeat(43)
const core = { errorText: (status, body) => 'E' + status + ':' + (body && body.error), pruneSaved: (saved) => saved }
const msg = (id, role, text, extra = {}) => ({ id, role, text, ...extra })
const itemOf = (id = 'i1', over = {}) => ({ id, type: 'completed', sessionId: 's-' + id, sessionTitle: 'Title ' + id, summary: 'x', ...over })
const flush = () => new Promise((r) => setImmediate(r))
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })

let calls, routes
beforeEach(() => {
  api.stopThreadPolling()
  calls = []
  routes = {}
  store.clear()
  store.set('rq-m.token', TOKEN)
  globalThis.location.hash = '#/item/i1'
  globalThis.document.hidden = false
  api.setCoreForTests(core)
  api.set({ needsPairing: false, pairMessage: null, error: null, auth: false, errors: {}, busy: {}, replies: {}, threads: {}, snap: { open: [itemOf('i1')], resolved: [] } })
  // A fetch that honours its abort signal, like the real one: a route that never answers stays open until it is aborted.
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const path = url.replace('/review-queue', '')
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    const entry = { url, path, method: init.method ?? 'GET', body, signal: init.signal }
    calls.push(entry)
    if (init.signal) {
      if (init.signal.aborted) return reject(abortError())
      init.signal.addEventListener('abort', () => reject(abortError()), { once: true })
    }
    Promise.resolve().then(async () => {
      const handler = routes[path]
      const r = handler ? await handler(body, entry) : { status: 200, body: { ok: true } }
      resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.body })
    }).catch(reject)
  })
})
const thread = (id = 'i1') => api.state.threads[id]
const sentTo = (path) => calls.filter((c) => c.path === path)
const page = (messages, extra = {}) => ({ status: 200, body: { ok: true, sessionId: 's-i1', title: 'T', messages, hasMore: false, ...(messages.length ? { cursor: messages[0].id } : {}), ...extra } })
const unchanged = () => ({ status: 200, body: { ok: true, unchanged: true } })
const hang = () => new Promise(() => {})
/** Counts the notifications of the store: a state change makes every view render. */
function watch() { let n = 0; const off = api.subscribe(() => { n++ }); return { get count() { return n }, off } }

// ---- no state change, no render ---------------------------------------------------------------------------------------------------------------

test('a refresh that brings the same messages changes no state: no notification, the same message objects', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a'), msg(2, 'assistant', 'b')])
  await api.loadThread('i1')
  const before = thread()
  const w = watch()
  const version = api.state.version
  await api.refreshThread('i1')
  w.off()
  assert.equal(w.count, 0)
  assert.equal(api.state.version, version)
  assert.equal(thread(), before)
  assert.equal(thread().messages[0], before.messages[0])
})

test('a refresh with a new message changes the state once and keeps the objects of the old messages', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  const first = thread().messages[0]
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a'), msg(2, 'assistant', 'b')])
  const w = watch()
  await api.refreshThread('i1')
  w.off()
  assert.equal(w.count, 1)
  assert.equal(thread().messages[0], first)
  assert.equal(thread().messages.length, 2)
})

// ---- the unchanged answer -------------------------------------------------------------------------------------------------------------------------

test('a refresh asks with after = the id of the newest message shown; the first load and Load earlier do not', async () => {
  routes['/v1/thread'] = () => page([msg(5, 'user', 'e'), msg(6, 'assistant', 'f')], { hasMore: true })
  await api.loadThread('i1')
  routes['/v1/thread'] = unchanged
  await api.refreshThread('i1')
  routes['/v1/thread'] = () => page([msg(3, 'user', 'c')])
  await api.loadEarlier('i1')
  const bodies = sentTo('/v1/thread').map((c) => c.body)
  assert.deepEqual(bodies[0], { id: 'i1', limit: 40 })
  assert.deepEqual(bodies[1], { id: 'i1', limit: 40, after: 6 })
  assert.deepEqual(bodies[2], { id: 'i1', limit: 40, before: 5 })
})

test('after is the newest confirmed message: a pending bubble does not count, and a thread with none sends no after', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done')])
  await api.loadThread('i1')
  api.set({ threads: { ...api.state.threads, i1: { ...thread(), messages: [...thread().messages, { id: 'p-1', role: 'user', text: 'x', pending: true, time: Date.now() }] } } })
  routes['/v1/thread'] = unchanged
  await api.refreshThread('i1')
  assert.equal(sentTo('/v1/thread').at(-1).body.after, 1)
  api.set({ threads: { i2: { messages: [], hasMore: false, cursor: undefined, loading: false, loadingEarlier: false, error: null, offline: false } } })
  await api.refreshThread('i2')
  assert.equal('after' in sentTo('/v1/thread').at(-1).body, false)
})

test('an unchanged answer changes no state at all', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  const before = thread()
  routes['/v1/thread'] = unchanged
  const w = watch()
  await api.refreshThread('i1')
  w.off()
  assert.equal(w.count, 0)
  assert.equal(thread(), before)
})

test('an unchanged answer after a failed poll clears the offline note (the connection is back)', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  routes['/v1/thread'] = () => { throw new TypeError('Failed to fetch') }
  await api.refreshThread('i1')
  assert.equal(thread().offline, true)
  routes['/v1/thread'] = unchanged
  await api.refreshThread('i1')
  assert.deepEqual([thread().offline, thread().error, thread().messages.length], [false, null, 1])
})

test('an unchanged answer still gives up a sent bubble the log never showed', async (t) => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  routes['/v1/thread'] = () => page([msg(1, 'assistant', 'done')])
  await api.loadThread('i1')
  await api.postFollowUp('i1', 'never logged')
  assert.equal(thread().messages.length, 2)
  routes['/v1/thread'] = unchanged
  now += 16 * 60_000
  await api.refreshThread('i1')
  assert.deepEqual(thread().messages.map((m) => m.text), ['done'])
})

// ---- the poll back-off ----------------------------------------------------------------------------------------------------------------------------

async function tickFor(t, ms) { t.mock.timers.tick(ms); await flush(); await flush() }

test('polling slows down while nothing changes: 5 s, 10 s after 3 unchanged answers, 20 s after 6', async (t) => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = unchanged
  const n = () => sentTo('/v1/thread').length
  const base = n()
  api.startThreadPolling('i1')
  for (let i = 1; i <= 3; i++) { await tickFor(t, POLL_MS); assert.equal(n(), base + i, 'request ' + i + ' after 5 s') }
  await tickFor(t, POLL_MS)
  assert.equal(n(), base + 3, 'the 4th waits for 10 s')
  await tickFor(t, POLL_MS)
  assert.equal(n(), base + 4)
  await tickFor(t, 2 * POLL_MS - 1)
  assert.equal(n(), base + 4)
  await tickFor(t, 1)
  assert.equal(n(), base + 5)
  await tickFor(t, 2 * POLL_MS)
  assert.equal(n(), base + 6, 'the 6th unchanged answer')
  await tickFor(t, 4 * POLL_MS - 1)
  assert.equal(n(), base + 6, 'then 20 s')
  await tickFor(t, 1)
  assert.equal(n(), base + 7)
  api.stopThreadPolling()
})

test('a change brings the poll back to 5 s', async (t) => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = unchanged
  const n = () => sentTo('/v1/thread').length
  const base = n()
  api.startThreadPolling('i1')
  for (let i = 0; i < 3; i++) await tickFor(t, POLL_MS)
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a'), msg(2, 'assistant', 'b')]) // the 4th poll (after 10 s) finds news
  await tickFor(t, 2 * POLL_MS)
  assert.equal(n(), base + 4)
  routes['/v1/thread'] = unchanged
  await tickFor(t, POLL_MS)
  assert.equal(n(), base + 5, 'back to 5 s')
  api.stopThreadPolling()
})

test('a follow-up of the user brings the poll back to 5 s', async (t) => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = unchanged
  api.startThreadPolling('i1')
  for (let i = 0; i < 3; i++) await tickFor(t, POLL_MS)
  await api.postFollowUp('i1', 'go on')
  const n = sentTo('/v1/thread').length
  await tickFor(t, POLL_MS)
  assert.equal(sentTo('/v1/thread').length, n + 1, 'the next refresh is 5 s after the post, not 10')
  api.stopThreadPolling()
})

test('a failed poll does not count as an unchanged answer', async (t) => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = () => { throw new TypeError('Failed to fetch') }
  const base = sentTo('/v1/thread').length
  api.startThreadPolling('i1')
  for (let i = 1; i <= 5; i++) { await tickFor(t, POLL_MS); assert.equal(sentTo('/v1/thread').length, base + i) }
  api.stopThreadPolling()
})

// ---- timeouts and aborts ---------------------------------------------------------------------------------------------------------------------------

test('the timeouts are 20 s for a thread request and 40 s for a post', () => {
  assert.equal(THREAD_TIMEOUT_MS, 20_000)
  assert.equal(POST_TIMEOUT_MS, 40_000)
})

test('a refresh that never answers is cut off after 20 s: the offline note shows, the guard is released and the next refresh asks again', async (t) => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = hang
  const refresh = api.refreshThread('i1')
  await flush()
  await tickFor(t, THREAD_TIMEOUT_MS - 1)
  assert.equal(sentTo('/v1/thread')[1].signal.aborted, false)
  t.mock.timers.tick(1)
  await refresh
  assert.equal(sentTo('/v1/thread')[1].signal.aborted, true)
  assert.equal(thread().offline, true)
  assert.match(thread().error, /in time|try again/i)
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a'), msg(2, 'assistant', 'b')])
  await api.refreshThread('i1')
  assert.deepEqual([sentTo('/v1/thread').length, thread().messages.length, thread().error], [3, 2, null])
})

test('a first load that never answers is cut off after 20 s: an error with Retry, and Retry works', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = hang
  const load = api.loadThread('i1')
  await flush()
  assert.equal(thread().loading, true)
  t.mock.timers.tick(THREAD_TIMEOUT_MS)
  await load
  assert.deepEqual([thread().loading, thread().messages.length], [false, 0])
  assert.ok(thread().error)
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  assert.deepEqual([thread().error, thread().messages.length], [null, 1])
})

test('Load earlier that never answers is cut off too and can be tried again', async (t) => {
  routes['/v1/thread'] = () => page([msg(5, 'user', 'e')], { hasMore: true })
  await api.loadThread('i1')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = hang
  const earlier = api.loadEarlier('i1')
  await flush()
  t.mock.timers.tick(THREAD_TIMEOUT_MS)
  await earlier
  assert.equal(thread().loadingEarlier, false)
  routes['/v1/thread'] = () => page([msg(3, 'user', 'c')])
  await api.loadEarlier('i1')
  assert.equal(thread().messages.length, 2)
})

test('a post that never answers is cut off after 40 s: busy is released, the draft stays, the error says it may have been sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  api.set({ replies: { i1: 'my draft' } })
  routes['/v1/post'] = hang
  const posting = api.postFollowUp('i1', 'my draft')
  await flush()
  assert.equal(api.state.busy.i1, true)
  t.mock.timers.tick(POST_TIMEOUT_MS - 1)
  await flush()
  assert.equal(api.state.busy.i1, true, 'still waiting at 39.999 s')
  t.mock.timers.tick(1)
  assert.deepEqual(await posting, { ok: false })
  assert.equal(api.state.busy.i1, false)
  assert.match(api.state.errors.i1, /in time/i)
  assert.equal(api.state.replies.i1, 'my draft')
  assert.deepEqual(thread().messages.filter((m) => m.pending), [])
})

test('a retry of the same text after the 40 s cut-off reuses the key of the first attempt: the server may have accepted the first one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/post'] = hang
  const posting = api.postFollowUp('i1', 'slow text for the key')
  await flush()
  t.mock.timers.tick(POST_TIMEOUT_MS)
  assert.deepEqual(await posting, { ok: false })
  routes['/v1/post'] = () => ({ status: 200, body: { ok: true } })
  assert.deepEqual(await api.postFollowUp('i1', 'slow text for the key'), { ok: true })
  const keys = sentTo('/v1/post').map((c) => c.body.key)
  assert.equal(keys.length, 2)
  assert.match(keys[0], /^[A-Za-z0-9_-]{1,64}$/)
  assert.equal(keys[0], keys[1])
})

for (const [name, trigger] of [
  ['the page being hidden', () => { globalThis.document.hidden = true; fire('visibilitychange') }],
  ['pagehide', () => fire('pagehide')],
  ['the phone coming back online', () => fire('online')],
]) {
  test('an in-flight refresh is aborted quietly by ' + name + ' and releases the guard', async () => {
    routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
    await api.loadThread('i1')
    routes['/v1/thread'] = hang
    const refresh = api.refreshThread('i1')
    await flush()
    trigger()
    await refresh
    assert.equal(sentTo('/v1/thread')[1].signal.aborted, true)
    assert.equal(thread().error, null, 'no error note for an abort of our own')
    globalThis.document.hidden = false
    routes['/v1/thread'] = () => page([msg(1, 'user', 'a'), msg(2, 'assistant', 'b')])
    await api.refreshThread('i1')
    assert.equal(thread().messages.length, 2, 'the next refresh works')
  })
}

test('an in-flight first load that is aborted by the page ends the loading state with a retry note', async () => {
  routes['/v1/thread'] = hang
  const load = api.loadThread('i1')
  await flush()
  fire('pagehide')
  await load
  assert.equal(thread().loading, false)
  assert.ok(thread().error)
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  await api.loadThread('i1')
  assert.equal(thread().messages.length, 1)
})

test('a post is not aborted by the page being hidden', async () => {
  let release
  routes['/v1/post'] = () => new Promise((r) => { release = () => r({ status: 200, body: { ok: true } }) })
  const posting = api.postFollowUp('i1', 'once')
  await flush()
  globalThis.document.hidden = true
  fire('visibilitychange')
  fire('pagehide')
  fire('online')
  release()
  assert.deepEqual(await posting, { ok: true })
})

test('the page listeners are added once, however many requests run', async () => {
  routes['/v1/thread'] = () => page([msg(1, 'user', 'a')])
  const before = [handlers.visibilitychange.length, handlers.pagehide.length, handlers.online.length]
  for (let i = 0; i < 4; i++) await api.refreshThread('i1')
  api.startThreadPolling('i1')
  api.startThreadPolling('i1')
  const after = [handlers.visibilitychange.length, handlers.pagehide.length, handlers.online.length]
  assert.ok(after.every((n, i) => n - before[i] <= 1 && n <= 1), JSON.stringify([before, after]))
})

// ---- the memory of the threads ------------------------------------------------------------------------------------------------------------------------

test('at most 10 threads are kept: opening an 11th forgets the one opened longest ago', async () => {
  routes['/v1/thread'] = (body) => page([msg(1, 'user', 'hi ' + body.id)])
  for (let i = 1; i <= MAX_THREADS; i++) await api.loadThread('t' + i)
  assert.equal(Object.keys(api.state.threads).length, 10)
  await api.loadThread('t11')
  assert.equal(Object.keys(api.state.threads).length, 10)
  assert.equal('t1' in api.state.threads, false)
  assert.equal('t11' in api.state.threads, true)
})

test('opening an old thread again makes it the newest: the next one forgotten is another', async () => {
  routes['/v1/thread'] = (body) => page([msg(1, 'user', 'hi ' + body.id)])
  for (let i = 1; i <= MAX_THREADS; i++) await api.loadThread('t' + i)
  await api.loadThread('t1')
  await api.loadThread('t11')
  assert.equal('t1' in api.state.threads, true)
  assert.equal('t2' in api.state.threads, false)
  assert.equal(Object.keys(api.state.threads).length, 10)
})

const longThread = (n) => ({ messages: Array.from({ length: n }, (_, k) => msg(k + 1, k % 2 ? 'assistant' : 'user', 'm' + (k + 1))), hasMore: false, cursor: 1, loading: false, loadingEarlier: false, error: null, offline: false })

test('leaving the item screen (stopThreadPolling) trims its thread to the newest 40 messages and lets Load earlier bring the rest back', () => {
  api.set({ threads: { i1: longThread(100) } })
  api.startThreadPolling('i1')
  api.stopThreadPolling()
  const t = thread()
  assert.deepEqual([t.messages.length, t.messages[0].id, t.messages.at(-1).id, t.hasMore, t.cursor], [40, 61, 100, true, 61])
})

test('stopThreadPolling with the id of another item trims that thread and leaves the running poll alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  routes['/v1/thread'] = unchanged
  api.set({ threads: { i1: longThread(10), i2: longThread(90) } })
  api.startThreadPolling('i1')
  api.stopThreadPolling('i2')
  assert.equal(thread('i2').messages.length, 40)
  assert.equal(thread('i1').messages.length, 10)
  await tickFor(t, POLL_MS)
  assert.equal(sentTo('/v1/thread').length, 1, 'the poll of i1 goes on')
  api.stopThreadPolling()
})

test('a short thread is left as it is when its screen is left: no state change', () => {
  api.set({ threads: { i1: longThread(30) } })
  const before = thread()
  api.startThreadPolling('i1')
  const w = watch()
  api.stopThreadPolling()
  w.off()
  assert.equal(w.count, 0)
  assert.equal(thread(), before)
})

// ---- saving the draft at once ----------------------------------------------------------------------------------------------------------------------------

test('saveNow writes the drafts to the page storage at once, without waiting for the 300 ms timer', () => {
  api.set({ replies: { i1: 'unsent words' } })
  store.delete('rq-m.saved')
  api.saveNow()
  assert.equal(JSON.parse(store.get('rq-m.saved')).replies.i1, 'unsent words')
})
