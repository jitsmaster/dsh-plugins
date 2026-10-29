// On-hold items whose owner is gone (the DSH app was restarted, so its instance key changed): Release and Continue used to answer 409 owner-offline
// ("That app is not running, so this cannot be sent."). Release is now settled by the hub itself (the item is resolved as released); Continue is run by an
// online app that is handed the item first, like a paused item. With no app online Continue is still owner-offline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AWAY_MS, GRACE_MS } from '../hub/instances.js'
import { postJson } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

const act = (port, kind, body) => postJson(port, P + '/v1/' + kind, body)
const held = (a, n) => a.add(n, { type: 'onhold', sessionId: 'sh' + n, sessionTitle: 'Fix: Thing - 25751', payload: { reason: 'Wait to finish other jobs', heldAt: 1000, ticket: null, baseline: null, lastCheckedAt: null, checkError: null } })

async function goneOwnerHub(t, { withB = true } = {}) {
  const ctx = await startHub(t)
  const a = agentOf(ctx.port)
  await a.register({ sync: sync() })
  await a.send(held(a, 1), held(a, 2))
  ctx.clock.advance(AWAY_MS + GRACE_MS + 1000)
  ctx.hub.instances.tick()
  assert.equal(ctx.hub.instances.get(a.id).state, 'gone')
  let b
  if (withB) {
    b = agentOf(ctx.port, { id: 'bbbb2222', key: 'k2', label: 'DSH :2' })
    await b.register({ sync: sync() })
  }
  return { ...ctx, a, b }
}

test('Release of a held item whose app is gone is settled by the hub: resolved as released, with or without another app online', async (t) => {
  const { hub, port, a } = await goneOwnerHub(t, { withB: false })
  const res = await act(port, 'hold-release', { id: a.itemId(1) })
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  const item = hub.store.get(a.itemId(1))
  assert.equal(item.status, 'resolved')
  assert.deepEqual([item.resolution.kind, item.resolution.by], ['released', 'card'])
})

test('Release of an already released item is refused as not-open', async (t) => {
  const { port, a } = await goneOwnerHub(t, { withB: false })
  await act(port, 'hold-release', { id: a.itemId(1) })
  const again = await act(port, 'hold-release', { id: a.itemId(1) })
  assert.deepEqual(again.json, { ok: false, error: 'not-open' })
})

test('Continue of a held item whose app is gone goes to the online app: handed the item first, then asked, and becomes the owner', async (t) => {
  const { hub, port, a, b } = await goneOwnerHub(t)
  const pending = act(port, 'hold-continue', { id: a.itemId(2) })
  const cmds = (await b.poll(0, 3000)).json.commands
  assert.deepEqual(cmds.map((c) => c.kind), ['apply', 'hold-continue'])
  assert.deepEqual([cmds[0].args.change.op, cmds[0].args.change.item.id], ['adopt', a.itemId(2)])
  await b.result(cmds[1].cid, { ok: true })
  assert.deepEqual([(await pending).status, (await pending).json], [200, { ok: true }])
  assert.equal(hub.store.get(a.itemId(2)).owner, b.id)
})

test('Continue with no app online is still owner-offline', async (t) => {
  const { port, a } = await goneOwnerHub(t, { withB: false })
  const res = await act(port, 'hold-continue', { id: a.itemId(1) })
  assert.deepEqual(res.json, { ok: false, error: 'owner-offline' })
})

test('Release of a held item whose app is only away is not taken: owner-away', async (t) => {
  const ctx = await startHub(t)
  const a = agentOf(ctx.port)
  await a.register({ sync: sync() })
  await a.send(held(a, 1))
  const b = agentOf(ctx.port, { id: 'bbbb2222', key: 'k2', label: 'DSH :2' })
  await b.register({ sync: sync() })
  ctx.clock.advance(AWAY_MS + 1000)
  ctx.hub.instances.tick()
  assert.equal(ctx.hub.instances.get(a.id).state, 'away')
  await b.post('sync', { sync: sync() })
  const res = await act(ctx.port, 'hold-release', { id: a.itemId(1) })
  assert.deepEqual(res.json, { ok: false, error: 'owner-away' })
})
