import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { b64u, fromB64u, sendPush as realSendPush } from '../hub/webpush.js'
import { DEFAULT_SUBJECT, loadOrCreateVapid } from '../hub/push.js'
import { HOST, P, startPhoneHub } from './hub-device-helpers.mjs'

// iPhone support, hub side. (a) Apple's push service (web.push.apple.com, and any *.push.apple.com) must be accepted by the subscribe route and
// reached by the sender (there is no host allow-list, only the https / not-a-local-address rule, so these tests guard that it stays so).
// (b) Apple rejects a VAPID subject that is not a valid https URL or a mailto with a real-looking domain: when hub.config.json has no
// pushSubject, the hub's https public origin (hub.config.publicOrigin, from publicUrl) is the subject; an explicit pushSubject always wins; with
// neither (or an http public URL) the mailto default stays.
const keys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64u(e.getPublicKey()), auth: b64u(randomBytes(16)) } }
const APPLE = 'https://web.push.apple.com/QGaUxkP3TqN6Bp9nVx0Yhs8Z2cJ5fWmAeD1KoLrIuTyG7Hb4Xv-Sw_Cz0MjEi'
const appleSub = (endpoint = APPLE) => ({ endpoint, keys: keys() })

/** The claims of the VAPID JWT in an Authorization header "vapid t=<head>.<claims>.<sig>, k=<key>". */
const claimsOf = (authorization) => JSON.parse(fromB64u(/t=([^.]+)\.([^.]+)\./.exec(authorization)[2]).toString('utf8'))

/** A sendPush that runs the real one against a fake push service, so the request that would reach Apple can be inspected. */
function realSenderWithFakeFetch(calls) {
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return { status: 201 } }
  return async (subscription, payload, opts) => realSendPush(subscription, payload, { ...opts, fetch: fakeFetch })
}

// ---- (a) Apple endpoints -----------------------------------------------------------------------------------------------------------------

test('a phone subscribes with an Apple endpoint (web.push.apple.com) through the subscribe route: accepted and stored for that device', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone('iPhone')
  const s = appleSub()
  const res = await p.call('POST', P + '/v1/push/subscribe', { subscription: s, name: 'iPhone' })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(h.hub.push.devices()[0].endpoint, APPLE)
  assert.equal(h.hub.push.devices()[0].deviceId, p.deviceId)
  for (const secret of [s.endpoint, s.keys.p256dh, s.keys.auth]) assert.ok(!res.text.includes(secret), 'no endpoint or key in the answer')
})

test('any *.push.apple.com host is accepted (the sandbox and regional Apple push hosts too)', async (t) => {
  const h = await startPhoneHub(t)
  const hosts = ['web.push.apple.com', 'api.push.apple.com', 'api.sandbox.push.apple.com', 'api.development.push.apple.com']
  for (const [i, host] of hosts.entries()) {
    const other = await h.pairPhone('Phone ' + i)
    assert.equal((await other.call('POST', P + '/v1/push/subscribe', { subscription: appleSub('https://' + host + '/3/device/AbC123' + i) })).status, 200, host)
  }
  assert.equal(h.hub.push.devices().length, hosts.length)
})

test('an http Apple endpoint is still refused (https only)', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone('iPhone')
  const res = await p.call('POST', P + '/v1/push/subscribe', { subscription: appleSub('http://web.push.apple.com/QGaU') })
  assert.equal(res.status, 400)
  assert.equal(res.json.error, 'bad-endpoint')
})

test('the sender reaches the Apple endpoint: the test push of an iPhone is posted to web.push.apple.com', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone('iPhone')
  const s = appleSub()
  await p.call('POST', P + '/v1/push/subscribe', { subscription: s })
  const test = await p.call('POST', P + '/v1/push/test', { endpoint: s.endpoint })
  assert.equal(test.status, 200)
  assert.equal(h.pushes.length, 1)
  assert.equal(h.pushes[0].subscription.endpoint, APPLE)
})

test('the real sender posts the encrypted message to the Apple endpoint with a VAPID header whose audience is https://web.push.apple.com', async (t) => {
  const calls = []
  const h = await startPhoneHub(t, { sendPush: realSenderWithFakeFetch(calls) })
  const p = await h.pairPhone('iPhone')
  const s = appleSub()
  await p.call('POST', P + '/v1/push/subscribe', { subscription: s })
  assert.equal((await p.call('POST', P + '/v1/push/test', { endpoint: s.endpoint })).status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, APPLE)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['Content-Encoding'], 'aes128gcm')
  assert.match(calls[0].init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
  assert.equal(claimsOf(calls[0].init.headers.Authorization).aud, 'https://web.push.apple.com')
})

// ---- (b) the VAPID subject ---------------------------------------------------------------------------------------------------------------

/** A hub with one stored device, sent one push; the subject the sender was given. */
async function subjectOf(t, config, hubOver = {}) {
  const calls = []
  const h = await startPhoneHub(t, { config, sendPush: async (subscription, payload, opts) => { calls.push(opts); return { ok: true, status: 201, gone: false } }, ...hubOver })
  const added = h.hub.push.upsert({ subscription: appleSub(), name: 'iPhone' })
  assert.equal(added.ok, true)
  const sent = await h.hub.push.send(added.device.id, { title: 'Task list', body: 'x', tag: 'x', url: '#/' })
  assert.equal(sent.ok, true)
  assert.equal(calls.length, 1)
  return { subject: calls[0].vapid.subject, h }
}

test('without pushSubject the VAPID subject is the hub https public origin (what Apple requires)', async (t) => {
  const { subject } = await subjectOf(t, { publicUrl: 'https://' + HOST })
  assert.equal(subject, 'https://' + HOST)
})

test('the subject is the origin only: a path, a trailing slash or a port in publicUrl do not leak into it wrongly', async (t) => {
  assert.equal((await subjectOf(t, { publicUrl: 'https://' + HOST + '/' })).subject, 'https://' + HOST)
  assert.equal((await subjectOf(t, { publicUrl: 'https://' + HOST + '/review-queue/m/#/x' })).subject, 'https://' + HOST)
  assert.equal((await subjectOf(t, { publicUrl: 'https://' + HOST + ':8443' })).subject, 'https://' + HOST + ':8443')
})

test('an explicit pushSubject always wins over the public origin (https URL or mailto)', async (t) => {
  assert.equal((await subjectOf(t, { publicUrl: 'https://' + HOST, pushSubject: 'https://example.org/contact' })).subject, 'https://example.org/contact')
  assert.equal((await subjectOf(t, { publicUrl: 'https://' + HOST, pushSubject: 'mailto:me@example.com' })).subject, 'mailto:me@example.com')
})

test('without publicUrl and without pushSubject the mailto default stays', async (t) => {
  const { subject } = await subjectOf(t, { publicUrl: undefined })
  assert.equal(subject, DEFAULT_SUBJECT)
  assert.match(subject, /^mailto:/)
})

test('an http public URL is not used as the subject (the subject must be an https URL or a mailto): the mailto default stays', async (t) => {
  const { subject } = await subjectOf(t, { publicUrl: 'http://' + HOST })
  assert.equal(subject, DEFAULT_SUBJECT)
})

test('the subject that reaches Apple is the one signed into the VAPID JWT: sub = the https public origin', async (t) => {
  const calls = []
  const h = await startPhoneHub(t, { sendPush: realSenderWithFakeFetch(calls) })
  const p = await h.pairPhone('iPhone')
  const s = appleSub()
  await p.call('POST', P + '/v1/push/subscribe', { subscription: s })
  await p.call('POST', P + '/v1/push/test', { endpoint: s.endpoint })
  assert.equal(calls.length, 1)
  const claims = claimsOf(calls[0].init.headers.Authorization)
  assert.equal(claims.sub, 'https://' + HOST)
  assert.equal(claims.aud, 'https://web.push.apple.com')
})

test('an explicit pushSubject is the one signed into the VAPID JWT', async (t) => {
  const calls = []
  const h = await startPhoneHub(t, { config: { pushSubject: 'mailto:me@example.com' }, sendPush: realSenderWithFakeFetch(calls) })
  const p = await h.pairPhone('iPhone')
  const s = appleSub()
  await p.call('POST', P + '/v1/push/subscribe', { subscription: s })
  await p.call('POST', P + '/v1/push/test', { endpoint: s.endpoint })
  assert.equal(claimsOf(calls[0].init.headers.Authorization).sub, 'mailto:me@example.com')
})

test('loadOrCreateVapid keeps its own default (the mailto) when it is given no subject: the public-origin rule lives in the hub, not here', () => {
  assert.equal(loadOrCreateVapid({}).subject, DEFAULT_SUBJECT)
  assert.equal(loadOrCreateVapid({ subject: undefined }).subject, DEFAULT_SUBJECT)
  assert.equal(loadOrCreateVapid({ subject: 'https://rq.example.ts.net' }).subject, 'https://rq.example.ts.net')
})
