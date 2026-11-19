import { test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// The api layer of swipe-right-to-review (docs/mobile.md "Swipe to review"): swipeReview, undoSwipe, the Undo toast and its one timer.
// A fake fetch plays the hub; timers are mocked so the 6 s window runs instantly.
globalThis.location = { pathname: '/review-queue/m/', hash: '' }
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
const listen = () => {}
globalThis.document = { hidden: false, addEventListener: listen }
globalThis.window = { addEventListener: listen }
const api = await import('../lib/mobile/api.js')
const { UNDO_MS } = await import('../lib/mobile/swipe.js')

const TOKEN = 'rqd_' + 'C'.repeat(43)
const core = {
  errorText: (status, body) => 'E' + status + ':' + (body && body.error),
  pruneSaved: (saved) => saved,
  cardTitle: (item) => 'Card ' + item.id,
}
const itemOf = (id, over = {}) => ({ id, type: 'completed', sessionId: 's-' + id, sessionTitle: 'Title ' + id, summary: 'x', ...over })
const flush = () => new Promise((r) => setImmediate(r))

let calls, routes
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  api.dismissUndo()
  calls = []
  routes = {}
  store.clear()
  store.set('rq-m.token', TOKEN)
  api.setCoreForTests(core)
  api.set({ needsPairing: false, pairMessage: null, error: null, auth: false, errors: {}, busy: {}, undo: null })
  globalThis.fetch = async (url, init = {}) => {
    const path = url.replace('/review-queue', '')
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ path, body })
    const handler = routes[path]
    const r = handler ? await handler(body) : { status: 200, body: { ok: true } }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.body }
  }
})
afterEach(() => { api.dismissUndo(); mock.timers.reset() })

test('swipeReview posts /v1/reviewed for the item and shows an Undo toast with the card title', async () => {
  const ok = await api.swipeReview(itemOf('a'))
  assert.equal(ok, true)
  assert.deepEqual(calls, [{ path: '/v1/reviewed', body: { id: 'a' } }])
  assert.equal(api.state.undo.id, 'a')
  assert.equal(api.state.undo.title, 'Card a')
  assert.equal(api.state.undo.until, 1000 + UNDO_MS)
  assert.equal(api.state.undo.error, undefined)
})

test('the toast title is always text and capped, whatever the card title is', async () => {
  core.cardTitle = () => undefined
  await api.swipeReview(itemOf('a'))
  assert.equal(api.state.undo.title, '')
  api.dismissUndo()
  core.cardTitle = () => 'x'.repeat(500)
  await api.swipeReview(itemOf('b'))
  assert.ok(api.state.undo.title.length <= 80, 'capped')
  assert.ok(api.state.undo.title.startsWith('xxx'))
  core.cardTitle = (item) => 'Card ' + item.id
})

test('swipeReview refuses a row that is not swipeable: no request, no toast', async () => {
  assert.equal(await api.swipeReview(itemOf('q', { type: 'question' })), false)
  assert.deepEqual(calls, [])
  assert.equal(api.state.undo, null)
})

test('swipeReview ignores a second swipe while the first request is in flight', async () => {
  let release
  routes['/v1/reviewed'] = () => new Promise((r) => { release = () => r({ status: 200, body: { ok: true } }) })
  const first = api.swipeReview(itemOf('a'))
  await flush()
  assert.equal(await api.swipeReview(itemOf('a')), false)
  release()
  assert.equal(await first, true)
  assert.equal(calls.length, 1)
})

test('a failed swipe shows the error in the toast and returns false', async () => {
  routes['/v1/reviewed'] = () => ({ status: 409, body: { error: 'gone' } })
  assert.equal(await api.swipeReview(itemOf('a')), false)
  assert.match(api.state.undo.error, /gone/)
})

test('a failed swipe does not replace the live Undo toast of an earlier successful swipe', async () => {
  await api.swipeReview(itemOf('a'))
  routes['/v1/reviewed'] = () => ({ status: 409, body: { error: 'gone' } })
  assert.equal(await api.swipeReview(itemOf('b')), false)
  assert.equal(api.state.undo.id, 'a')
  assert.equal(api.state.undo.error, undefined)
})

test('the toast clears itself after UNDO_MS, not before', async () => {
  await api.swipeReview(itemOf('a'))
  mock.timers.tick(UNDO_MS - 1)
  assert.ok(api.state.undo)
  mock.timers.tick(1)
  assert.equal(api.state.undo, null)
})

test('a second swipe replaces the toast and gets its own full window', async () => {
  await api.swipeReview(itemOf('a'))
  mock.timers.tick(3000)
  await api.swipeReview(itemOf('b'))
  assert.equal(api.state.undo.id, 'b')
  mock.timers.tick(UNDO_MS - 1)
  assert.equal(api.state.undo && api.state.undo.id, 'b')
  mock.timers.tick(1)
  assert.equal(api.state.undo, null)
})

test('the toast has its own channel: expiring or dismissing it tells the undo listeners and does not re-render the rest of the app', async () => {
  const seen = []
  const off = api.subscribeUndo((u) => seen.push(u && u.id))
  await api.swipeReview(itemOf('a'))
  assert.deepEqual(seen, ['a'])
  const v = api.state.version
  mock.timers.tick(UNDO_MS)
  assert.equal(api.state.undo, null)
  assert.deepEqual(seen, ['a', null])
  assert.equal(api.state.version, v, 'expiry bumps no store version')
  await api.swipeReview(itemOf('b'))
  const v2 = api.state.version
  api.dismissUndo()
  assert.equal(api.state.version, v2, 'dismiss bumps no store version')
  off()
  await api.swipeReview(itemOf('c'))
  assert.deepEqual(seen, ['a', null, 'b', null], 'an unsubscribed listener hears nothing')
})

test('undoSwipe posts /v1/reopen for the toast item and clears the toast', async () => {
  await api.swipeReview(itemOf('a'))
  calls.length = 0
  assert.equal(await api.undoSwipe(), true)
  assert.deepEqual(calls, [{ path: '/v1/reopen', body: { id: 'a' } }])
  assert.equal(api.state.undo, null)
})

test('undoSwipe with no toast or an error toast does nothing', async () => {
  assert.equal(await api.undoSwipe(), false)
  routes['/v1/reviewed'] = () => ({ status: 500, body: { error: 'boom' } })
  await api.swipeReview(itemOf('a'))
  calls.length = 0
  assert.equal(await api.undoSwipe(), false)
  assert.deepEqual(calls, [])
})

test('a failed Undo brings the toast back with the error', async () => {
  await api.swipeReview(itemOf('a'))
  routes['/v1/reopen'] = () => ({ status: 409, body: { error: 'cannot reopen' } })
  assert.equal(await api.undoSwipe(), false)
  assert.equal(api.state.undo.id, 'a')
  assert.match(api.state.undo.error, /Could not undo: .*cannot reopen/)
})

test('a failed Undo does not replace a newer swipe\'s toast', async () => {
  await api.swipeReview(itemOf('a'))
  let fail
  routes['/v1/reopen'] = () => new Promise((r) => { fail = () => r({ status: 500, body: { error: 'down' } }) })
  const undo = api.undoSwipe()
  await flush()
  await api.swipeReview(itemOf('b')) // the user swipes another row while the reopen is in flight
  fail()
  assert.equal(await undo, false)
  assert.equal(api.state.undo.id, 'b')
  assert.equal(api.state.undo.error, undefined)
})
