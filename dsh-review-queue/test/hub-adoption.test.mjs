// Adoption by session id (docs/hub.md 6.3): an open completed / pr-merged / todo item whose owner is missing (legacy import) or gone is taken over by
// an ONLINE instance that reports its session, at register and at every sync, and the instance is handed the item (it has no local copy).
// The fixtures are the real hub started on a directory that holds a legacy queue.json like the real one (350 items, a few open, no owner).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AWAY_MS, GRACE_MS } from '../hub/instances.js'
import { postJson, tmpDir } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

const LIVE = '0808d66c-91a'
const LIVE_SESSION = 'session-018f784c-live'
const NOW = 1_800_000_000_000
const row = (id, over = {}) => ({ id, seq: 1, type: 'completed', status: 'open', createdAt: NOW, sessionId: 's-' + id, payload: { reply: 'r' }, ...over })

/** A legacy queue.json as the real one: many resolved items and three open ones, one of them for a session that is live today. */
function seedLegacy(dir) {
  const resolved = Array.from({ length: 347 }, (_, i) => row('old' + i, { seq: i + 1, status: 'resolved', resolvedAt: NOW, resolution: { kind: 'reviewed', by: 'card' } }))
  const open = [
    row(LIVE, { seq: 348, sessionId: LIVE_SESSION, sessionTitle: 'PWA - 2' }),
    row('nobody1', { seq: 349, sessionId: 'session-nobody-has' }),
    row('todo1', { seq: 350, type: 'todo', sessionId: 'session-todo', state: 'started' }),
  ]
  writeFileSync(join(dir, 'queue.json'), JSON.stringify({ v: 1, seq: 350, items: [...resolved, ...open] }))
}
async function legacyHub(t, over = {}) {
  const dir = tmpDir(t)
  seedLegacy(dir)
  const ctx = await startHub(t, { dir, ...over })
  assert.equal(ctx.hub.store.list().length, 350, 'the legacy import is the starting point')
  assert.equal(ctx.hub.store.get(LIVE).owner, undefined)
  return ctx
}
const ids = (items) => items.map((i) => i.id)

test('a legacy ownerless item is adopted by the app that registers with its session: it gets the item, the hub logs it, a reply reaches that app', async (t) => {
  const { hub, port, logs } = await legacyHub(t)
  const a = agentOf(port)
  const r = await a.register({ sync: sync({ sessionIds: [LIVE_SESSION, 'unrelated'] }) })
  assert.deepEqual(ids(r.json.adoptedItems), [LIVE])
  assert.equal(r.json.adoptedItems[0].sessionId, LIVE_SESSION)
  assert.equal(hub.store.get(LIVE).owner, a.id)
  assert.equal(hub.store.get('nobody1').owner, undefined, 'an item whose session nobody reports stays as it was')
  assert.ok(logs.includes('adopted 1 by session'), logs.join('|'))
  const snap = hub.snapshot().open.find((i) => i.id === LIVE)
  assert.deepEqual([snap.ownerLabel, snap.ownerState], ['DSH :1', 'online'])

  const pending = postJson(port, P + '/v1/reply', { id: LIVE, text: 'restarted' })
  const cmd = (await a.poll(0, 3000)).json.commands.find((c) => c.kind === 'reply')
  assert.deepEqual([cmd.itemId, cmd.args.text], [LIVE, 'restarted'])
  await a.result(cmd.cid, { ok: true })
  const res = await pending
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
})

test('a session the app learns later is adopted by the next sync, and the sync answer carries the item', async (t) => {
  const { hub, port, logs } = await legacyHub(t)
  const a = agentOf(port)
  const first = await a.register({ sync: sync({ sessionIds: ['unrelated'] }) })
  assert.deepEqual([first.json.adoptedItems, hub.store.get(LIVE).owner], [[], undefined])
  const second = await a.post('sync', { sync: sync({ sessionIds: ['unrelated', LIVE_SESSION, 'session-todo'] }) })
  assert.equal(second.status, 200)
  assert.deepEqual(ids(second.json.adoptedItems).sort(), [LIVE, 'todo1'])
  assert.equal(hub.store.get(LIVE).owner, a.id)
  assert.equal(hub.store.get('todo1').owner, a.id, 'a todo is adopted like completed work')
  assert.ok(logs.includes('adopted 2 by session'))
  const again = await a.post('sync', { sync: sync({ sessionIds: [LIVE_SESSION], openItems: [hub.store.get(LIVE), hub.store.get('todo1')] }) })
  assert.deepEqual(again.json.adoptedItems, [], 'nothing left to adopt, nothing is handed twice once the app lists the items')
})

test('items of a gone owner move to a new app with a different key that has their session; a gone owner open question stays settled', async (t) => {
  const { hub, port, clock } = await startHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, { sessionId: 'sa' }), a.add(2, { type: 'pr-merged', sessionId: 'sb' }), a.add(3, { type: 'question', sessionId: 'sq', payload: { questions: [] } }))
  clock.advance(AWAY_MS + GRACE_MS + 1000)
  hub.instances.tick()
  assert.equal(hub.instances.get(a.id).state, 'gone')
  assert.equal(hub.store.get(a.itemId(3)).resolution.reason, 'owner-gone')

  const b = agentOf(port, { id: 'bbbb2222', key: 'pid-other', label: 'DSH :2' })
  const r = await b.register({ sync: sync({ sessionIds: ['sa', 'sb', 'sq'] }) })
  assert.deepEqual(ids(r.json.adoptedItems).sort(), [a.itemId(1), a.itemId(2)])
  assert.deepEqual([hub.store.get(a.itemId(1)).owner, hub.store.get(a.itemId(2)).owner], [b.id, b.id])
  const q = hub.store.get(a.itemId(3))
  assert.deepEqual([q.status, q.resolution.kind, q.resolution.reason, q.owner], ['resolved', 'session-ended', 'owner-gone', a.id], 'the promise died with its process: not adoptable')
})

test('an owner that is only away (or not back yet after a hub restart) keeps its items; an online owner is not robbed by another app', async (t) => {
  const { hub, port, clock } = await startHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, { sessionId: 'sa' }))
  const b = agentOf(port, { id: 'bbbb2222', key: 'k2', label: 'DSH :2' })
  await b.register({ sync: sync({ sessionIds: ['sa'] }) })
  assert.equal(hub.store.get(a.itemId(1)).owner, a.id, 'the owner is online')
  clock.advance(AWAY_MS + 1000)
  hub.instances.tick()
  assert.equal(hub.instances.get(a.id).state, 'away')
  await b.post('sync', { sync: sync({ sessionIds: ['sa'] }) })
  assert.equal(hub.store.get(a.itemId(1)).owner, a.id, 'away is not gone')
})

test('a restart with the same key still hands the new app the items it takes over, even without a local copy', async (t) => {
  const { hub, port } = await startHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, { sessionId: 'sa' }), a.add(2, { type: 'question', sessionId: 'sq', payload: { questions: [] } }))
  const again = agentOf(port, { id: 'cccc3333', key: 'k1' })
  const r = await again.register({ sync: sync() })
  assert.deepEqual(ids(r.json.adoptedItems), [a.itemId(1)])
  assert.equal(r.json.adopted, 1)
  assert.equal(hub.store.get(a.itemId(1)).owner, again.id)
  assert.equal(hub.store.get(a.itemId(2)).resolution.reason, 'restarted')
})

test('an item handed over but missing from the next sync (the answer was lost) is handed again, not ended; once the app lists it that stops', async (t) => {
  const { hub, port } = await legacyHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync({ sessionIds: [LIVE_SESSION] }) })
  const retry = await a.post('sync', { sync: sync({ sessionIds: [LIVE_SESSION] }) })
  assert.deepEqual(ids(retry.json.adoptedItems), [LIVE])
  assert.equal(hub.store.get(LIVE).status, 'open', 'not ended as not-in-sync')
  const listed = await a.post('sync', { sync: sync({ sessionIds: [LIVE_SESSION], openItems: [hub.store.get(LIVE)] }) })
  assert.deepEqual(listed.json.adoptedItems, [])
  await a.post('sync', { sync: sync({ sessionIds: [LIVE_SESSION] }) })
  assert.equal(hub.store.get(LIVE).status, 'resolved', 'after that an item the app no longer has ends as before')
  assert.equal(hub.store.get(LIVE).resolution.reason, 'not-in-sync')
})

// ---- the fallback: an item without an owner whose session nobody reports ---------------------------------------------------------

test('an ownerless open item nobody has the session of goes to the coordinator; its no-session answer reaches the card as session-unavailable and the item stays ownerless', async (t) => {
  const { hub, port } = await legacyHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync({ sessionIds: ['unrelated'] }) })
  const pending = postJson(port, P + '/v1/reply', { id: 'nobody1', text: 'hello' })
  const cmds = (await a.poll(0, 3000)).json.commands
  assert.deepEqual(cmds.map((c) => c.kind), ['apply', 'reply'], 'the app is handed the item first, then asked')
  assert.deepEqual([cmds[0].args.change.op, cmds[0].args.change.item.id], ['adopt', 'nobody1'])
  assert.deepEqual([cmds[1].itemId, cmds[1].args.text], ['nobody1', 'hello'])
  await a.result(cmds[1].cid, { ok: false, error: 'no-session' })
  const res = await pending
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'session-unavailable' }])
  assert.equal(hub.store.get('nobody1').owner, undefined)
  assert.equal(hub.store.get('nobody1').status, 'open')
})

test('when the coordinator can reach the session of an ownerless item the action runs there and the app becomes its owner', async (t) => {
  const { hub, port } = await legacyHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  for (const kind of ['archive', 'approve']) {
    const pending = postJson(port, P + '/v1/' + kind, { id: 'nobody1' })
    const cmd = (await a.poll(0, 3000)).json.commands.find((c) => c.kind === kind)
    assert.equal(cmd?.itemId, 'nobody1', kind)
    await a.result(cmd.cid, { ok: true })
    assert.equal((await pending).status, 200, kind)
    assert.equal(hub.store.get('nobody1').owner, a.id, kind)
    hub.store.setOwner('nobody1', undefined)
  }
})

test('an ownerless item with no app online at all still says owner-offline, and a resolved ownerless item is not claimed', async (t) => {
  const { hub, port } = await legacyHub(t)
  const none = await postJson(port, P + '/v1/reply', { id: 'nobody1', text: 'hello' })
  assert.deepEqual([none.status, none.json], [409, { ok: false, error: 'owner-offline' }])
  const a = agentOf(port)
  await a.register({ sync: sync() })
  const resolved = await postJson(port, P + '/v1/reply', { id: 'old1', text: 'hello' })
  assert.deepEqual(resolved.json, { ok: false, error: 'not-open' })
  assert.deepEqual((await a.poll(0, 0)).json.commands, [])
  assert.equal(hub.store.get('old1').owner, undefined)
})
