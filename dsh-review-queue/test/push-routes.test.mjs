import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createECDH, randomBytes } from 'node:crypto'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { createPushStore } from '../push.js'
import { createPushRoutes } from '../push-routes.js'
import { b64u } from '../webpush.js'

let server, base, push, sent, nextResult
const VAPID_PUBLIC = 'BPublicKeyForTests'

before(async () => {
  const queue = createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}), speaker: { speak: () => ({ ok: true }), stop() {} } })
  sent = []
  push = createPushStore({
    sendPush: async (subscription, payload, opts) => { sent.push({ subscription, payload, opts }); return nextResult },
    vapid: { publicKey: VAPID_PUBLIC, privateKey: 'x', subject: 'mailto:a@b.c' },
  })
  const serve = createRouter({ queue, pushRoutes: createPushRoutes({ push, publicKey: VAPID_PUBLIC }) })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
beforeEach(() => { sent.length = 0; nextResult = { ok: true, status: 201, gone: false }; for (const d of push.devices()) push.remove({ id: d.id }) })

const keys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64u(e.getPublicKey()), auth: b64u(randomBytes(16)) } }
const body = (over = {}) => ({
  subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: keys() },
  name: 'Pixel 7',
  types: { permission: true, question: true, 'pr-merged': false, completed: true },
  quiet: { enabled: true, start: '22:00', end: '07:00', tz: 'Europe/Berlin' },
  ...over,
})
const post = (path, b, headers = { 'content-type': 'application/json' }) => fetch(base + path, { method: 'POST', headers, body: typeof b === 'string' ? b : JSON.stringify(b) })
const get = (path) => fetch(base + path)

test('GET /v1/push/key returns the VAPID public key, uncacheable', async () => {
  const res = await get('/v1/push/key')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('cache-control'), /no-store/)
  assert.deepEqual(await res.json(), { key: VAPID_PUBLIC })
})

test('subscribe -> devices -> settings -> unsubscribe round trip', async () => {
  const b = body()
  const sub = await post('/v1/push/subscribe', b)
  assert.equal(sub.status, 200)
  const { device } = await sub.json()
  assert.ok(device.id)
  let list = await (await get('/v1/push/devices')).json()
  assert.equal(list.devices.length, 1)
  assert.equal(list.devices[0].id, device.id)
  assert.equal(list.devices[0].name, 'Pixel 7')
  assert.equal(list.devices[0].types['pr-merged'], false)
  assert.equal(list.devices[0].quiet.tz, 'Europe/Berlin')

  const set = await post('/v1/push/settings', { endpoint: b.subscription.endpoint, name: 'Renamed', types: { question: false }, quiet: { enabled: false, start: '22:00', end: '07:00', tz: 'Europe/Berlin' } })
  assert.equal(set.status, 200)
  list = await (await get('/v1/push/devices')).json()
  assert.equal(list.devices[0].name, 'Renamed')
  assert.equal(list.devices[0].types.question, false)
  assert.equal(list.devices[0].types.permission, true)
  assert.equal(list.devices[0].quiet.enabled, false)

  const un = await post('/v1/push/unsubscribe', { endpoint: b.subscription.endpoint })
  assert.equal(un.status, 200)
  assert.equal((await (await get('/v1/push/devices')).json()).devices.length, 0)
})

test('subscribing twice with the same endpoint keeps one device with the same id', async () => {
  const b = body()
  const a = (await (await post('/v1/push/subscribe', b)).json()).device
  const c = (await (await post('/v1/push/subscribe', { ...b, name: 'Again' })).json()).device
  assert.equal(c.id, a.id)
  assert.equal((await (await get('/v1/push/devices')).json()).devices.length, 1)
})

test('the device list never leaks the endpoint or the keys', async () => {
  const b = body()
  await post('/v1/push/subscribe', b)
  const text = await (await get('/v1/push/devices')).text()
  assert.ok(!text.includes(b.subscription.endpoint) && !text.includes('fcm.googleapis.com'))
  assert.ok(!text.includes(b.subscription.keys.p256dh) && !text.includes(b.subscription.keys.auth))
  assert.ok(!/endpoint|p256dh|auth|keys/i.test(text))
  const echoed = await (await post('/v1/push/subscribe', b)).text()
  assert.ok(!echoed.includes(b.subscription.keys.auth) && !echoed.includes(b.subscription.endpoint))
})

test('subscribe validates its input with a JSON error', async () => {
  const bad = async (b, error) => {
    const res = await post('/v1/push/subscribe', b)
    assert.equal(res.status, 400, error)
    assert.equal((await res.json()).error, error)
  }
  await bad(body({ subscription: { endpoint: 'http://insecure.example/1', keys: keys() } }), 'bad-endpoint')
  await bad(body({ subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'AAAA', auth: 'AAAA' } } }), 'bad-keys')
  await bad(body({ name: 'n'.repeat(41) }), 'bad-name')
  await bad(body({ types: { question: 'no' } }), 'bad-types')
  await bad(body({ quiet: { enabled: true, start: 'bad', end: '07:00', tz: 'UTC' } }), 'bad-quiet')
  await bad({}, 'bad-endpoint')
  assert.equal((await (await get('/v1/push/devices')).json()).devices.length, 0)
})

test('push routes need a JSON content type, valid JSON, and the right method', async () => {
  assert.equal((await post('/v1/push/subscribe', body(), { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await post('/v1/push/subscribe', '{nope')).status, 400)
  assert.equal((await get('/v1/push/subscribe')).status, 405)
  assert.equal((await post('/v1/push/key', {})).status, 405)
  assert.equal((await post('/v1/push/devices', {})).status, 405)
  assert.equal((await get('/v1/push/nope')).status, 404)
  assert.equal((await post('/v1/push/nope', {})).status, 404)
})

test('unsubscribe by id works, repeats are fine, and a body with neither id nor endpoint is a 400', async () => {
  const { device } = await (await post('/v1/push/subscribe', body())).json()
  const first = await post('/v1/push/unsubscribe', { id: device.id })
  assert.equal(first.status, 200)
  assert.equal((await first.json()).removed, true)
  const again = await post('/v1/push/unsubscribe', { id: device.id })
  assert.equal(again.status, 200)
  assert.equal((await again.json()).removed, false)
  const none = await post('/v1/push/unsubscribe', {})
  assert.equal(none.status, 400)
  assert.equal((await none.json()).error, 'bad-request')
})

test('settings for an unknown device is a 404 and bad settings are a 400', async () => {
  const unknown = await post('/v1/push/settings', { endpoint: 'https://fcm.googleapis.com/fcm/send/ghost', name: 'x' })
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error, 'unknown-device')
  const b = body()
  await post('/v1/push/subscribe', b)
  const bad = await post('/v1/push/settings', { endpoint: b.subscription.endpoint, types: { question: 1 } })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'bad-types')
  assert.equal((await post('/v1/push/settings', {})).status, 400)
})

test('POST /v1/push/test sends a generic test push through the injected sender', async () => {
  const b = body()
  await post('/v1/push/subscribe', b)
  const res = await post('/v1/push/test', { endpoint: b.subscription.endpoint })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].subscription, b.subscription)
  assert.deepEqual(Object.keys(sent[0].payload).sort(), ['body', 'tag', 'title', 'url'])
  assert.equal(sent[0].payload.url, '#/')
  assert.equal(sent[0].opts.urgency, 'normal')
  assert.ok(sent[0].opts.ttl <= 3600)
  assert.ok((await (await get('/v1/push/devices')).json()).devices[0].lastSuccessAt > 0)
})

test('a test push to an unknown device is a 404 and sends nothing', async () => {
  const res = await post('/v1/push/test', { endpoint: 'https://fcm.googleapis.com/fcm/send/ghost' })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'unknown-device')
  assert.equal(sent.length, 0)
  assert.equal((await post('/v1/push/test', {})).status, 400)
})

test('when the push service answers 410 the device is removed and the phone is told', async () => {
  const b = body()
  await post('/v1/push/subscribe', b)
  nextResult = { ok: false, status: 410, gone: true, error: 'HTTP 410' }
  const res = await post('/v1/push/test', { endpoint: b.subscription.endpoint })
  assert.equal(res.status, 410)
  assert.equal((await res.json()).error, 'subscription-gone')
  assert.equal((await (await get('/v1/push/devices')).json()).devices.length, 0)
})

test('another push failure is a 502 that keeps the device and records the error', async () => {
  const b = body()
  await post('/v1/push/subscribe', b)
  nextResult = { ok: false, status: 503, gone: false, error: 'HTTP 503' }
  const res = await post('/v1/push/test', { endpoint: b.subscription.endpoint })
  assert.equal(res.status, 502)
  const json = await res.json()
  assert.equal(json.error, 'push-failed')
  assert.equal(json.status, 503)
  const { devices } = await (await get('/v1/push/devices')).json()
  assert.equal(devices.length, 1)
  assert.equal(devices[0].lastError, 'HTTP 503')
})

test('without push routes the push paths are unknown actions, as before', async () => {
  const queue = createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}), speaker: { speak: () => ({ ok: true }), stop() {} } })
  const serve = createRouter({ queue })
  const s = createServer((req, res) => serve(req, res))
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const res = await fetch('http://127.0.0.1:' + s.address().port + '/v1/push/key')
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'unknown-action')
  s.closeAllConnections?.(); s.close()
})
