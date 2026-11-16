// Slice 2: groupOpen ordering by effective tier (behind the order option; default stays oldest-first).
import test from 'node:test'
import assert from 'node:assert/strict'
import { groupOpen } from '../groups.js'

const H = 3600_000
const item = (over) => ({ id: 'i' + Math.random(), type: 'completed', status: 'open', sessionId: 's1', createdAt: 0, seq: 1, ...over })
const ids = (gs) => gs.map((g) => g.id)

test('default order stays oldest-first whatever the tiers', () => {
  const gs = groupOpen([item({ sessionId: 'a', createdAt: 1, tier: { tier: 3 } }), item({ sessionId: 'b', createdAt: 2, tier: { tier: 0 } })])
  assert.deepEqual(ids(gs), ['a', 'b'])
})

test('tier order: lower effective tier first, then oldest item', () => {
  const now = 10
  const gs = groupOpen([
    item({ sessionId: 'a', createdAt: 1, tier: { tier: 3 } }),
    item({ sessionId: 'b', createdAt: 2, tier: { tier: 0 } }),
    item({ sessionId: 'c', createdAt: 3, tier: { tier: 3 } }),
  ], { order: 'tier' })
  assert.deepEqual(ids(gs), ['b', 'a', 'c'])
  assert.deepEqual(gs.map((g) => g.rank), [1, 2, 3])
})

test('a new low item never lifts its group: the group takes its best tier', () => {
  const gs = groupOpen([
    item({ sessionId: 'a', createdAt: 1, tier: { tier: 1 } }),
    item({ sessionId: 'a', createdAt: 5, tier: { tier: 4 } }),
    item({ sessionId: 'b', createdAt: 2, tier: { tier: 2 } }),
  ], { order: 'tier' })
  assert.deepEqual(ids(gs), ['a', 'b'])
})

test('no aging: a group is ordered by its own top tier only, then oldest item', () => {
  const now = 10 * H
  const gs = groupOpen([
    item({ sessionId: 'old', createdAt: 0, tier: { tier: 3 } }),
    item({ sessionId: 'fresh', createdAt: now - 1, tier: { tier: 2 } }),
    item({ sessionId: 'p1', createdAt: now - 1, tier: { tier: 1 } }),
  ], { order: 'tier' })
  assert.deepEqual(ids(gs), ['p1', 'fresh', 'old'])
})

test('P0 is never overtaken by aging; items without a tier rank last', () => {
  const now = 100 * H
  const gs = groupOpen([
    item({ sessionId: 'x', createdAt: 0 }),
    item({ sessionId: 'old', createdAt: 0, tier: { tier: 4 } }),
    item({ sessionId: 'zero', createdAt: now, tier: { tier: 0 } }),
  ], { order: 'tier' })
  assert.equal(gs[0].id, 'zero')
  assert.equal(gs[2].id, 'x')
})

test('inside a tier there is no risk or blocked tie-break: oldest item first', () => {
  const gs = groupOpen([
    item({ sessionId: 'q', type: 'question', createdAt: 1, tier: { tier: 1, severity: 'medium', urgency: 'blocked' } }),
    item({ sessionId: 'r', type: 'completed', createdAt: 2, tier: { tier: 1, severity: 'high', urgency: 'free' } }),
  ], { order: 'tier' })
  assert.deepEqual(ids(gs), ['q', 'r'])
})

test('an unknown order falls back to oldest-first', () => {
  const open = [item({ sessionId: 'a', createdAt: 1, tier: { tier: 3 } }), item({ sessionId: 'b', createdAt: 2, tier: { tier: 0 } })]
  assert.deepEqual(ids(groupOpen(open, { order: 'weird' })), ['a', 'b'])
})
