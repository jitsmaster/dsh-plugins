import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { b64u } from '../hub/webpush.js'
import { agentOf, sync } from './hub-agent-helpers.mjs'
import { fakeClock } from './hub-helpers.mjs'
import { P, startPhoneHub } from './hub-device-helpers.mjs'

// The notifier inside the real hub: items come from an agent over HTTP, the phone subscribes with its token, presence comes from the desktop poll.
const keys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64u(e.getPublicKey()), auth: b64u(randomBytes(16)) } }

async function world(t) {
  const clock = fakeClock()
  const h = await startPhoneHub(t, { clock, timers: clock })
  const a = agentOf(h.port)
  await a.register({ sync: sync() })
  const p = await h.pairPhone()
  await p.call('POST', P + '/v1/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/phone', keys: keys() }, name: 'Pixel' })
  let n = 0
  const permission = () => a.send(a.add(++n, { type: 'permission', sessionTitle: 'Secret session', payload: { toolName: 'shell', summary: 'secret command', detail: 'secret command' } }))
  const advance = async (ms) => { h.clock.advance(ms); await new Promise((r) => setImmediate(r)) }
  return { ...h, a, p, permission, advance }
}

test('a permission request of an app reaches the phone as a push with the type and the count only', async (t) => {
  const w = await world(t)
  await w.permission()
  await w.advance(500)
  assert.equal(w.pushes.length, 1)
  assert.equal(w.pushes[0].payload.title, 'Permission waiting')
  assert.equal(w.pushes[0].payload.body, '1 item')
  assert.ok(!JSON.stringify(w.pushes).includes('secret'))
})

test('a desktop overlay that is being looked at (visible=1) holds the push for 60 s; a phone poll saying visible=1 does not', async (t) => {
  const w = await world(t)
  await w.desktop('GET', P + '/v1/snapshot?visible=1')
  await w.permission()
  await w.advance(500)
  assert.equal(w.pushes.length, 0, 'held')
  await w.advance(61_000)
  assert.equal(w.pushes.length, 1, 'still open after 60 s without a look')
  const other = await world(t)
  await other.p.call('GET', P + '/v1/snapshot?visible=1')
  await other.desktop('GET', P + '/v1/snapshot')
  await other.permission()
  await other.advance(500)
  assert.equal(other.pushes.length, 1, 'neither a phone poll nor a desktop poll without the flag is presence')
})

test('a revoked phone gets no more pushes', async (t) => {
  const w = await world(t)
  await w.desktop('POST', '/hub/v1/devices/' + w.p.deviceId + '/revoke', {})
  await w.permission()
  await w.advance(500)
  assert.deepEqual(w.pushes, [])
})
