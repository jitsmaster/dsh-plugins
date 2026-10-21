import { test } from 'node:test'
import assert from 'node:assert/strict'
import { act, autopilot, followItem, twoApps } from './hub-follow-up-helpers.mjs'

// An app can only change the items it owns. For a follow-up that matters most for what the user is shown and what a confirm trusts: candidates, suggested (and the owner tag
// inside them, which decides which app is handed the message), state, text. The hub store refuses every agent op of a non-owner (hub/hub-store.js ownedBy), the agent API always
// passes the registered instance as owner, and owner is a hub field no patch may set. This pins that down for follow-up items.

const cands = (a, b) => [{ sessionId: 'sa1', title: 'A', owner: a.id }, { sessionId: 'sb1', title: 'B', owner: b.id }]
async function held(t) {
  const ctx = await twoApps(t)
  const { a, b } = ctx
  await a.send(followItem(a, 1, { candidates: cands(a, b), suggested: { sessionId: 'sa1', title: 'A', reason: 'r', owner: a.id } }))
  await a.send(followItem(a, 2, { state: 'started', sessionId: 'sa9', sessionTitle: 'Nine', candidates: [] }))
  return { ...ctx, id: a.itemId(1), started: a.itemId(2) }
}
const errors = (res) => res.json.results.map((r) => r.error)

test('an app cannot rewrite the candidates, suggestion, owner, state or text of a follow-up it does not own, nor resolve, reopen or retitle it', async (t) => {
  const { hub, a, b, id, started } = await held(t)
  const before = JSON.stringify([hub.store.get(id), hub.store.get(started)])
  const res = await b.send(
    { op: 'update', id, patch: { candidates: [{ sessionId: 'evil', title: 'Evil', owner: b.id }], suggested: { sessionId: 'evil', title: 'Evil', owner: b.id }, owner: b.id, state: 'failed', text: 'rm -rf', error: 'x' } },
    { op: 'update', id, patch: {}, unset: ['candidates', 'suggested'] },
    { op: 'resolve', id, resolution: { kind: 'cancelled', by: 'card' } },
    { op: 'reopen', id },
    { op: 'retitle', sessionId: 'sa9', title: 'Renamed by b' },
    { op: 'resolveSession', sessionId: 'sa9', resolution: { kind: 'session-ended' } },
  )
  assert.deepEqual(errors(res), ['not-owner', 'not-owner', 'not-owner', 'not-owner', undefined, undefined], 'retitle and resolveSession are scoped to the items of the sender: they changed none here')
  assert.equal(JSON.stringify([hub.store.get(id), hub.store.get(started)]), before, 'both items are exactly as they were')
  assert.equal(hub.store.get(id).owner, a.id)
})

test('an app cannot take over a follow-up by adding the same id (the prefix of that id is another app\'s)', async (t) => {
  const { hub, a, b, id } = await held(t)
  const before = JSON.stringify(hub.store.get(id))
  const res = await b.send({ op: 'add', item: { id, type: 'todo', kind: 'followup', text: 'mine now', state: 'awaiting-confirm', candidates: [{ sessionId: 'evil', title: 'E', owner: b.id }] } })
  assert.deepEqual(errors(res), ['bad-id'], 'refused already by the id rule: an add must carry an id of the form <this app\'s short id>-<12 hex> (the hub store would say id-conflict)')
  assert.equal(JSON.stringify(hub.store.get(id)), before)
  assert.equal(hub.store.list().filter((i) => i.owner === b.id).length, 0, 'b owns nothing')
})

test('the owner may patch its follow-up but never its owner field; after a move the old owner has lost the item and the new one has it', async (t) => {
  const { hub, port, a, b, id } = await held(t)
  const mine = await a.send({ op: 'update', id, patch: { owner: b.id, suggestNote: 'a note' } })
  assert.deepEqual(errors(mine), [undefined])
  assert.deepEqual([hub.store.get(id).owner, hub.store.get(id).suggestNote], [a.id, 'a note'], 'owner is a hub field: ignored in a patch')
  autopilot(t, b, () => ({ ok: true, state: 'starting' }))
  assert.equal((await act(port, 'todo-confirm', { id, sessionId: 'sb1' })).status, 200)
  assert.equal(hub.store.get(id).owner, b.id)
  const stale = await a.send({ op: 'update', id, patch: { candidates: [] } })
  assert.deepEqual(errors(stale), ['not-owner'], 'the old owner can no longer change it')
  assert.equal(hub.store.get(id).candidates.length, 2)
  const fresh = await b.send({ op: 'update', id, patch: { state: 'started' } })
  assert.deepEqual(errors(fresh), [undefined])
})
