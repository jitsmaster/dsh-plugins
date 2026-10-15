// The agent side of adoption by session id: it reports every session it can reach (not only those of its own items), reports again when they
// change and now and then, takes the items the hub hands it into its local store, and runs the hub's adopt message.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentClient } from '../agent/client.js'
import { createExecutor } from '../agent/executor.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { waitFor } from './hub-helpers.mjs'
import { SECRET, startHub } from './hub-agent-helpers.mjs'

const FAST = { backoff: { minMs: 10, maxMs: 40 }, waitMs: 400 }
const orphan = (hub, sessionId = 'sX') => hub.store.applyOp({ op: 'add', item: { type: 'completed', sessionId, payload: { reply: 'r' } } }, {}).id

function setup(t, port, over = {}) {
  const adapter = createStoreAdapter({ instanceId: 'aaaa1111' })
  const calls = []
  const queue = { reply: async (itemId, text) => { calls.push(['reply', itemId, text]); return { ok: true } } }
  const executor = createExecutor({ queue, adapter })
  const client = createAgentClient({ baseUrl: 'http://127.0.0.1:' + port, secret: SECRET, instanceKey: 'k1', instanceId: 'aaaa1111', label: 'DSH :1', adapter, executor, ...FAST, ...over })
  t.after(() => client.stop({ bye: false }))
  return { client, adapter, calls }
}
const connected = (client) => waitFor(() => client.state === 'connected', 8000, 'connected')
/** fetch that counts the requests by their last path part. */
const countingFetch = () => { const counts = {}; return { counts, fetch: async (url, init) => { const name = new URL(url).pathname.split('/').pop(); counts[name] = (counts[name] ?? 0) + 1; return fetch(url, init) } } }

test('the app reports every session it can reach at register, not only those of its own open items; the hub adopts the orphan and the app has it locally', async (t) => {
  const { hub, port } = await startHub(t)
  const id = orphan(hub)
  const { client, adapter } = setup(t, port, { sessionIds: () => ['sX', 'sY'] })
  client.start()
  await connected(client)
  assert.deepEqual(hub.instances.get('aaaa1111').sessionIds.sort(), ['sX', 'sY'])
  assert.equal(hub.store.get(id).owner, 'aaaa1111')
  assert.equal(adapter.get(id)?.status, 'open', 'the answer handed the item over')
  assert.equal(adapter.outbox().length, 0, 'adopting is not a change of the app: no op')
})

test('a session that appears later is reported within the check interval and adopted without a restart', async (t) => {
  const { hub, port } = await startHub(t)
  const id = orphan(hub)
  let reachable = []
  const { client, adapter } = setup(t, port, { sessionIds: () => reachable, sessionCheckMs: 20 })
  client.start()
  await connected(client)
  assert.equal(hub.store.get(id).owner, undefined)
  reachable = ['sX']
  await waitFor(() => hub.store.get(id).owner === 'aaaa1111', 3000, 'adopted after the change')
  await waitFor(() => adapter.get(id), 3000, 'item handed to the app')
})

test('an unchanged session list is not sent again before the slow heartbeat; the heartbeat sends it anyway', async (t) => {
  const { port } = await startHub(t)
  const quiet = countingFetch()
  const a = setup(t, port, { sessionIds: () => ['sX'], sessionCheckMs: 15, resyncEveryMs: 10_000, fetch: quiet.fetch })
  a.client.start()
  await connected(a.client)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(quiet.counts.sync ?? 0, 0)
  const beat = countingFetch()
  const adapter = createStoreAdapter({ instanceId: 'bbbb2222' })
  const b = createAgentClient({ baseUrl: 'http://127.0.0.1:' + port, secret: SECRET, instanceKey: 'k2', instanceId: 'bbbb2222', label: 'DSH :2', adapter, executor: createExecutor({ queue: {}, adapter }), sessionIds: () => ['sX'], sessionCheckMs: 15, resyncEveryMs: 60, fetch: beat.fetch, ...FAST })
  t.after(() => b.stop({ bye: false }))
  b.start()
  await connected(b)
  await waitFor(() => (beat.counts.sync ?? 0) >= 2, 3000, 'heartbeat syncs')
})

test('a reply to an adopted item reaches the app service with the item id', async (t) => {
  const { hub, port } = await startHub(t)
  const id = orphan(hub)
  const { client, calls } = setup(t, port, { sessionIds: () => ['sX'] })
  client.start()
  await connected(client)
  assert.equal(hub.store.get(id).owner, 'aaaa1111', 'adopted by its session, not claimed by the fallback')
  assert.deepEqual(await hub.act('reply', { id, text: 'restarted' }), { ok: true })
  assert.deepEqual(calls, [['reply', id, 'restarted']])
})

test('the hub adopt message puts an item into the local store without an op, and does nothing to one that is already there', async () => {
  const adapter = createStoreAdapter({ instanceId: 'aaaa1111' })
  const executor = createExecutor({ queue: {}, adapter })
  const item = { id: 'zzzz-000000000001', type: 'completed', sessionId: 's9', status: 'open', owner: 'old', seq: 4, createdAt: 77, payload: { reply: 'r' } }
  assert.deepEqual(await executor.execute({ cid: 'c1', seq: 1, kind: 'apply', args: { change: { op: 'adopt', item } } }), { ok: true })
  const got = adapter.get(item.id)
  assert.deepEqual([got.status, got.owner, got.sessionId, got.createdAt], ['open', undefined, 's9', 77])
  assert.equal(adapter.outbox().length, 0)
  adapter.resolve(item.id, { kind: 'reviewed' })
  await executor.execute({ cid: 'c2', seq: 2, kind: 'apply', args: { change: { op: 'adopt', item } } })
  assert.equal(adapter.get(item.id).status, 'resolved', 'an existing copy wins')
  assert.deepEqual((await executor.execute({ cid: 'c3', seq: 3, kind: 'apply', args: { change: { op: 'adopt', item: {} } } })).ok, false, 'a change without an item id is refused')
})
