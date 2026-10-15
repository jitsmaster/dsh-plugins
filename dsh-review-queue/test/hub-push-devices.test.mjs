import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPushStore, jsonFileIo } from '../hub/push.js'
import { b64u } from '../hub/webpush.js'

// The push store of the hub: every subscription may belong to a paired device (deviceId) or be a legacy record without one (docs/hub.md 12.2).
const keys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64u(e.getPublicKey()), auth: b64u(randomBytes(16)) } }
const sub = (n = 1) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/token' + n, keys: keys() })
const memoryIo = (text) => { const io = { text, read: () => io.text, write: (t) => { io.text = t } }; return io }
const make = (extra = {}) => {
  let n = 0
  const io = extra.io ?? memoryIo()
  const store = createPushStore({ io, now: () => 1000 + n, uuid: () => 'p' + ++n, sendPush: async () => ({ ok: true, status: 201, gone: false }), vapid: { publicKey: 'PUB', privateKey: 'PRIV', subject: 'mailto:a@b.c' }, ...extra.deps })
  return { store, io }
}

test('a subscription made by a paired device carries its deviceId, and the list can be cut to one device', () => {
  const { store } = make()
  store.upsert({ subscription: sub(1), deviceId: 'dv_a' })
  store.upsert({ subscription: sub(2), deviceId: 'dv_b' })
  store.upsert({ subscription: sub(3) })
  assert.deepEqual(store.list().map((d) => d.deviceId), ['dv_a', 'dv_b', null])
  assert.deepEqual(store.list({ deviceId: 'dv_b' }).map((d) => d.id), ['p2'])
  assert.equal(store.devices().filter((d) => d.deviceId === 'dv_a').length, 1)
})

test('a device has one subscription: subscribing again with another endpoint replaces the old one', () => {
  const { store } = make()
  store.upsert({ subscription: sub(1), deviceId: 'dv_a', name: 'Pixel' })
  const r = store.upsert({ subscription: sub(2), deviceId: 'dv_a' })
  assert.equal(r.ok, true)
  assert.equal(store.list().length, 1)
  assert.equal(store.devices()[0].endpoint, sub(2).endpoint)
})

test('a legacy record (no deviceId) is absorbed by the paired device that subscribes with the same endpoint: same record, settings kept', () => {
  const { store } = make()
  const s = sub(1)
  const legacy = store.upsert({ subscription: s, name: 'Old phone', types: { completed: false } }).device
  const r = store.upsert({ subscription: s, deviceId: 'dv_a' })
  assert.equal(store.list().length, 1)
  assert.equal(r.device.id, legacy.id)
  assert.equal(r.device.deviceId, 'dv_a')
  assert.equal(r.device.types.completed, false, 'the settings of the legacy record stay unless the phone sends new ones')
  assert.equal(r.device.name, 'Old phone')
})

test('an endpoint that belonged to another paired device moves to the one that subscribes with it now', () => {
  const { store } = make()
  const s = sub(1)
  store.upsert({ subscription: s, deviceId: 'dv_old' })
  const r = store.upsert({ subscription: s, deviceId: 'dv_new' })
  assert.equal(r.device.deviceId, 'dv_new')
  assert.equal(store.list().length, 1)
})

test('removeByDevice drops every subscription of that device and reports how many; legacy and other devices stay', () => {
  const { store } = make()
  store.upsert({ subscription: sub(1), deviceId: 'dv_a' })
  store.upsert({ subscription: sub(2), deviceId: 'dv_b' })
  store.upsert({ subscription: sub(3) })
  assert.equal(store.removeByDevice('dv_a'), 1)
  assert.equal(store.removeByDevice('dv_a'), 0)
  assert.deepEqual(store.list().map((d) => d.deviceId), ['dv_b', null])
})

test('a push.json written before devices existed loads as legacy records and is saved with deviceId null', () => {
  const s = sub(1)
  const old = JSON.stringify({ v: 1, devices: [{ id: 'x1', endpoint: s.endpoint, keys: s.keys, name: 'Old', types: { permission: true }, quiet: { enabled: false, start: '22:00', end: '07:00', tz: 'UTC' }, createdAt: 5, lastSuccessAt: null, lastError: null }] })
  const { store, io } = make({ io: memoryIo(old) })
  assert.deepEqual(store.list().map((d) => [d.id, d.deviceId]), [['x1', null]])
  store.update(s.endpoint, { name: 'Renamed' })
  assert.equal(JSON.parse(io.text).devices[0].deviceId, null)
})

test('the VAPID key can be a function that is only called when a push is sent (the pair is created on first use)', async () => {
  let calls = 0
  let seen
  const { store } = make({ deps: { vapid: () => { calls++; return { publicKey: 'LAZY', privateKey: 'k', subject: 'mailto:a@b.c' } }, sendPush: async (s, p, o) => { seen = o.vapid; return { ok: true, status: 201, gone: false } } } })
  const { device } = store.upsert({ subscription: sub(1), deviceId: 'dv_a' })
  assert.equal(calls, 0)
  await store.send(device.id, { title: 't' })
  assert.equal(calls, 1)
  assert.equal(seen.publicKey, 'LAZY')
})

test('jsonFileIo runs the prepare hook on the temp file before it replaces the target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-push-'))
  try {
    const seen = []
    const io = jsonFileIo(join(dir, 'push.json'), { prepare: (tmp) => seen.push(tmp) })
    io.write('{"a":1}')
    assert.equal(seen.length, 1)
    assert.match(seen[0], /push\.json\.tmp$/)
    assert.equal(readFileSync(join(dir, 'push.json'), 'utf8'), '{"a":1}')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
