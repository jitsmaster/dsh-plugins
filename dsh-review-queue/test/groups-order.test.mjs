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
  ], { order: 'tier', now })
  assert.deepEqual(ids(gs), ['b', 'a', 'c'])
  assert.deepEqual(gs.map((g) => g.rank), [1, 2, 3])
})

test('a new low item never lifts its group: the group takes its best tier', () => {
  const gs = groupOpen([
    item({ sessionId: 'a', createdAt: 1, tier: { tier: 1 } }),
    item({ sessionId: 'a', createdAt: 5, tier: { tier: 4 } }),
    item({ sessionId: 'b', createdAt: 2, tier: { tier: 2 } }),
  ], { order: 'tier', now: 10 })
  assert.deepEqual(ids(gs), ['a', 'b'])
})

test('aging: an old P3 group overtakes a fresh P2, never above P1', () => {
  const now = 10 * H
  const gs = groupOpen([
    item({ sessionId: 'old', createdAt: 0, tier: { tier: 3 } }),
    item({ sessionId: 'fresh', createdAt: now - 1, tier: { tier: 2 } }),
    item({ sessionId: 'p1', createdAt: now - 1, tier: { tier: 1 } }),
  ], { order: 'tier', now })
  // old P3 aged 10h -> capped at P1; ties with p1 broken by oldest item, so old comes first, then p1, then fresh P2
  assert.deepEqual(ids(gs), ['old', 'p1', 'fresh'])
})

test('P0 is never overtaken by aging; items without a tier rank last', () => {
  const now = 100 * H
  const gs = groupOpen([
    item({ sessionId: 'x', createdAt: 0 }),
    item({ sessionId: 'old', createdAt: 0, tier: { tier: 4 } }),
    item({ sessionId: 'zero', createdAt: now, tier: { tier: 0 } }),
  ], { order: 'tier', now })
  assert.equal(gs[0].id, 'zero')
  assert.equal(gs[2].id, 'x')
})

test('inside a tier a risk-flagged free group ranks above an older blocked question', () => {
  const gs = groupOpen([
    item({ sessionId: 'q', type: 'question', createdAt: 1, tier: { tier: 1, severity: 'medium', urgency: 'blocked' } }),
    item({ sessionId: 'r', type: 'completed', createdAt: 2, tier: { tier: 1, severity: 'high', urgency: 'free' } }),
  ], { order: 'tier', now: 10 })
  assert.deepEqual(ids(gs), ['r', 'q'])
  // a different tier is still decided by the tier first
  const gs2 = groupOpen([
    item({ sessionId: 'r', createdAt: 1, tier: { tier: 1, severity: 'high', urgency: 'free' } }),
    item({ sessionId: 'p0', createdAt: 2, tier: { tier: 0, severity: 'high', urgency: 'blocked' } }),
  ], { order: 'tier', now: 10 })
  assert.deepEqual(ids(gs2), ['p0', 'r'])
})

test('a bad order or now falls back to oldest-first', () => {
  const open = [item({ sessionId: 'a', createdAt: 1, tier: { tier: 3 } }), item({ sessionId: 'b', createdAt: 2, tier: { tier: 0 } })]
  assert.deepEqual(ids(groupOpen(open, { order: 'weird', now: 5 })), ['a', 'b'])
  assert.deepEqual(ids(groupOpen(open, { order: 'tier', now: NaN })), ['a', 'b'])
})
