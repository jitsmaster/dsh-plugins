import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// The phone's pairing flow at the api layer: the code goes to the hub's public pair route, the token is kept in localStorage and sent as
// Authorization: Bearer on every call, and a hub that says auth-required sends the phone back to the pairing screen.
globalThis.location = { pathname: '/review-queue/m/' }
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
const api = await import('../lib/mobile/api.js')

const TOKEN = 'rqd_' + 'A'.repeat(43)
let calls, replies
beforeEach(() => {
  calls = []
  store.clear()
  api.set({ needsPairing: false, pairMessage: null, error: null, auth: false, errors: {}, busy: {} })
  replies = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    const r = replies.shift() ?? { status: 200, body: {} }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => r.headers?.[k.toLowerCase()] ?? null }, json: async () => r.body }
  }
})
const core = { errorText: (status, body) => 'E' + status + ':' + (body && body.error) }

test('pair sends the code and name to /hub/v1/pair without credentials, keeps the token and says the phone is paired', async () => {
  replies.push({ status: 200, body: { deviceId: 'dv_1', token: TOKEN, name: 'Pixel 9' } })
  api.set({ needsPairing: true })
  const r = await api.pair('abcd-efgh', 'Pixel 9')
  assert.deepEqual(r, { ok: true })
  assert.deepEqual([calls[0].method, calls[0].url], ['POST', '/hub/v1/pair'])
  assert.deepEqual(calls[0].body, { code: 'abcd-efgh', name: 'Pixel 9' })
  assert.equal(calls[0].headers.authorization, undefined)
  assert.equal(calls[0].headers['content-type'], 'application/json')
  assert.equal(store.get('rq-m.token'), TOKEN)
  assert.equal(api.state.needsPairing, false)
  assert.equal(api.getToken(), TOKEN)
})

test('a wrong code answers with the words and keeps nothing', async () => {
  replies.push({ status: 400, body: { error: 'bad-code' } })
  const r = await api.pair('zzzz-zzzz', 'x')
  assert.equal(r.ok, false)
  assert.match(r.message, /wrong, expired or already used/i)
  assert.equal(store.has('rq-m.token'), false)
})

test('rate limited: the wait from Retry-After is in the message; a network error says the hub could not be reached', async () => {
  replies.push({ status: 429, body: { error: 'rate-limited' }, headers: { 'retry-after': '42' } })
  assert.match((await api.pair('a', 'b')).message, /42 seconds/)
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  assert.match((await api.pair('a', 'b')).message, /could not reach/i)
})

test('every later call carries the token: actions, push routes', async () => {
  replies.push({ status: 200, body: { deviceId: 'dv_1', token: TOKEN, name: 'P' } })
  await api.pair('abcd-efgh', 'P')
  calls.length = 0
  await api.pushKey().catch(() => {})
  await api.pushDevices()
  assert.deepEqual(calls.map((c) => c.headers.authorization), ['Bearer ' + TOKEN, 'Bearer ' + TOKEN])
})

test('an action answered with auth-required clears the token and sends the phone back to pairing, with the reason', async () => {
  store.set('rq-m.token', TOKEN)
  api.setCoreForTests(core)
  replies.push({ status: 401, body: { error: 'auth-required' } })
  const ok = await api.act('/v1/approve', { id: 'x' }, 'x')
  assert.equal(ok, false)
  assert.equal(api.state.needsPairing, true)
  assert.match(api.state.pairMessage, /removed|signed out/i)
  assert.equal(store.has('rq-m.token'), false)
})

test('a 401 from something that is not the hub (the DSH login) does not look like a pairing problem', async () => {
  api.setCoreForTests(core)
  replies.push({ status: 401, body: {} })
  await api.act('/v1/approve', { id: 'x' }, 'x')
  assert.equal(api.state.needsPairing, false)
})

test('a tailnet account that is not allowed is reported, not treated as unpaired', async () => {
  store.set('rq-m.token', TOKEN)
  api.setCoreForTests(core)
  replies.push({ status: 403, body: { error: 'login-not-allowed' } })
  await api.act('/v1/approve', { id: 'x' }, 'x')
  assert.equal(api.state.needsPairing, false)
  assert.equal(store.get('rq-m.token'), TOKEN)
  assert.match(api.state.errors.x, /E403/)
})

test('handleAuthFailure is what the poll loop calls: it answers whether the phone must pair again', () => {
  store.set('rq-m.token', TOKEN)
  assert.equal(api.handleAuthFailure(200, {}), false)
  assert.equal(api.handleAuthFailure(401, { error: 'auth-required' }), true)
  assert.equal(api.state.needsPairing, true)
  assert.equal(store.has('rq-m.token'), false)
  store.clear()
  api.set({ needsPairing: false, pairMessage: null })
  assert.equal(api.handleAuthFailure(401, { error: 'auth-required' }), true)
  assert.match(api.state.pairMessage, /not paired|pair this phone/i, 'never paired: another sentence than removed')
})

test('signOut forgets the token locally and shows the pairing screen', () => {
  store.set('rq-m.token', TOKEN)
  api.signOut()
  assert.equal(store.has('rq-m.token'), false)
  assert.equal(api.state.needsPairing, true)
})
