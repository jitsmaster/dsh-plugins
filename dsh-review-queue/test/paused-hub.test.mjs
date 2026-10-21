import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExecutor } from '../agent/executor.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { TIMEOUT_MS } from '../hub/commands.js'
import { ACTION_KINDS } from '../hub/routing.js'
import { PUSH_TYPES } from '../lib/mobile/push-client.js'
import { createReviewQueue } from '../service.js'
import { createStore } from '../store.js'
import { createDismissals, createPausedTracker } from '../paused.js'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'
import { startPhoneHub } from './hub-device-helpers.mjs'
import { startFakeHub, startProxy } from './agent-proxy-helpers.mjs'
import { postJson } from './hub-helpers.mjs'

// Paused sessions through the hub: the desktop resumes or dismisses (a command to the owner app), the phone only reads.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const paused = (over = {}) => ({ type: 'paused', sessionId: 's1', sessionTitle: 'Fix it', workspace: 'D:/w', payload: { lastWrite: 1000, kinds: ['open-turn'], reason: 'Cut off in the middle of a turn', turn: 1, danglingCalls: [], pending: 0, lastUser: 'go', lastAssistant: '' }, ...over })

test('the hub knows both actions, with their timeouts (resume waits for the prompt call, 30 s inside)', () => {
  assert.ok(ACTION_KINDS.includes('paused-resume') && ACTION_KINDS.includes('paused-dismiss'))
  assert.equal(TIMEOUT_MS['paused-resume'], 35_000)
  assert.equal(TIMEOUT_MS['paused-dismiss'], 10_000)
})

test('the desktop resumes a paused item: the owner app gets paused-resume for that item; dismiss likewise', async (t) => {
  const { port } = await startHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, paused()))
  for (const kind of ['paused-resume', 'paused-dismiss']) {
    const pending = postJson(port, P + '/v1/' + kind, { id: a.itemId(1) })
    const got = await a.poll(0, 3000)
    const cmd = got.json.commands[0]
    assert.deepEqual([cmd.kind, cmd.itemId], [kind, a.itemId(1)])
    await a.result(cmd.cid, { ok: true })
    assert.deepEqual([(await pending).status, (await pending).json], [200, { ok: true }])
    await a.poll(cmd.seq, 0)
  }
})

test('a refusal of the owner app (the session is gone) reaches the desktop as a 409 with its code', async (t) => {
  const { port } = await startHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, paused()))
  const pending = postJson(port, P + '/v1/paused-resume', { id: a.itemId(1) })
  const cmd = (await a.poll(0, 3000)).json.commands[0]
  await a.result(cmd.cid, { ok: false, error: 'session-gone' })
  const res = await pending
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'session-gone' }])
})

test('the phone sees paused items and may dismiss one (the owner app gets paused-dismiss) but not resume it: 403 desktop-only', async (t) => {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, paused()))
  const p = await h.pairPhone()
  const snap = await p.call('GET', P + '/v1/snapshot')
  const item = snap.json.open.find((i) => i.type === 'paused')
  assert.deepEqual([item.sessionTitle, item.title], ['Fix it', 'Fix it'])
  assert.match(item.spoken.headline, /^Item 1\. Paused session Fix it/)
  const resume = await p.call('POST', P + '/v1/paused-resume', { id: a.itemId(1) })
  assert.deepEqual([resume.status, resume.json.error], [403, 'desktop-only'], 'paused-resume')
  assert.deepEqual((await a.poll(0, 0)).json.commands, [])
  const pending = p.call('POST', P + '/v1/paused-dismiss', { id: a.itemId(1) })
  const cmd = (await a.poll(0, 3000)).json.commands[0]
  assert.deepEqual([cmd.kind, cmd.itemId], ['paused-dismiss', a.itemId(1)])
  await a.result(cmd.cid, { ok: true })
  assert.deepEqual([(await pending).status, (await pending).json], [200, { ok: true }])
})

test('DEVICE_ACTIONS has paused-dismiss but not paused-resume on the phone list', () => {
  const http = readFileSync(join(root, 'hub', 'http.js'), 'utf8')
  const m = /const DEVICE_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(http)
  const actions = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort()
  assert.deepEqual(actions, ['answer', 'approve', 'approve-similar', 'archive', 'deny', 'late-answer', 'paused-dismiss', 'post', 'reopen', 'reply', 'reviewed', 'thread', 'todo', 'todo-cancel', 'todo-confirm'])
})

test('a paused item sends no push: the phone is told nothing about it', () => {
  assert.ok(!PUSH_TYPES.some((t) => t.id === 'paused'))
})

// ---- the agent side -------------------------------------------------------------------------------------------------------------------

test('the executor runs paused-resume and paused-dismiss against the local queue', async () => {
  const calls = []
  const queue = { resumePaused: async (id) => { calls.push(['resume', id]); return { ok: true } }, dismissPaused: (id) => { calls.push(['dismiss', id]); return { ok: true } } }
  const ex = createExecutor({ queue, adapter: {} })
  assert.deepEqual(await ex.execute({ cid: 'c1', kind: 'paused-resume', itemId: 'i1' }), { ok: true })
  assert.deepEqual(await ex.execute({ cid: 'c2', kind: 'paused-dismiss', itemId: 'i2' }), { ok: true })
  assert.deepEqual(calls, [['resume', 'i1'], ['dismiss', 'i2']])
})

function hubQueueOf(state = 'connected') {
  const calls = []
  const local = {
    snapshot: () => ({ open: [], resolved: [] }), count: () => ({}), onChange: () => () => {}, uiState: () => ({}), workspaces: () => [],
    resumePaused: async (id) => { calls.push(['local-resume', id]); return { ok: true, from: 'local' } },
    dismissPaused: (id) => { calls.push(['local-dismiss', id]); return { ok: true, from: 'local' } },
    scanPaused: async () => { calls.push(['local-scan']); return { ok: true, from: 'local' } },
  }
  const client = {
    state, calls, mirror: { ready: true, snapshot: () => ({ snapshotId: 'e:1', open: [], resolved: [] }), workspaces: () => [], onChange: () => () => {} }, onState: () => () => {},
    call: async (kind, body) => { calls.push([kind, body]); return { ok: true, from: 'hub' } },
  }
  return { calls, queue: createHubQueue({ local, client, controllerOf: () => ({}) }) }
}

test('in hub mode resume and dismiss go through the hub; the scan always runs here', async () => {
  const { calls, queue } = hubQueueOf()
  assert.equal((await queue.resumePaused('a')).from, 'hub')
  assert.equal((await queue.dismissPaused('b')).from, 'hub')
  assert.equal((await queue.scanPaused()).from, 'local')
  assert.deepEqual(calls, [['paused-resume', { id: 'a' }], ['paused-dismiss', { id: 'b' }], ['local-scan']])
})

test('without the hub (standalone, degraded) resume and dismiss run on the local queue', async () => {
  const { calls, queue } = hubQueueOf('degraded')
  assert.equal((await queue.resumePaused('a')).from, 'local')
  assert.equal((await queue.dismissPaused('b')).from, 'local')
  assert.deepEqual(calls, [['local-resume', 'a'], ['local-dismiss', 'b']])
})

test('the proxy forwards resume and dismiss to the hub and answers the scan itself', async (t) => {
  const hub = await startFakeHub(t)
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const tracker = createPausedTracker({ store, dismissals: createDismissals({ io: { read: () => undefined, write() {} } }), scan: async () => ({ ok: true, candidates: [] }) })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), speaker: undefined, paused: tracker })
  const p = await startProxy(t, { hub, queue })
  assert.equal((await p.post('/v1/paused-resume', { id: 'x' })).status, 200)
  assert.equal((await p.post('/v1/paused-dismiss', { id: 'x' })).status, 200)
  assert.deepEqual(hub.requests.map((r) => r.url), ['/review-queue/v1/paused-resume', '/review-queue/v1/paused-dismiss'])
  const scan = await p.post('/v1/paused-scan', {})
  assert.deepEqual([scan.status, scan.json.ok], [200, true])
  assert.equal(hub.requests.length, 2, 'the hub never hears of the scan')
})
