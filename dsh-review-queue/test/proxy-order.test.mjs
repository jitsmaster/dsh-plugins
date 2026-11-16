// agent/proxy-order.js: the stamp and ordering helpers of the hub proxy's own By priority switch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TIER_MARK, stampTier, unstampTier, flattenGroups, atPosition, tierSorted } from '../agent/proxy-order.js'

const item = (id, tier, over = {}) => ({ id, type: 'completed', status: 'open', sessionId: 's' + id, createdAt: Number(id), seq: Number(id), tier: { tier }, ...over })

test('stampTier marks the hub id only when tiered; unstampTier reverses it', () => {
  assert.equal(TIER_MARK, '~tier')
  assert.equal(stampTier('E:5', false), 'E:5')
  assert.equal(stampTier('E:5', true), 'E:5~tier')
  assert.deepEqual(unstampTier('E:5~tier'), { id: 'E:5', tiered: true })
  assert.deepEqual(unstampTier('E:5'), { id: 'E:5', tiered: false })
  assert.deepEqual(unstampTier(unstampTier(stampTier('x', true)).id), { id: 'x', tiered: false })
})

test('flattenGroups lists group members in group order with the group id and rank', () => {
  const groups = [{ id: 'g1', rank: 1, items: [{ id: 'a' }, { id: 'b' }] }, { id: 'g2', rank: 2, items: [{ id: 'c' }] }]
  assert.deepEqual(flattenGroups(groups), [
    { id: 'a', groupId: 'g1', groupRank: 1 }, { id: 'b', groupId: 'g1', groupRank: 1 }, { id: 'c', groupId: 'g2', groupRank: 2 },
  ])
})

test('atPosition sets the 1-based position and rebuilds a spoken line only when there was one', () => {
  const plain = atPosition({ id: 'a' }, 0)
  assert.equal(plain.position, 1)
  assert.ok(!plain.spoken)
  const spoken = atPosition({ id: 'a', type: 'completed', spoken: 'old' }, 2)
  assert.equal(spoken.position, 3)
  assert.equal(spoken.spoken.lead, 'Item 3.')
})

test('tierSorted orders by best tier then age, numbers positions from 1 and does not mutate the input', () => {
  const list = [item('1', 3), item('2', 1), item('3', 2)]
  const copy = JSON.parse(JSON.stringify(list))
  const out = tierSorted(list)
  assert.deepEqual(out.map((i) => i.id), ['2', '3', '1'])
  assert.deepEqual(out.map((i) => i.position), [1, 2, 3])
  assert.deepEqual(list, copy)
  assert.deepEqual(tierSorted([]), [])
})