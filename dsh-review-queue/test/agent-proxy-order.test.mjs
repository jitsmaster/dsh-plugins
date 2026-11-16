// Hub mode must honor this app's own queue-order switch: the proxy re-sorts the hub's oldest-first list and reports queueOrder,
// otherwise the next poll flips "By priority" back to "Oldest first".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeHub, startProxy, hubItem, hubSnap } from './agent-proxy-helpers.mjs'

const tiered = (n, tier, type, over = {}) => hubItem(n, { type, tier: { severity: 'medium', urgency: tier === 1 ? 'blocked' : 'free', tier, at: 1 }, ...over })

async function setup(t) {
  const hub = await startFakeHub(t)
  const recent = Date.now() // recent items: aging (one tier per hour) must not lift the P3 group to P1
  const open = [tiered(1, 3, 'completed', { createdAt: recent - 2 }), tiered(2, 1, 'question', { createdAt: recent - 1 })]
  hub.respond = (rec) => (rec.url.includes('/v1/snapshot') ? [200, hubSnap('E:5', open)] : undefined)
  const api = await startProxy(t, { hub })
  return { hub, api }
}

test('oldest order (default): the hub list passes through in hub order, queueOrder oldest', async (t) => {
  const { api } = await setup(t)
  const s = await api.snap()
  assert.deepEqual(s.open.map((i) => i.position), [1, 2])
  assert.deepEqual(s.open.map((i) => i.id.slice(-1)), ['1', '2'])
  assert.equal(s.queueOrder, 'oldest')
})

test('tier order: the hub list is re-sorted by priority, positions follow, queueOrder tier', async (t) => {
  const { api } = await setup(t)
  assert.deepEqual(api.queue.setQueueOrder('tier'), { ok: true })
  const s = await api.snap()
  assert.deepEqual(s.open.map((i) => i.id.slice(-1)), ['2', '1'])
  assert.deepEqual(s.open.map((i) => i.position), [1, 2])
  assert.equal(s.queueOrder, 'tier')
  assert.ok(s.snapshotId.endsWith('~tier'))
})

test('a poll holding the oldest-order stamp gets a full snapshot after the switch to tier', async (t) => {
  const { api } = await setup(t)
  const before = await api.snap()
  api.queue.setQueueOrder('tier')
  const r = await api.get('/v1/snapshot?wait=0&since=' + encodeURIComponent(before.snapshotId + '|||0'))
  assert.notEqual(r.json.unchanged, true)
  assert.equal(r.json.queueOrder, 'tier')
})
