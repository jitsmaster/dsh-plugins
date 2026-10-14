import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// api.js reads location at import time and uses fetch / localStorage: give it stand-ins, then import it.
globalThis.location = { pathname: '/review-queue/m/' }
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
const api = await import('../lib/mobile/api.js')

let calls, reply
beforeEach(() => {
  calls = []
  store.clear()
  reply = { status: 200, body: {} }
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, credentials: init.credentials, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body }
  }
})

test('the API prefix comes from the page URL', () => {
  assert.equal(api.API, '/review-queue')
})

test('pushKey GETs /v1/push/key with the DSH cookie and returns the public key', async () => {
  reply.body = { key: 'BKEY' }
  assert.equal(await api.pushKey(), 'BKEY')
  assert.equal(calls[0].url, '/review-queue/v1/push/key')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].credentials, 'same-origin')
})

test('pushKey rejects when the server sends no key', async () => {
  reply.body = {}
  await assert.rejects(api.pushKey(), /key/i)
})

test('pushSubscribe POSTs the payload as JSON and returns the device', async () => {
  reply.body = { ok: true, device: { id: 'd1' } }
  const payload = { subscription: { endpoint: 'https://x', keys: { p256dh: 'a', auth: 'b' } }, name: 'P', types: {}, quiet: {} }
  const r = await api.pushSubscribe(payload)
  assert.equal(r.device.id, 'd1')
  assert.equal(calls[0].url, '/review-queue/v1/push/subscribe')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['content-type'], 'application/json')
  assert.deepEqual(calls[0].body, payload)
})

test('pushUnsubscribe, pushTest and pushSettings post to their routes', async () => {
  await api.pushUnsubscribe({ endpoint: 'https://x' })
  await api.pushUnsubscribe({ id: 'd2' })
  await api.pushTest('https://x')
  await api.pushSettings({ endpoint: 'https://x', name: 'N', types: { question: false }, quiet: { enabled: false } })
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ['POST', '/review-queue/v1/push/unsubscribe'], ['POST', '/review-queue/v1/push/unsubscribe'],
    ['POST', '/review-queue/v1/push/test'], ['POST', '/review-queue/v1/push/settings'],
  ])
  assert.deepEqual(calls[0].body, { endpoint: 'https://x' })
  assert.deepEqual(calls[1].body, { id: 'd2' })
  assert.deepEqual(calls[2].body, { endpoint: 'https://x' })
  assert.equal(calls[3].body.name, 'N')
})

test('pushDevices GETs the list and always returns an array', async () => {
  reply.body = { devices: [{ id: 'd1', name: 'Pixel' }] }
  assert.deepEqual(await api.pushDevices(), [{ id: 'd1', name: 'Pixel' }])
  assert.equal(calls[0].url, '/review-queue/v1/push/devices')
  reply.body = {}
  assert.deepEqual(await api.pushDevices(), [])
})

test('a failing push call throws with the server error, or the HTTP status', async () => {
  reply = { status: 404, body: { error: 'unknown-device' } }
  await assert.rejects(api.pushTest('https://x'), /unknown-device/)
  reply = { status: 500, body: null }
  await assert.rejects(api.pushDevices(), /HTTP 500/)
})

test('the push settings of this phone round-trip through local storage, repaired on the way', () => {
  const s = api.getPushPrefs('UTC')
  assert.equal(s.quiet.enabled, false)
  api.setPushPrefs({ name: 'Pixel', types: { question: false }, quiet: { enabled: true, start: '23:00', end: '06:00', tz: 'UTC' } })
  const back = api.getPushPrefs('UTC')
  assert.equal(back.name, 'Pixel')
  assert.equal(back.types.question, false)
  assert.equal(back.types.permission, true)
  assert.equal(back.quiet.start, '23:00')
  store.set('rq-m.push', '{not json')
  assert.equal(api.getPushPrefs('UTC').quiet.enabled, false)
})

test('the id of this phone as the server knows it is remembered', () => {
  assert.equal(api.getDeviceId(), null)
  api.setDeviceId('d9')
  assert.equal(api.getDeviceId(), 'd9')
  api.setDeviceId(null)
  assert.equal(api.getDeviceId(), null)
})
