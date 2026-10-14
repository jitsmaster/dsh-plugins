import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPushStore, loadOrCreateVapid, jsonFileIo } from '../push.js'
import { b64u, publicKeyOf } from '../webpush.js'

const keys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64u(e.getPublicKey()), auth: b64u(randomBytes(16)) } }
const sub = (n = 1) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/token' + n, keys: keys() })
const memoryIo = () => { const io = { text: undefined, writes: 0, read: () => io.text, write: (t) => { io.text = t; io.writes++ } }; return io }
const make = (extra = {}) => {
  let n = 0
  const io = extra.io ?? memoryIo()
  const sent = []
  const sendPush = async (subscription, payload, opts) => { sent.push({ subscription, payload, opts }); return extra.result ?? { ok: true, status: 201, gone: false } }
  const store = createPushStore({ io, now: () => 1000 + n, uuid: () => 'd' + ++n, sendPush, vapid: { publicKey: 'PUB', privateKey: 'PRIV', subject: 'mailto:a@b.c' }, ...extra.deps })
  return { store, io, sent }
}
const input = (over = {}) => ({ subscription: sub(), name: 'Pixel 7', types: { permission: true, question: true, 'pr-merged': true, completed: true }, quiet: { enabled: false, start: '22:00', end: '07:00', tz: 'Europe/Berlin' }, ...over })

test('a new device gets an id, all types on and quiet hours off by default', () => {
  const { store } = make()
  const r = store.upsert({ subscription: sub() })
  assert.equal(r.ok, true)
  assert.equal(r.device.id, 'd1')
  assert.deepEqual(r.device.types, { permission: true, question: true, 'pr-merged': true, completed: true })
  assert.equal(r.device.quiet.enabled, false)
  assert.equal(r.device.name, '')
  assert.equal(r.device.createdAt, store.list()[0].createdAt)
})

test('the public device never carries the endpoint or the keys; the full record does', () => {
  const { store } = make()
  const s = sub()
  const { device } = store.upsert(input({ subscription: s }))
  const text = JSON.stringify([device, store.list()])
  assert.ok(!text.includes(s.endpoint) && !text.includes(s.keys.p256dh) && !text.includes(s.keys.auth))
  assert.equal(store.find({ id: device.id }).endpoint, s.endpoint)
  assert.equal(store.find({ endpoint: s.endpoint }).keys.auth, s.keys.auth)
  assert.equal(store.devices()[0].keys.p256dh, s.keys.p256dh)
})

test('subscribing again with the same endpoint updates that device (same id) instead of adding one', () => {
  const { store } = make()
  const s = sub()
  const first = store.upsert(input({ subscription: s, name: 'Old' })).device
  const again = store.upsert(input({ subscription: { endpoint: s.endpoint, keys: keys() }, name: 'New', types: { question: false } })).device
  assert.equal(again.id, first.id)
  assert.equal(store.list().length, 1)
  assert.equal(again.name, 'New')
  assert.equal(again.types.question, false)
  assert.equal(again.types.permission, true)
  assert.equal(again.createdAt, first.createdAt)
})

test('settings update changes only the fields that are sent', () => {
  const { store } = make()
  const s = sub()
  store.upsert(input({ subscription: s, name: 'Pixel' }))
  const r = store.update(s.endpoint, { types: { completed: false } })
  assert.equal(r.ok, true)
  assert.equal(r.device.name, 'Pixel')
  assert.equal(r.device.types.completed, false)
  assert.equal(r.device.types.question, true)
  const q = store.update(s.endpoint, { quiet: { enabled: true, start: '23:00', end: '06:30', tz: 'UTC' } })
  assert.deepEqual(q.device.quiet, { enabled: true, start: '23:00', end: '06:30', tz: 'UTC' })
  assert.deepEqual(store.update('https://fcm.googleapis.com/nope', { name: 'x' }), { ok: false, error: 'unknown-device' })
})

test('input is validated: endpoint, keys, name, types and quiet hours', () => {
  const { store } = make()
  const bad = (i, error) => { const r = store.upsert(i); assert.deepEqual([r.ok, r.error], [false, error], error) }
  bad({}, 'bad-endpoint')
  bad({ subscription: { endpoint: 'http://push.example/1', keys: keys() } }, 'bad-endpoint')
  bad({ subscription: { endpoint: 'not a url', keys: keys() } }, 'bad-endpoint')
  bad({ subscription: { endpoint: 'https://user:pw@push.example/1', keys: keys() } }, 'bad-endpoint')
  bad({ subscription: { endpoint: 'https://localhost/1', keys: keys() } }, 'bad-endpoint')
  bad({ subscription: { endpoint: 'https://127.0.0.1/1', keys: keys() } }, 'bad-endpoint')
  bad({ subscription: { endpoint: 'https://192.168.1.5/1', keys: keys() } }, 'bad-endpoint')
  bad({ subscription: { endpoint: 'https://[::1]/1', keys: keys() } }, 'bad-endpoint')
  bad({ subscription: { endpoint: 'https://push.example/' + 'a'.repeat(2100), keys: keys() } }, 'bad-endpoint')
  bad({ subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'AAAA', auth: keys().auth } } }, 'bad-keys')
  bad({ subscription: { endpoint: 'https://push.example/1', keys: { p256dh: keys().p256dh, auth: 'x y' } } }, 'bad-keys')
  bad({ subscription: { endpoint: 'https://push.example/1' } }, 'bad-keys')
  bad(input({ name: 'x'.repeat(41) }), 'bad-name')
  bad(input({ name: 7 }), 'bad-name')
  bad(input({ types: { question: 'yes' } }), 'bad-types')
  bad(input({ types: [true] }), 'bad-types')
  bad(input({ quiet: { enabled: true, start: '25:00', end: '07:00', tz: 'UTC' } }), 'bad-quiet')
  bad(input({ quiet: { enabled: true, start: '08:00', end: '08:00', tz: 'UTC' } }), 'bad-quiet')
  bad(input({ quiet: 'always' }), 'bad-quiet')
  assert.equal(store.list().length, 0)
  assert.equal(store.upsert(input({ name: '  Pixel  ' })).device.name, 'Pixel')
})

test('unknown type names are ignored, and at most 20 devices can register', () => {
  const { store } = make()
  assert.deepEqual(Object.keys(store.upsert(input({ types: { weather: true } })).device.types).sort(), ['completed', 'permission', 'pr-merged', 'question'])
  for (let i = 2; i <= 20; i++) assert.equal(store.upsert(input({ subscription: sub(i) })).ok, true)
  assert.deepEqual(store.upsert(input({ subscription: sub(21) })), { ok: false, error: 'too-many-devices' })
  assert.equal(store.upsert(input({ subscription: sub(5) })).ok, true, 'an existing device can still update')
})

test('remove works by id or by endpoint and reports whether anything was removed', () => {
  const { store } = make()
  const a = sub(1), b = sub(2)
  const ida = store.upsert(input({ subscription: a })).device.id
  store.upsert(input({ subscription: b }))
  assert.equal(store.remove({ id: ida }), true)
  assert.equal(store.remove({ id: ida }), false)
  assert.equal(store.remove({ endpoint: b.endpoint }), true)
  assert.equal(store.remove({}), false)
  assert.equal(store.list().length, 0)
})

test('send hands the stored subscription to the sender, records the success and passes the options on', async () => {
  const { store, sent } = make()
  const s = sub()
  const { device } = store.upsert(input({ subscription: s }))
  const r = await store.send(device.id, { title: 'T' }, { ttl: 60, urgency: 'high', topic: 'question' })
  assert.deepEqual([r.ok, r.status, r.removed], [true, 201, false])
  assert.deepEqual(sent[0].subscription, s)
  assert.deepEqual(sent[0].payload, { title: 'T' })
  assert.equal(sent[0].opts.ttl, 60)
  assert.equal(sent[0].opts.urgency, 'high')
  assert.equal(sent[0].opts.topic, 'question')
  assert.equal(sent[0].opts.vapid.publicKey, 'PUB')
  assert.ok(store.list()[0].lastSuccessAt > 0)
  assert.equal(store.list()[0].lastError, null)
})

test('a 410 or 404 from the push service removes the device; other failures keep it and record the error', async () => {
  for (const status of [404, 410]) {
    const { store } = make({ result: { ok: false, status, gone: true, error: 'HTTP ' + status } })
    const { device } = store.upsert(input())
    const r = await store.send(device.id, { title: 'T' })
    assert.equal(r.removed, true)
    assert.equal(store.list().length, 0)
  }
  const { store } = make({ result: { ok: false, status: 503, gone: false, error: 'HTTP 503' } })
  const { device } = store.upsert(input())
  const r = await store.send(device.id, { title: 'T' })
  assert.deepEqual([r.ok, r.removed], [false, false])
  assert.equal(store.list()[0].lastError, 'HTTP 503')
  assert.equal(store.list()[0].lastSuccessAt, null)
})

test('send to an unknown device is a quiet failure', async () => {
  const { store, sent } = make()
  const r = await store.send('nope', { title: 'T' })
  assert.deepEqual([r.ok, r.error, r.removed], [false, 'unknown-device', false])
  assert.equal(sent.length, 0)
})

test('devices are saved after every change and reloaded; a corrupt file starts empty', () => {
  const io = memoryIo()
  const a = make({ io })
  const s = sub()
  const { device } = a.store.upsert(input({ subscription: s, name: 'Pixel' }))
  assert.ok(io.writes >= 1)
  const b = make({ io })
  assert.equal(b.store.list().length, 1)
  assert.equal(b.store.find({ id: device.id }).keys.auth, s.keys.auth)
  b.store.remove({ id: device.id })
  assert.equal(make({ io }).store.list().length, 0)
  io.text = '{broken'
  assert.equal(make({ io }).store.list().length, 0)
  io.text = JSON.stringify({ v: 1, devices: [{ id: 'x' }, { id: 'y', endpoint: 'http://insecure/1', keys: keys() }] })
  assert.equal(make({ io }).store.list().length, 0, 'records that do not validate are dropped on load')
})

test('an unwritable file never throws', () => {
  const io = { read: () => undefined, write: () => { throw new Error('disk full') } }
  const { store } = make({ io })
  assert.equal(store.upsert(input()).ok, true)
})

test('jsonFileIo writes atomically through a temp file and reads back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-push-'))
  try {
    const file = join(dir, 'push.json')
    const io = jsonFileIo(file, { mode: 0o600 })
    assert.equal(io.read(), undefined)
    io.write('{"a":1}')
    assert.equal(io.read(), '{"a":1}')
    assert.deepEqual(readdirSync(dir), ['push.json'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loadOrCreateVapid creates the key pair once, keeps it, and regenerates a broken file', () => {
  const io = memoryIo()
  const a = loadOrCreateVapid({ io, subject: 'mailto:me@example.org' })
  assert.equal(a.subject, 'mailto:me@example.org')
  assert.equal(publicKeyOf(a.privateKey), a.publicKey)
  assert.equal(io.writes, 1)
  const b = loadOrCreateVapid({ io, subject: 'mailto:me@example.org' })
  assert.deepEqual(b, a)
  assert.equal(io.writes, 1, 'unchanged keys are not rewritten')
  io.text = JSON.stringify({ v: 1, publicKey: a.publicKey, privateKey: loadOrCreateVapid({ io: memoryIo() }).privateKey })
  const c = loadOrCreateVapid({ io })
  assert.equal(publicKeyOf(c.privateKey), c.publicKey, 'a mismatched pair is replaced')
  assert.notEqual(c.publicKey, a.publicKey)
  io.text = 'garbage'
  assert.equal(publicKeyOf(loadOrCreateVapid({ io }).privateKey).length, 87)
})

test('loadOrCreateVapid without a file still returns working keys, and the default subject is a mailto', () => {
  const v = loadOrCreateVapid({})
  assert.match(v.subject, /^(mailto:|https:\/\/)/)
  assert.equal(publicKeyOf(v.privateKey), v.publicKey)
})
