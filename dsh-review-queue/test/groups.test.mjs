// Slice 1: grouping open items per session (pure). Group = all open items of one session, oldest first; a group is ordered by its oldest open item.
import test from 'node:test'
import assert from 'node:assert/strict'
import { groupOpen, groupIdOf } from '../groups.js'

const it = (id, type, sessionId, createdAt, extra = {}) => ({ id, type, sessionId, createdAt, status: 'open', ...extra })

test('items of one session form one group, oldest first; groups ordered by their oldest item', () => {
  const items = [it('a1', 'completed', 's1', 10), it('b1', 'question', 's2', 20), it('a2', 'permission', 's1', 30), it('b2', 'completed', 's2', 5)]
  const groups = groupOpen(items)
  assert.deepEqual(groups.map((g) => g.id), ['s2', 's1'])
  assert.deepEqual(groups[0].items.map((i) => i.id), ['b2', 'b1'])
  assert.deepEqual(groups[1].items.map((i) => i.id), ['a1', 'a2'])
  assert.equal(groups[0].createdAt, 5)
  assert.deepEqual(groups.map((g) => g.rank), [1, 2])
})

test('inside a group items sort by last update (updatedAt, else createdAt), oldest first', () => {
  const g = groupOpen([it('a', 'question', 's', 10, { updatedAt: 50 }), it('b', 'completed', 's', 20), it('c', 'question', 's', 30)])[0]
  assert.deepEqual(g.items.map((i) => i.id), ['b', 'c', 'a'])
  assert.equal(g.createdAt, 20)
})

test('items without a session, and housekeeping types, stay single cards', () => {
  const items = [it('t1', 'todo', undefined, 1), it('t2', 'todo', undefined, 2), it('o1', 'onhold', 's1', 3), it('o2', 'onhold', 's1', 4), it('p1', 'archive', 's1', 5), it('m1', 'pr-merged', 's1', 6), it('c1', 'completed', 's1', 7)]
  const groups = groupOpen(items)
  assert.equal(groups.length, 7)
  assert.ok(groups.every((g) => g.items.length === 1))
  assert.equal(groupIdOf(items[2]), 'item:o1')
})

test('a started todo with a session still stands alone, a sign-in paused card stands alone', () => {
  const groups = groupOpen([it('t', 'todo', 's1', 1), it('p', 'paused', 's1', 2), it('c', 'completed', 's1', 3), it('q', 'question', 's1', 4)])
  assert.deepEqual(groups.map((g) => g.items.length), [1, 1, 2])
})

test('group tier badges: highest tier first, and the count', () => {
  const g = groupOpen([it('a', 'completed', 's', 1, { tier: { tier: 3 } }), it('b', 'permission', 's', 2, { tier: { tier: 0 } })])[0]
  assert.equal(g.count, 2)
  assert.equal(g.topTier, 0)
})

test('a missing createdAt sorts last and bad input is harmless', () => {
  assert.deepEqual(groupOpen(undefined), [])
  assert.deepEqual(groupOpen([null, 5, {}]).length, 0)
  const groups = groupOpen([it('x', 'completed', 's1', undefined), it('y', 'completed', 's2', 3)])
  assert.deepEqual(groups.map((g) => g.id), ['s2', 's1'])
})

test('resolved items are ignored and the input is not mutated', () => {
  const items = [it('a', 'completed', 's', 1, { status: 'resolved' }), it('b', 'completed', 's', 2)]
  const copy = structuredClone(items)
  assert.equal(groupOpen(items)[0].items.length, 1)
  assert.deepEqual(items, copy)
})
