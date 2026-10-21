// Paused items whose owner is gone (an app that was stopped or restarted: its port, so its instance key, changes at every DSH start):
// resume and dismiss used to answer 409 owner-offline ("That app is not running") although another app is online. Like an ownerless item,
// the coordinator now takes such an item (it is handed a copy first), runs the action and keeps it on success; with no app online it is still owner-offline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AWAY_MS, GRACE_MS } from '../hub/instances.js'
import { postJson } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

const act = (port, kind, body) => postJson(port, P + '/v1/' + kind, body)
const paused = (a, n) => a.add(n, { type: 'paused', sessionId: 'sp' + n, payload: { lastWrite: 1_800_000_000_000, kinds: ['open-turn'] } })

/** App a owns two paused items and one done item, then goes gone; app b (another key) comes online without reporting those sessions. */
async function goneOwnerHub(t) {
  const ctx = await startHub(t)
  const a = agentOf(ctx.port)
  await a.register({ sync: sync() })
  await a.send(paused(a, 1), paused(a, 2), a.add(3, { sessionId: 'sd' }))
  ctx.clock.advance(AWAY_MS + GRACE_MS + 1000)
  ctx.hub.instances.tick()
  assert.equal(ctx.hub.instances.get(a.id).state, 'gone')
  const b = agentOf(ctx.port, { id: 'bbbb2222', key: 'k2', label: 'DSH :2' })
  await b.register({ sync: sync() })
  return { ...ctx, a, b }
}

test('resume of a paused item of a gone owner goes to the online app: it is handed the item first, then asked, and becomes the owner', async (t) => {
  const { hub, port, a, b } = await goneOwnerHub(t)
  assert.equal(hub.store.get(a.itemId(1)).owner, a.id, 'still owned by the gone app')
  const pending = act(port, 'paused-resume', { id: a.itemId(1) })
  const cmds = (await b.poll(0, 3000)).json.commands
  assert.deepEqual(cmds.map((c) => c.kind), ['apply', 'paused-resume'])
  assert.deepEqual([cmds[0].args.change.op, cmds[0].args.change.item.id], ['adopt', a.itemId(1)])
  assert.equal(cmds[1].itemId, a.itemId(1))
  await b.result(cmds[1].cid, { ok: true })
  const res = await pending
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  assert.equal(hub.store.get(a.itemId(1)).owner, b.id)
})

test('dismiss of a paused item of a gone owner goes to the online app the same way', async (t) => {
  const { hub, port, a, b } = await goneOwnerHub(t)
  const pending = act(port, 'paused-dismiss', { id: a.itemId(2) })
  const cmd = (await b.poll(0, 3000)).json.commands.find((c) => c.kind === 'paused-dismiss')
  assert.equal(cmd?.itemId, a.itemId(2))
  await b.result(cmd.cid, { ok: true })
  assert.equal((await pending).status, 200)
  assert.equal(hub.store.get(a.itemId(2)).owner, b.id)
})

test('when the app refuses (session gone) the item goes back to its previous owner and the refusal reaches the card', async (t) => {
  const { hub, port, a, b } = await goneOwnerHub(t)
  const pending = act(port, 'paused-resume', { id: a.itemId(1) })
  const cmd = (await b.poll(0, 3000)).json.commands.find((c) => c.kind === 'paused-resume')
  await b.result(cmd.cid, { ok: false, error: 'session-gone' })
  assert.deepEqual((await pending).json, { ok: false, error: 'session-gone' })
  assert.equal(hub.store.get(a.itemId(1)).owner, a.id)
})

test('no-session from the app reaches the card as session-unavailable', async (t) => {
  const { port, a, b } = await goneOwnerHub(t)
  const pending = act(port, 'paused-resume', { id: a.itemId(1) })
  const cmd = (await b.poll(0, 3000)).json.commands.find((c) => c.kind === 'paused-resume')
  await b.result(cmd.cid, { ok: false, error: 'no-session' })
  assert.deepEqual((await pending).json, { ok: false, error: 'session-unavailable' })
})

test('with no app online a paused item of a gone owner is still owner-offline', async (t) => {
  const ctx = await startHub(t)
  const a = agentOf(ctx.port)
  await a.register({ sync: sync() })
  await a.send(paused(a, 1))
  ctx.clock.advance(AWAY_MS + GRACE_MS + 1000)
  ctx.hub.instances.tick()
  const res = await act(ctx.port, 'paused-resume', { id: a.itemId(1) })
  assert.deepEqual(res.json, { ok: false, error: 'owner-offline' })
})

test('only paused items change hands this way: archive of a done item of a gone owner is still owner-offline', async (t) => {
  const { port, a } = await goneOwnerHub(t)
  const res = await act(port, 'archive', { id: a.itemId(3) })
  assert.deepEqual(res.json, { ok: false, error: 'owner-offline' })
})

test('a paused item whose owner is only away is not taken: owner-away', async (t) => {
  const ctx = await startHub(t)
  const a = agentOf(ctx.port)
  await a.register({ sync: sync() })
  await a.send(paused(a, 1))
  const b = agentOf(ctx.port, { id: 'bbbb2222', key: 'k2', label: 'DSH :2' })
  await b.register({ sync: sync() })
  ctx.clock.advance(AWAY_MS + 1000)
  ctx.hub.instances.tick()
  assert.equal(ctx.hub.instances.get(a.id).state, 'away')
  await b.post('sync', { sync: sync() }) // keeps b online
  const res = await act(ctx.port, 'paused-resume', { id: a.itemId(1) })
  assert.deepEqual(res.json, { ok: false, error: 'owner-away' })
})
