// A todo is the user's own task: P0 and always first, in both orders.
import test from 'node:test'
import assert from 'node:assert/strict'
import { tierOfItem, buildTier } from '../tier.js'
import { groupOpen } from '../groups.js'

const it = (id, type, sessionId, createdAt, extra = {}) => ({ id, type, sessionId, createdAt, status: 'open', ...extra })

test('a todo is P0', () => {
  assert.equal(tierOfItem({ item: { type: 'todo' } }), 0)
  assert.equal(buildTier({ item: { type: 'todo' } }, 1).tier, 0)
})

test('todo groups come first in oldest order and in tier order', () => {
  const items = [it('a', 'question', 's1', 1, { tier: { tier: 1 } }), it('t', 'todo', undefined, 50, { tier: { tier: 0 } })]
  assert.equal(groupOpen(items)[0].id, 'item:t')
  assert.equal(groupOpen(items, { order: 'tier', now: 100 })[0].id, 'item:t')
})
