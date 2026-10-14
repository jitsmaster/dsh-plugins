import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto'
import { b64u, fromB64u, encryptPayload, generateVapidKeys, vapidAuthorization, sendPush } from '../webpush.js'

// ---- RFC 8291 appendix A: the values of the worked example ------------------------------------------------------------------
const RFC = {
  plaintext: fromB64u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

test('encryptPayload reproduces the RFC 8291 appendix A message byte for byte', () => {
  const body = encryptPayload({
    plaintext: RFC.plaintext,
    uaPublic: RFC.uaPublic,
    authSecret: RFC.auth,
    ephemeral: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate },
    salt: RFC.salt,
  })
  assert.equal(b64u(body.subarray(0, 86)), RFC.header)
  assert.equal(b64u(body.subarray(86)), RFC.ciphertext)
  assert.equal(body.length, 86 + 16 + RFC.plaintext.length + 1)
})

// A small decrypt for the receiving side (what the browser does), written from RFC 8188 / 8291 and not sharing code with the encryptor.
function decrypt(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.subarray(0, 16)
  assert.equal(body.readUInt32BE(16), 4096)
  const idLen = body[20]
  const asPublic = body.subarray(21, 21 + idLen)
  const record = body.subarray(21 + idLen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(fromB64u(uaPrivate))
  const secret = ecdh.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', secret, fromB64u(authSecret), Buffer.concat([Buffer.from('WebPush: info\0'), fromB64u(uaPublic), asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(record.subarray(record.length - 16))
  const padded = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()])
  assert.equal(padded[padded.length - 1], 2, 'last record carries the 0x02 delimiter')
  return padded.subarray(0, padded.length - 1)
}

const newDevice = () => {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  return { uaPublic: b64u(ua.getPublicKey()), uaPrivate: b64u(ua.getPrivateKey()), auth: b64u(randomBytes(16)) }
}

test('the decrypt of a random message returns the plaintext (round trip), with a fresh key and salt each time', () => {
  const dev = newDevice()
  const text = Buffer.from(JSON.stringify({ title: 'Permission waiting - 3 items', body: 'ünïcode ✓' }))
  const a = encryptPayload({ plaintext: text, uaPublic: dev.uaPublic, authSecret: dev.auth })
  const b = encryptPayload({ plaintext: text, uaPublic: dev.uaPublic, authSecret: dev.auth })
  assert.deepEqual(decrypt(a, dev.uaPrivate, dev.uaPublic, dev.auth), text)
  assert.deepEqual(decrypt(b, dev.uaPrivate, dev.uaPublic, dev.auth), text)
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), 'salt differs')
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), 'ephemeral key differs')
})

test('a string plaintext is UTF-8 encoded; an empty one still round-trips', () => {
  const dev = newDevice()
  assert.equal(decrypt(encryptPayload({ plaintext: 'héllo', uaPublic: dev.uaPublic, authSecret: dev.auth }), dev.uaPrivate, dev.uaPublic, dev.auth).toString('utf8'), 'héllo')
  assert.equal(decrypt(encryptPayload({ plaintext: '', uaPublic: dev.uaPublic, authSecret: dev.auth }), dev.uaPrivate, dev.uaPublic, dev.auth).length, 0)
})

test('the largest payload fits one 4096 byte message; one byte more is refused', () => {
  const dev = newDevice()
  const ok = encryptPayload({ plaintext: Buffer.alloc(3993, 97), uaPublic: dev.uaPublic, authSecret: dev.auth })
  assert.equal(ok.length, 4096)
  assert.throws(() => encryptPayload({ plaintext: Buffer.alloc(3994, 97), uaPublic: dev.uaPublic, authSecret: dev.auth }), /too large/i)
})

test('bad subscription keys are rejected before any crypto runs', () => {
  const dev = newDevice()
  assert.throws(() => encryptPayload({ plaintext: 'x', uaPublic: 'AAAA', authSecret: dev.auth }), /key/i)
  assert.throws(() => encryptPayload({ plaintext: 'x', uaPublic: dev.uaPublic, authSecret: 'AAAA' }), /auth/i)
  assert.throws(() => encryptPayload({ plaintext: 'x', uaPublic: 'not base64url!!', authSecret: dev.auth }), /key/i)
})

// ---- VAPID ------------------------------------------------------------------------------------------------------------------
test('generateVapidKeys returns a base64url uncompressed P-256 point and a 32 byte private key', () => {
  const k = generateVapidKeys()
  const pub = fromB64u(k.publicKey)
  assert.equal(pub.length, 65)
  assert.equal(pub[0], 4)
  assert.equal(fromB64u(k.privateKey).length, 32)
  assert.ok(!/[=+/]/.test(k.publicKey + k.privateKey))
  assert.notEqual(generateVapidKeys().publicKey, k.publicKey)
})

const jwtParts = (header) => {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)
  assert.ok(m, 'Authorization shape: ' + header)
  return { head: JSON.parse(fromB64u(m[1]).toString()), claims: JSON.parse(fromB64u(m[2]).toString()), sig: fromB64u(m[3]), signed: m[1] + '.' + m[2], k: m[4] }
}

const publicKeyObject = (b64) => {
  const raw = fromB64u(b64)
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' })
}

test('vapidAuthorization signs an ES256 JWT for the push service origin that verifies with the public key', () => {
  const keys = generateVapidKeys()
  const now = Date.UTC(2026, 9, 14, 12, 0, 0)
  const header = vapidAuthorization({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc?x=1', vapid: { ...keys, subject: 'mailto:me@example.org' }, now })
  const { head, claims, sig, signed, k } = jwtParts(header)
  assert.deepEqual(head, { typ: 'JWT', alg: 'ES256' })
  assert.equal(claims.aud, 'https://fcm.googleapis.com')
  assert.equal(claims.sub, 'mailto:me@example.org')
  assert.ok(claims.exp > now / 1000 && claims.exp - now / 1000 <= 12 * 3600, 'expires within 12 hours')
  assert.equal(k, keys.publicKey)
  assert.equal(sig.length, 64, 'raw r||s, not DER')
  assert.equal(verify('sha256', Buffer.from(signed), { key: publicKeyObject(keys.publicKey), dsaEncoding: 'ieee-p1363' }, sig), true)
  assert.equal(verify('sha256', Buffer.from(signed + 'x'), { key: publicKeyObject(keys.publicKey), dsaEncoding: 'ieee-p1363' }, sig), false)
})

test('the VAPID expiry is capped at 12 hours even when more is asked, and the audience keeps a non-default port', () => {
  const keys = generateVapidKeys()
  const now = 1_800_000_000_000
  const { claims } = jwtParts(vapidAuthorization({ endpoint: 'https://push.example.com:8443/x', vapid: { ...keys, subject: 'https://example.org/contact' }, now, expiresInSec: 7 * 24 * 3600 }))
  assert.equal(claims.aud, 'https://push.example.com:8443')
  assert.ok(claims.exp - now / 1000 <= 12 * 3600)
})

// ---- sendPush ---------------------------------------------------------------------------------------------------------------
function fakeFetch(status = 201, extra = {}) {
  const calls = []
  const fn = async (url, init) => { calls.push({ url, init }); if (extra.throws) throw extra.throws; return { status, ok: status >= 200 && status < 300, headers: new Map(Object.entries(extra.headers ?? {})), text: async () => '' } }
  fn.calls = calls
  return fn
}
const sub = (dev) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/token123', keys: { p256dh: dev.uaPublic, auth: dev.auth } })
const vapid = () => ({ ...generateVapidKeys(), subject: 'mailto:me@example.org' })

test('sendPush POSTs an encrypted JSON payload with the push headers and reports the status', async () => {
  const dev = newDevice()
  const f = fakeFetch(201)
  const r = await sendPush(sub(dev), { title: 'T', body: 'B', tag: 'q', url: '#/item/1' }, { ttl: 3600, urgency: 'high', topic: 'question', vapid: vapid(), fetch: f })
  assert.deepEqual({ status: r.status, gone: r.gone, ok: r.ok }, { status: 201, gone: false, ok: true })
  const { url, init } = f.calls[0]
  assert.equal(url, 'https://fcm.googleapis.com/fcm/send/token123')
  assert.equal(init.method, 'POST')
  const h = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]))
  assert.equal(h['content-encoding'], 'aes128gcm')
  assert.equal(h['content-type'], 'application/octet-stream')
  assert.equal(h.ttl, '3600')
  assert.equal(h.urgency, 'high')
  assert.equal(h.topic, 'question')
  assert.match(h.authorization, /^vapid t=.+, k=.+$/)
  assert.deepEqual(JSON.parse(decrypt(Buffer.from(init.body), dev.uaPrivate, dev.uaPublic, dev.auth).toString()), { title: 'T', body: 'B', tag: 'q', url: '#/item/1' })
})

test('sendPush defaults: 12 h TTL, normal urgency, no Topic header', async () => {
  const dev = newDevice()
  const f = fakeFetch(201)
  await sendPush(sub(dev), { title: 'T' }, { vapid: vapid(), fetch: f })
  const h = Object.fromEntries(Object.entries(f.calls[0].init.headers).map(([k, v]) => [k.toLowerCase(), v]))
  assert.equal(h.ttl, String(12 * 3600))
  assert.equal(h.urgency, 'normal')
  assert.equal('topic' in h, false)
})

test('a topic that is not 1-32 base64url characters is mapped to one that is; an unknown urgency falls back to normal', async () => {
  const dev = newDevice()
  const f = fakeFetch(201)
  await sendPush(sub(dev), { title: 'T' }, { vapid: vapid(), fetch: f, topic: 'permission waiting: a very long tag with spaces and more', urgency: 'URGENT' })
  const h = Object.fromEntries(Object.entries(f.calls[0].init.headers).map(([k, v]) => [k.toLowerCase(), v]))
  assert.match(h.topic, /^[A-Za-z0-9_-]{1,32}$/)
  assert.equal(h.urgency, 'normal')
  await sendPush(sub(dev), { title: 'T' }, { vapid: vapid(), fetch: f, topic: 'x'.repeat(33) })
  assert.match(Object.fromEntries(Object.entries(f.calls[1].init.headers).map(([k, v]) => [k.toLowerCase(), v])).topic, /^[A-Za-z0-9_-]{1,32}$/)
})

test('404 and 410 mean the subscription is gone; 429, 5xx and network errors do not', async () => {
  const dev = newDevice()
  const go = (status, extra) => sendPush(sub(dev), { title: 'T' }, { vapid: vapid(), fetch: fakeFetch(status, extra) })
  assert.equal((await go(410)).gone, true)
  assert.equal((await go(404)).gone, true)
  assert.deepEqual(await go(413).then((r) => [r.status, r.gone, r.ok]), [413, false, false])
  assert.equal((await go(429)).gone, false)
  assert.equal((await go(503)).gone, false)
  const net = await go(0, { throws: new Error('ECONNRESET') })
  assert.deepEqual([net.status, net.gone, net.ok], [0, false, false])
  assert.match(net.error, /ECONNRESET/)
})

test('sendPush never throws for a bad subscription; it reports the failure', async () => {
  const f = fakeFetch(201)
  const r = await sendPush({ endpoint: 'https://x.example/1', keys: { p256dh: 'AAAA', auth: 'AAAA' } }, { title: 'T' }, { vapid: vapid(), fetch: f })
  assert.equal(r.ok, false)
  assert.equal(r.status, 0)
  assert.equal(f.calls.length, 0)
  assert.ok(r.error)
})
