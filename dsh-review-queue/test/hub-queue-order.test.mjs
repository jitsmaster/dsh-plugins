// Slice 2: in hub mode the snapshot follows the local queue-order switch (the mirror view used to stay oldest-first).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHubQueue } from '../agent/hub-queue.js'

const BASE = Date.now() // recent items: aging must not lift both tiers to the cap
const TIERS = { completed: { severity: 'low', urgency: 'free', tier: 3, at: 0 }, question: { severity: 'medium', urgency: 'blocked', tier: 1, at: 0 } } // the hub snapshot carries each item's stored tier
const item = (id, type, n) => ({ id, type, status: 'open', sessionId: 's' + id, createdAt: BASE + n, seq: n, tier: TIERS[type], payload: type === 'question' ? { questions: [] } : { reply: 'x' } })

function make(order) {
  let current = order
  const local = {
    snapshot: () => ({ snapshotId: 'L', open: [], resolved: [] }),
    onChange: () => () => {}, stop: () => ({ ok: true }), uiState: () => ({ seq: 0 }),
    queueOrder: () => current,
  }
  const hubSnap = { snapshotId: 'e:1', open: [item('a', 'completed', 1), item('b', 'question', 2)], resolved: [] }
  const client = {
    state: 'connected',
    mirror: { ready: true, snapshot: () => hubSnap, workspaces: () => [], onChange: () => () => {} },
    onState: () => () => {}, call: async () => ({ ok: true }),
  }
  const queue = createHubQueue({ local, client, speaker: { speak: () => ({ ok: true }), stop() {} }, controllerOf: () => ({}) })
  return { queue, set: (v) => { current = v } }
}

test('hub mode: oldest by default, tier order after the local switch, positions follow', () => {
  const { queue, set } = make('oldest')
  assert.deepEqual(queue.snapshot().open.map((i) => i.id), ['a', 'b'])
  assert.equal(queue.snapshot().queueOrder, 'oldest')
  set('tier')
  const snap = queue.snapshot()
  assert.deepEqual(snap.open.map((i) => i.id), ['b', 'a'])
  assert.deepEqual(snap.open.map((i) => i.position), [1, 2])
  assert.equal(snap.queueOrder, 'tier')
  set('oldest')
  assert.deepEqual(queue.snapshot().open.map((i) => i.id), ['a', 'b'])
})
