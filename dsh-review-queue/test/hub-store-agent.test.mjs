import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHubStore } from '../hub/hub-store.js'

let n = 0
const make = () => createHubStore({ uuid: () => 'u' + ++n })
const add = (store, over = {}, owner = 'A1') => store.applyOp({ op: 'add', item: { type: 'completed', sessionId: 's1', payload: {}, ...over } }, { owner }).id

test('setOwner moves an item to another instance and counts as a change', () => {
  const store = make()
  const id = add(store)
  const rev = store.rev
  assert.equal(store.setOwner(id, 'B2'), true)
  assert.equal(store.get(id).owner, 'B2')
  assert.equal(store.rev, rev + 1)
  assert.equal(store.setOwner('nope', 'B2'), false)
})

test('an update can unset fields, the way store.update(id, { error: undefined }) does locally', () => {
  const store = make()
  const id = add(store, { error: 'boom', state: 'failed' })
  assert.deepEqual(store.applyOp({ op: 'update', id, patch: { state: 'starting' }, unset: ['error'] }, { owner: 'A1' }), { ok: true })
  const item = store.get(id)
  assert.equal(item.state, 'starting')
  assert.equal(JSON.parse(JSON.stringify(item)).error, undefined)
})

test('an unset cannot clear hub-owned fields', () => {
  const store = make()
  const id = add(store)
  store.applyOp({ op: 'update', id, patch: {}, unset: ['owner', 'status', 'id', 'seq', 'createdAt'] }, { owner: 'A1' })
  const item = store.get(id)
  assert.deepEqual([item.owner, item.status, item.id], ['A1', 'open', id])
  assert.equal(typeof item.seq, 'number')
  assert.equal(typeof item.createdAt, 'number')
})

test('an update may replace the resolution of an item that is already resolved (a late answer), never of an open one', () => {
  const store = make()
  const open = add(store)
  store.applyOp({ op: 'update', id: open, patch: { resolution: { kind: 'forged' } } }, { owner: 'A1' })
  assert.equal(store.get(open).resolution, undefined)
  const done = add(store)
  store.applyOp({ op: 'resolve', id: done, resolution: { kind: 'expired' } }, { owner: 'A1' })
  store.applyOp({ op: 'update', id: done, patch: { resolution: { kind: 'late-answered', by: 'card' }, status: 'open' } }, { owner: 'A1' })
  assert.equal(store.get(done).resolution.kind, 'late-answered')
  assert.equal(store.get(done).status, 'resolved')
})

test('resolveSession only closes the items of the owner that sends it', () => {
  const store = make()
  const a = add(store, { sessionId: 's1' }, 'A1')
  const b = add(store, { sessionId: 's1' }, 'B2')
  assert.deepEqual(store.applyOp({ op: 'resolveSession', sessionId: 's1', resolution: { kind: 'session-ended' } }, { owner: 'A1' }), { ok: true, changed: true })
  assert.equal(store.get(a).status, 'resolved')
  assert.equal(store.get(b).status, 'open')
})

test('retitle renames the session on the owner items, open and resolved, and nobody else', () => {
  const store = make()
  const a = add(store, { sessionId: 's1', sessionTitle: 'old' }, 'A1')
  const done = add(store, { sessionId: 's1', sessionTitle: 'old' }, 'A1')
  store.applyOp({ op: 'resolve', id: done, resolution: { kind: 'reviewed' } }, { owner: 'A1' })
  const other = add(store, { sessionId: 's1', sessionTitle: 'old' }, 'B2')
  assert.deepEqual(store.applyOp({ op: 'retitle', sessionId: 's1', title: 'new name' }, { owner: 'A1' }), { ok: true, changed: 2 })
  assert.deepEqual([a, done].map((id) => store.get(id).sessionTitle), ['new name', 'new name'])
  assert.equal(store.get(other).sessionTitle, 'old')
  assert.deepEqual(store.applyOp({ op: 'retitle', sessionId: 's1' }, { owner: 'A1' }), { ok: false, error: 'bad-op' })
})
