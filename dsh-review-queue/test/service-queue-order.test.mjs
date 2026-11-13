// Slice 2: the queueOrder switch ('oldest' default | 'tier'), persisted, failing closed to 'oldest'.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReviewQueue } from '../service.js'
import { createStore } from '../store.js'

function make(extra = {}) {
  let t = 1_000
  let n = 0
  const store = createStore({ now: () => (t += 10), uuid: () => 'id' + ++n })
  const q = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), now: () => t, ...extra })
  const a = store.add({ type: 'completed', sessionId: 's1', payload: { reply: 'x' } })
  const b = store.add({ type: 'question', sessionId: 's2', payload: { questions: [] } })
  return { q, a, b }
}

test('default is oldest-first and the switch reorders the snapshot and its positions', () => {
  const { q, a, b } = make()
  assert.equal(q.queueOrder(), 'oldest')
  assert.deepEqual(q.snapshot().open.map((i) => i.id), [a.id, b.id])
  assert.deepEqual(q.setQueueOrder('tier'), { ok: true })
  assert.equal(q.queueOrder(), 'tier')
  const open = q.snapshot().open
  assert.deepEqual(open.map((i) => i.id), [b.id, a.id])
  assert.deepEqual(open.map((i) => i.position), [1, 2])
  assert.equal(q.snapshot().queueOrder, 'tier')
})

test('a bad value is refused and the order is unchanged', () => {
  const { q } = make()
  assert.deepEqual(q.setQueueOrder('weird'), { ok: false, error: 'bad-input' })
  assert.deepEqual(q.setQueueOrder(undefined), { ok: false, error: 'bad-input' })
  assert.equal(q.queueOrder(), 'oldest')
})

test('the choice is persisted and read back; a corrupt or throwing store fails closed to oldest', () => {
  let saved
  const io = { read: () => saved, write: (s) => { saved = s } }
  make({ queueOrderIo: io }).q.setQueueOrder('tier')
  assert.equal(make({ queueOrderIo: io }).q.queueOrder(), 'tier')
  assert.equal(make({ queueOrderIo: { read: () => 'not json', write() {} } }).q.queueOrder(), 'oldest')
  assert.equal(make({ queueOrderIo: { read: () => { throw new Error('x') }, write() {} } }).q.queueOrder(), 'oldest')
  assert.deepEqual(make({ queueOrderIo: { read: () => undefined, write: () => { throw new Error('disk') } } }).q.setQueueOrder('tier'), { ok: true })
})

test('the snapshotId changes with the order, so a long poll holding the old stamp gets the re-ordered list', () => {
  const { q } = make()
  const before = q.snapshot().snapshotId
  assert.equal(/~/.test(before), false) // default id is unchanged
  q.setQueueOrder('tier')
  const after = q.snapshot().snapshotId
  assert.notEqual(after, before)
  q.setQueueOrder('oldest')
  assert.equal(q.snapshot().snapshotId, before)
})

test('voice paths follow the displayed order in tier mode: first and openTarget are the top card', () => {
  const { q, b } = make()
  q.setQueueOrder('tier')
  assert.equal(q.first().id, b.id)
  assert.equal(q.openTarget().sessionId, 's2')
})
