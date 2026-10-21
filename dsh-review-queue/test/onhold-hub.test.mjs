import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExecutor } from '../agent/executor.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { TIMEOUT_MS } from '../hub/commands.js'
import { ACTION_KINDS } from '../hub/routing.js'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'
import { startPhoneHub } from './hub-device-helpers.mjs'
import { startFakeHub, startProxy } from './agent-proxy-helpers.mjs'
import { postJson } from './hub-helpers.mjs'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// The on-hold queue through the hub: any client holds a Done or Paused card, releases or continues a held session; the owning app does the work.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const onhold = (over = {}) => ({ type: 'onhold', sessionId: 's1', sessionTitle: 'Fix: Thing - 25751', workspace: 'D:/w', payload: { reason: 'later', heldAt: 1000, ticket: null, baseline: null, lastCheckedAt: null, checkError: null }, ...over })
const KINDS = ['hold', 'hold-release', 'hold-continue']

test('the hub knows the three on-hold actions and gives each a timeout (continue waits for the prompt call)', () => {
  for (const k of KINDS) assert.ok(ACTION_KINDS.includes(k), k)
  assert.equal(TIMEOUT_MS['hold-continue'], 35_000)
  assert.equal(TIMEOUT_MS['hold-release'], 10_000)
  assert.ok(TIMEOUT_MS.hold >= 10_000)
})

test('the desktop holds, releases and continues: the owner app gets the command for that item', async (t) => {
  const { port } = await startHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, onhold()))
  for (const kind of KINDS) {
    const pending = postJson(port, P + '/v1/' + kind, { id: a.itemId(1), reason: 'because' })
    const cmd = (await a.poll(0, 3000)).json.commands[0]
    assert.deepEqual([cmd.kind, cmd.itemId], [kind, a.itemId(1)])
    await a.result(cmd.cid, { ok: true })
    assert.deepEqual([(await pending).status, (await pending).json], [200, { ok: true }])
    await a.poll(cmd.seq, 0)
  }
})

test('a paired phone may hold, release and continue: they are on DEVICE_ACTIONS', async (t) => {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, onhold()))
  const p = await h.pairPhone()
  const pending = p.call('POST', P + '/v1/hold-release', { id: a.itemId(1) })
  const cmd = (await a.poll(0, 3000)).json.commands[0]
  assert.deepEqual([cmd.kind, cmd.itemId], ['hold-release', a.itemId(1)])
  await a.result(cmd.cid, { ok: true })
  assert.deepEqual([(await pending).status, (await pending).json], [200, { ok: true }])
  const http = readFileSync(join(root, 'hub', 'http.js'), 'utf8')
  const m = /const DEVICE_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(http)
  const actions = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  for (const k of KINDS) assert.ok(actions.includes(k), k)
})

test('an onhold item is adopted by an online app after a restart, like a Done card', () => {
  const src = readFileSync(join(root, 'hub', 'instances.js'), 'utf8')
  assert.match(src, /const ADOPTABLE = new Set\(\[[^\]]*'onhold'/)
})

test('the executor runs the three commands against the local queue', async () => {
  const calls = []
  const queue = {
    holdItem: async (id, o) => { calls.push(['hold', id, o.reason]); return { ok: true } },
    releaseHold: (id) => { calls.push(['release', id]); return { ok: true } },
    continueHold: async (id) => { calls.push(['continue', id]); return { ok: true } },
  }
  const ex = createExecutor({ queue, adapter: {} })
  assert.deepEqual(await ex.execute({ cid: 'c1', kind: 'hold', itemId: 'i1', args: { reason: 'r' } }), { ok: true })
  assert.deepEqual(await ex.execute({ cid: 'c2', kind: 'hold-release', itemId: 'i2' }), { ok: true })
  assert.deepEqual(await ex.execute({ cid: 'c3', kind: 'hold-continue', itemId: 'i3' }), { ok: true })
  assert.deepEqual(calls, [['hold', 'i1', 'r'], ['release', 'i2'], ['continue', 'i3']])
})

function hubQueueOf(state = 'connected') {
  const calls = []
  const local = {
    snapshot: () => ({ open: [], resolved: [] }), count: () => ({}), onChange: () => () => {}, uiState: () => ({}), workspaces: () => [],
    holdItem: async (id, o) => { calls.push(['local-hold', id, o]); return { ok: true, from: 'local' } },
    releaseHold: (id) => { calls.push(['local-release', id]); return { ok: true, from: 'local' } },
    continueHold: async (id) => { calls.push(['local-continue', id]); return { ok: true, from: 'local' } },
  }
  const client = {
    state, calls, mirror: { ready: true, snapshot: () => ({ snapshotId: 'e:1', open: [], resolved: [] }), workspaces: () => [], onChange: () => () => {} }, onState: () => () => {},
    call: async (kind, body) => { calls.push([kind, body]); return { ok: true, from: 'hub' } },
  }
  return { calls, queue: createHubQueue({ local, client, controllerOf: () => ({}) }) }
}

test('in hub mode the actions go through the hub, without it they run on the local queue', async () => {
  const hubbed = hubQueueOf()
  await hubbed.queue.holdItem('a', { reason: 'why' })
  await hubbed.queue.releaseHold('b')
  await hubbed.queue.continueHold('c')
  assert.deepEqual(hubbed.calls, [['hold', { id: 'a', reason: 'why' }], ['hold-release', { id: 'b' }], ['hold-continue', { id: 'c' }]])
  const alone = hubQueueOf('degraded')
  await alone.queue.holdItem('a', { reason: 'why' })
  await alone.queue.releaseHold('b')
  await alone.queue.continueHold('c')
  assert.deepEqual(alone.calls.map((c) => c[0]), ['local-hold', 'local-release', 'local-continue'])
})

test('the proxy forwards the three routes to the hub', async (t) => {
  const hub = await startFakeHub(t)
  const queue = createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}), speaker: undefined })
  const p = await startProxy(t, { hub, queue })
  for (const k of KINDS) assert.equal((await p.post('/v1/' + k, { id: 'x' })).status, 200, k)
  assert.deepEqual(hub.requests.map((r) => r.url), KINDS.map((k) => '/review-queue/v1/' + k))
})
