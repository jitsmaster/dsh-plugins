import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { b64u, generateVapidKeys } from '../hub/webpush.js'
import { tmpDir } from './hub-helpers.mjs'
import { P, startPhoneHub } from './hub-device-helpers.mjs'

const keys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64u(e.getPublicKey()), auth: b64u(randomBytes(16)) } }
const sub = (n = 1) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/token' + n, keys: keys() })

test('a phone subscribes through its token: the record belongs to that device, and no answer shows an endpoint or a key', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  const s = sub(1)
  const res = await p.call('POST', P + '/v1/push/subscribe', { subscription: s, name: 'Pixel' })
  assert.equal(res.status, 200)
  assert.equal(h.hub.push.devices()[0].deviceId, p.deviceId)
  const all = [res.text, (await p.call('GET', P + '/v1/push/devices')).text, (await h.desktop('GET', '/hub/v1/devices')).text, (await h.desktop('GET', P + '/v1/push/devices')).text]
  for (const text of all) for (const secret of [s.endpoint, s.keys.p256dh, s.keys.auth]) assert.ok(!text.includes(secret))
})

test('a phone sees and manages only its own subscription: another device\'s endpoint is unknown to it', async (t) => {
  const h = await startPhoneHub(t)
  const a = await h.pairPhone('A')
  const b = await h.pairPhone('B')
  const sa = sub(1)
  const sb = sub(2)
  const mine = (await a.call('POST', P + '/v1/push/subscribe', { subscription: sa })).json.device
  await b.call('POST', P + '/v1/push/subscribe', { subscription: sb })
  assert.equal((await a.call('GET', P + '/v1/push/devices')).json.devices.length, 1)
  assert.equal((await h.desktop('GET', P + '/v1/push/devices')).json.devices.length, 2)
  assert.equal((await a.call('POST', P + '/v1/push/settings', { endpoint: sb.endpoint, name: 'Hijack' })).status, 404)
  assert.equal((await a.call('POST', P + '/v1/push/test', { endpoint: sb.endpoint })).status, 404)
  assert.equal((await a.call('POST', P + '/v1/push/unsubscribe', { endpoint: sb.endpoint })).json.removed, false)
  assert.equal((await a.call('POST', P + '/v1/push/unsubscribe', { id: h.hub.push.devices().find((d) => d.deviceId === b.deviceId).id })).json.removed, false)
  assert.equal(h.hub.push.devices().length, 2)
  assert.equal((await a.call('POST', P + '/v1/push/test', { endpoint: sa.endpoint })).status, 200)
  assert.equal(h.pushes.length, 1, 'the test push went to the phone that asked')
  assert.equal((await a.call('POST', P + '/v1/push/unsubscribe', { id: mine.id })).json.removed, true)
})

test('the phone cannot choose its deviceId through the body', async (t) => {
  const h = await startPhoneHub(t)
  const a = await h.pairPhone('A')
  await a.call('POST', P + '/v1/push/subscribe', { subscription: sub(1), deviceId: 'dv_somebody' })
  assert.equal(h.hub.push.devices()[0].deviceId, a.deviceId)
})

test('a legacy push.json is imported to hub/push.json; its phone keeps its record and a paired phone with the same endpoint absorbs it', async (t) => {
  const dir = tmpDir(t)
  const s = sub(7)
  writeFileSync(join(dir, 'push.json'), JSON.stringify({ v: 1, devices: [{ id: 'old1', endpoint: s.endpoint, keys: s.keys, name: 'Old phone', types: { permission: true, question: true, 'pr-merged': true, completed: false }, quiet: { enabled: false, start: '22:00', end: '07:00', tz: 'UTC' }, createdAt: 5, lastSuccessAt: null, lastError: null }] }))
  const h = await startPhoneHub(t, { dir })
  assert.ok(existsSync(join(dir, 'hub', 'push.json')))
  const legacy = (await h.desktop('GET', '/hub/v1/devices')).json
  assert.deepEqual(legacy.legacy.map((d) => [d.id, d.name]), [['old1', 'Old phone']])
  assert.ok(!JSON.stringify(legacy).includes(s.endpoint))
  const p = await h.pairPhone()
  const r = await p.call('POST', P + '/v1/push/subscribe', { subscription: s })
  assert.equal(r.json.device.id, 'old1')
  assert.equal(r.json.device.types.completed, false)
  assert.equal(h.hub.push.devices().length, 1)
  assert.deepEqual((await h.desktop('GET', '/hub/v1/devices')).json.legacy, [])
  assert.equal(readFileSync(join(dir, 'push.json'), 'utf8').includes('old1'), true, 'the old file is untouched')
})

test('a legacy subscription can be removed from the devices page (a lost old phone)', async (t) => {
  const dir = tmpDir(t)
  const s = sub(7)
  writeFileSync(join(dir, 'push.json'), JSON.stringify({ v: 1, devices: [{ id: 'old1', endpoint: s.endpoint, keys: s.keys, name: 'Old phone', createdAt: 5 }] }))
  const h = await startPhoneHub(t, { dir })
  assert.equal((await h.desktop('POST', '/hub/v1/devices/old1/revoke', {})).status, 200)
  assert.equal(h.hub.push.devices().length, 0)
})

test('hub/vapid.json is the legacy vapid.json at first start: the same key pair, so subscriptions stay valid', async (t) => {
  const dir = tmpDir(t)
  const keysPair = generateVapidKeys()
  writeFileSync(join(dir, 'vapid.json'), JSON.stringify({ v: 1, ...keysPair }))
  const h = await startPhoneHub(t, { dir })
  const p = await h.pairPhone()
  assert.deepEqual((await p.call('GET', P + '/v1/push/key')).json, { key: keysPair.publicKey })
  assert.equal(JSON.parse(readFileSync(join(dir, 'hub', 'vapid.json'), 'utf8')).publicKey, keysPair.publicKey)
})

test('without any legacy vapid.json the hub creates its own pair once and keeps it across a restart', async (t) => {
  const dir = tmpDir(t)
  const first = await startPhoneHub(t, { dir })
  const key = (await first.pairPhone().then((p) => p.call('GET', P + '/v1/push/key'))).json.key
  assert.equal(key.length, 87)
  await first.hub.stop()
  mkdirSync(dir, { recursive: true })
  const second = await startPhoneHub(t, { dir })
  const again = await (await second.pairPhone()).call('GET', P + '/v1/push/key')
  assert.equal(again.json.key, key)
})

test('hub.config.json pushSubject is the VAPID contact used when sending', async (t) => {
  const h = await startPhoneHub(t, { config: { pushSubject: 'https://example.org/contact' } })
  const p = await h.pairPhone()
  const s = sub(1)
  await p.call('POST', P + '/v1/push/subscribe', { subscription: s })
  await p.call('POST', P + '/v1/push/test', { endpoint: s.endpoint })
  assert.equal(h.pushes[0].opts.vapid.subject, 'https://example.org/contact')
})
