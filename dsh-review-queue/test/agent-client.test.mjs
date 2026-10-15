import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentClient } from '../agent/client.js'
import { createExecutor } from '../agent/executor.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { raw, waitFor } from './hub-helpers.mjs'
import { P, SECRET, agentOf, startHub } from './hub-agent-helpers.mjs'

const item = (over = {}) => ({ type: 'completed', sessionId: 's1', payload: { reply: 'r' }, ...over })
const FAST = { backoff: { minMs: 10, maxMs: 40 }, waitMs: 400 }

/** A real client over a real adapter and executor; the "queue" is a fake service that records what the executor called. */
function setup(t, port, { id = 'aaaa1111', key = 'k1', label = 'DSH :1', fetch, workspaces = () => [], ...over } = {}) {
  const adapter = createStoreAdapter({ instanceId: id })
  const calls = []
  const queue = {
    approve: (itemId, opts) => { calls.push(['approve', itemId, opts]); adapter.resolve(itemId, { kind: 'approved', by: 'card' }); return { ok: true } },
    reply: async (itemId, text) => { calls.push(['reply', itemId, text]); return { ok: true } },
  }
  const executor = createExecutor({ queue, adapter })
  const client = createAgentClient({ baseUrl: 'http://127.0.0.1:' + port, secret: SECRET, instanceKey: key, instanceId: id, label, adapter, executor, workspaces, ...(fetch ? { fetch } : {}), ...FAST, ...over })
  t.after(() => client.stop({ bye: false }))
  return { client, adapter, calls }
}
const connected = (client) => waitFor(() => client.state === 'connected', 8000, 'connected')
/** fetch that records the requests and can be told to fail them. */
function spyFetch() {
  const log = []
  const spy = {
    log, failing: new Set(), after: new Map(),
    fetch: async (url, init) => {
      const u = new URL(url)
      const name = u.pathname.split('/').pop()
      log.push(name)
      if (spy.failing.has(name)) throw new TypeError('fetch failed')
      if (name === 'commands' && spy.rewind) { u.searchParams.set('after', '0'); url = u.toString() }
      const res = await fetch(url, init)
      if (spy.loseResponse?.name === name && spy.loseResponse.times-- > 0) throw new TypeError('response lost')
      return res
    },
  }
  return spy
}

test('start registers with the local items as a sync and connects; the workspaces ride along', async (t) => {
  const { hub, port } = await startHub(t)
  const { client, adapter } = setup(t, port, { workspaces: () => [{ id: 'w1', title: 'alpha', path: 'D:/a', sessionIds: ['s1'] }] })
  const local = adapter.add(item())
  client.start()
  await connected(client)
  assert.equal(hub.store.get(local.id).owner, 'aaaa1111')
  assert.deepEqual(hub.instances.get('aaaa1111').workspaces.map((x) => x.id), ['w1'])
  assert.equal(adapter.outbox().length, 0, 'the sync carried the op')
  assert.equal(hub.instances.get('aaaa1111').lastOp, adapter.n)
})

test('what the service changes afterwards reaches the hub as ops, in order, and is acknowledged', async (t) => {
  const { hub, port } = await startHub(t)
  const { client, adapter } = setup(t, port)
  client.start()
  await connected(client)
  const a = adapter.add(item({ type: 'question', payload: { questions: [] } }))
  adapter.update(a.id, { summary: 'later summary' })
  adapter.resolve(a.id, { kind: 'answered', by: 'screen' })
  await waitFor(() => adapter.outbox().length === 0, 5000, 'outbox drained')
  const got = hub.store.get(a.id)
  assert.deepEqual([got.owner, got.summary, got.status, got.resolution.kind], ['aaaa1111', 'later summary', 'resolved', 'answered'])
})

test('a burst is sent in batches without losing or reordering anything', async (t) => {
  const { hub, port } = await startHub(t)
  const { client, adapter } = setup(t, port)
  client.start()
  await connected(client)
  const ids = Array.from({ length: 250 }, (_, i) => adapter.add(item({ sessionId: 's' + i })).id)
  await waitFor(() => adapter.outbox().length === 0, 8000, 'outbox drained')
  assert.deepEqual(hub.store.list().map((i) => i.id), ids)
})

test('a command runs in this app and its result is the answer of the hub, with the ops it caused already there', async (t) => {
  const { hub, port } = await startHub(t)
  const { client, adapter, calls } = setup(t, port)
  const permission = adapter.add(item({ type: 'permission', payload: { toolName: 'shell', summary: 'ls', detail: 'ls' } }))
  client.start()
  await connected(client)
  const res = await raw({ port, method: 'POST', path: P + '/v1/approve', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: permission.id }) })
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  assert.deepEqual(calls, [['approve', permission.id, { via: 'desktop', confirmed: false, held: false }]])
  assert.equal(hub.store.get(permission.id).status, 'resolved', 'the resolve op was flushed before the result')
})

test('a command delivered twice (a lost poll response) runs once', async (t) => {
  const { port } = await startHub(t)
  const spy = spyFetch()
  const { client, adapter, calls } = setup(t, port, { fetch: spy.fetch })
  const permission = adapter.add(item({ type: 'permission', payload: { toolName: 'shell', summary: 'ls', detail: 'ls' } }))
  client.start()
  await connected(client)
  spy.rewind = true // every poll asks again from the start, as an agent whose acknowledgements get lost would: the hub keeps redelivering
  const res = await raw({ port, method: 'POST', path: P + '/v1/approve', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: permission.id }) })
  assert.equal(res.status, 200)
  assert.equal(calls.filter((c) => c[0] === 'approve').length, 1)
})

test('a result whose response got lost is not run again: the hub still has one answer', async (t) => {
  const { port } = await startHub(t)
  const spy = spyFetch()
  spy.loseResponse = { name: 'result', times: 1 }
  const { client, adapter, calls } = setup(t, port, { fetch: spy.fetch })
  const permission = adapter.add(item({ type: 'permission', payload: { toolName: 'shell', summary: 'ls', detail: 'ls' } }))
  client.start()
  await connected(client)
  const res = await raw({ port, method: 'POST', path: P + '/v1/approve', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: permission.id }) })
  assert.equal(res.status, 200)
  assert.equal(calls.length, 1)
})

test('a gap in the op numbers makes the client send a full sync, and the counter goes on from it', async (t) => {
  const { hub, port } = await startHub(t)
  const { client, adapter } = setup(t, port)
  client.start()
  await connected(client)
  adapter.add(item()); adapter.add(item({ sessionId: 's2' }))
  await waitFor(() => adapter.outbox().length === 0, 5000, 'drained')
  hub.instances.get('aaaa1111').lastOp = 0 // the hub forgot what it had applied
  adapter.add(item({ sessionId: 's3' }))
  await waitFor(() => hub.store.list().length === 3 && adapter.outbox().length === 0, 5000, 'resynced')
  assert.equal(hub.instances.get('aaaa1111').lastOp, adapter.n)
  adapter.add(item({ sessionId: 's4' }))
  await waitFor(() => hub.store.list().length === 4, 5000, 'op after resync')
})

test('an instance the hub no longer knows registers again, and its questions come back to life', async (t) => {
  const { hub, port } = await startHub(t)
  const { client, adapter } = setup(t, port)
  const q = adapter.add(item({ type: 'question', payload: { questions: [] } }))
  client.start()
  await connected(client)
  hub.instances.bye('aaaa1111') // as if it had slept past the grace
  assert.equal(hub.store.get(q.id).status, 'resolved')
  await waitFor(() => hub.store.get(q.id).status === 'open' && hub.instances.get('aaaa1111').state === 'online', 8000, 'revived')
  assert.equal(hub.store.get(q.id).resolution, undefined)
})

test('the hub gone and back: the client degrades, keeps its ops, and syncs when the hub returns', async (t) => {
  const first = await startHub(t)
  const { client, adapter } = setup(t, first.port)
  client.start()
  await connected(client)
  await first.hub.stop()
  await waitFor(() => client.state === 'degraded', 8000, 'degraded')
  const a = adapter.add(item({ sessionId: 'offline-1' }))
  const b = adapter.add(item({ sessionId: 'offline-2' }))
  assert.equal(adapter.outbox().length >= 2, true)
  const second = await startHub(t, { dir: first.dir, port: first.port })
  await connected(client)
  await waitFor(() => adapter.outbox().length === 0, 8000, 'outbox drained')
  assert.deepEqual([a.id, b.id].map((id) => second.hub.store.get(id)?.owner), ['aaaa1111', 'aaaa1111'])
})

test('an older client than the hub is told to upgrade and stops talking', async (t) => {
  const { port } = await startHub(t, { protocol: 3 })
  const spy = spyFetch()
  const { client } = setup(t, port, { fetch: spy.fetch })
  client.start()
  await waitFor(() => client.state === 'upgrade-required', 5000, 'upgrade-required')
  const seen = spy.log.length
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(spy.log.length, seen)
})

test('an instance that a restart replaced stops for good instead of fighting its successor', async (t) => {
  const { port } = await startHub(t)
  await agentOf(port, { id: 'aaaa1111' }).register()
  await agentOf(port, { id: 'cccc3333' }).register()
  const { client } = setup(t, port)
  client.start()
  await waitFor(() => client.state === 'superseded', 5000, 'superseded')
})

test('stop says bye (the questions end at once, the rest stays) unless told not to, and nothing is sent after it', async (t) => {
  const { hub, port } = await startHub(t)
  const spy = spyFetch()
  const { client, adapter } = setup(t, port, { fetch: spy.fetch })
  const q = adapter.add(item({ type: 'question', payload: { questions: [] } }))
  const c = adapter.add(item({ sessionId: 's2' }))
  client.start()
  await connected(client)
  await client.stop()
  assert.equal(client.state, 'stopped')
  assert.deepEqual([hub.store.get(q.id).status, hub.store.get(c.id).status, hub.instances.get('aaaa1111').state], ['resolved', 'open', 'gone'])
  const seen = spy.log.length
  adapter.add(item({ sessionId: 's3' }))
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(spy.log.length, seen)
})

test('presence reaches the hub; the call of an action answers { ok:false } instead of throwing when the hub is down', async (t) => {
  const { hub, port } = await startHub(t)
  const { client, adapter } = setup(t, port)
  const c = adapter.add(item())
  client.start()
  await connected(client)
  await client.presence({ desktopActive: true })
  assert.equal(typeof hub.instances.get('aaaa1111').lastDesktopActiveAt, 'number')
  assert.deepEqual(await client.call('reviewed', { id: c.id }), { ok: true })
  assert.equal(hub.store.get(c.id).status, 'resolved')
  await hub.stop()
  assert.deepEqual(await client.call('reviewed', { id: c.id }), { ok: false, error: 'hub-unreachable' })
  await client.presence({ desktopActive: true })
})

test('the mirror follows the hub snapshot and the workspace union, and is not ready without the hub', async (t) => {
  const { hub, port } = await startHub(t)
  const { client } = setup(t, port, { workspaces: () => [{ id: 'w1', title: 'alpha', path: 'D:/a' }] })
  const other = agentOf(port, { id: 'bbbb2222', key: 'k2' })
  await other.register()
  let heard = 0
  client.mirror.onChange(() => heard++)
  client.start()
  await waitFor(() => client.mirror.ready, 8000, 'mirror ready')
  await other.send(other.add(1))
  await waitFor(() => client.mirror.snapshot()?.open.some((i) => i.id === other.itemId(1)), 8000, 'mirror update')
  assert.ok(heard >= 1)
  assert.deepEqual(client.mirror.workspaces(), [{ id: 'aaaa/w1', title: 'alpha' }])
  await hub.stop()
  await waitFor(() => !client.mirror.ready, 8000, 'mirror not ready')
})

test('what the owner learned while it was away is applied on return: an item reviewed on the phone is resolved locally too', async (t) => {
  const { hub, port } = await startHub(t)
  const one = setup(t, port)
  const c = one.adapter.add(item())
  one.client.start()
  await connected(one.client)
  await one.client.stop({ bye: false })
  assert.deepEqual(await hub.act('reviewed', { id: c.id }), { ok: true })
  const again = createAgentClient({ baseUrl: 'http://127.0.0.1:' + port, secret: SECRET, instanceKey: 'k1', instanceId: 'aaaa1111', label: 'DSH :1', adapter: one.adapter, executor: createExecutor({ queue: {}, adapter: one.adapter }), ...FAST })
  t.after(() => again.stop({ bye: false }))
  again.start()
  await connected(again)
  assert.equal(one.adapter.get(c.id).status, 'resolved')
})

test('a change the hub makes while connected (reviewed on the phone) is applied locally without an op', async (t) => {
  const { hub, port } = await startHub(t)
  const { client, adapter } = setup(t, port)
  const c = adapter.add(item())
  client.start()
  await connected(client)
  const before = adapter.n
  assert.deepEqual(await hub.act('reviewed', { id: c.id }), { ok: true })
  await waitFor(() => adapter.get(c.id).status === 'resolved', 5000, 'applied')
  assert.equal(adapter.n, before)
})
