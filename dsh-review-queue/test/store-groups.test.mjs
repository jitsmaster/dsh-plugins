// Slice 1: snapshot().open stays a flat item list in the old (oldest-first) order and positions, plus groupId and groupRank per item.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'

function make() {
  let t = 1_000
  let n = 0
  return createStore({ now: () => (t += 10), uuid: () => 'id' + ++n })
}

test('open stays flat and oldest-first with unchanged positions, and carries groupId and groupRank', () => {
  const store = make()
  const a1 = store.add({ type: 'completed', sessionId: 's1', payload: { reply: 'x' } })
  const b1 = store.add({ type: 'question', sessionId: 's2', payload: { questions: [] } })
  const a2 = store.add({ type: 'completed', sessionId: 's1', payload: { reply: 'y' } })
  const open = store.snapshot().open
  assert.deepEqual(open.map((i) => i.id), [a1.id, b1.id, a2.id])
  assert.deepEqual(open.map((i) => i.position), [1, 2, 3])
  assert.deepEqual(open.map((i) => i.groupId), ['s1', 's2', 's1'])
  assert.deepEqual(open.map((i) => i.groupRank), [1, 2, 1])
})

test('snapshot({ order: "tier" }) flattens open by group tier order, positions follow; default stays oldest-first', () => {
  const store = make()
  const a = store.add({ type: 'completed', sessionId: 's1', payload: { reply: 'x' } })
  const b = store.add({ type: 'question', sessionId: 's2', payload: { questions: [] } })
  const a2 = store.add({ type: 'completed', sessionId: 's1', payload: { reply: 'y' } })
  assert.deepEqual(store.snapshot().open.map((i) => i.id), [a.id, b.id, a2.id])
  const open = store.snapshot({ order: 'tier' }).open
  assert.deepEqual(open.map((i) => i.id), [b.id, a.id, a2.id], 'the blocked question group (P1) goes before the done group')
  assert.deepEqual(open.map((i) => i.position), [1, 2, 3])
  assert.deepEqual(store.snapshot({ order: 'bogus' }).open.map((i) => i.id), [a.id, b.id, a2.id])
})

test('a card with no session is its own group', () => {
  const store = make()
  const t = store.add({ type: 'todo', payload: {} })
  const i = store.snapshot().open[0]
  assert.equal(i.groupId, 'item:' + t.id)
  assert.equal(i.groupRank, 1)
})

test("rank and flat order agree with the grouped order for a merged item", () => {
  const store = make()
  const a = store.add({ type: "question", sessionId: "s1", payload: { questions: [] } })
  const b = store.add({ type: "question", sessionId: "s2", payload: { questions: [] } })
  store.update(a.id, { merged: { count: 2 }, updatedAt: 99_999 }) // merged: last update puts s1 behind s2
  const open = store.snapshot().open
  assert.deepEqual(open.map((i) => i.id), [b.id, a.id])
  assert.deepEqual(open.map((i) => i.groupRank), [1, 2])
  assert.deepEqual(open.map((i) => i.position), [1, 2])
})
