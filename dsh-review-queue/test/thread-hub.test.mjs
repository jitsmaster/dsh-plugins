import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExecutor } from '../agent/executor.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { TIMEOUT_MS } from '../hub/commands.js'
import { ACTION_KINDS } from '../hub/routing.js'
import { postJson, tmpDir } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'
import { P as PD, startPhoneHub } from './hub-device-helpers.mjs'
import { startFakeHub, startProxy } from './agent-proxy-helpers.mjs'
import { writeFileSync } from 'node:fs'

// thread and post through the hub (docs/hub.md 6.2): same URL layout and routing as reply, but the item need not be open.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const act = (port, kind, body, headers) => postJson(port, P + '/v1/' + kind, body, headers)
const THREAD = { ok: true, sessionId: 's1', title: 'One', messages: [{ id: 1, role: 'user', text: 'hi', time: 5 }, { id: 2, role: 'assistant', text: 'hello' }], hasMore: true, cursor: 1 }

/** Post one action, let the agent fetch it and (when result is given) answer it. */
async function viaAgent(agent, port, kind, body, result, headers) {
  const pending = act(port, kind, body, headers)
  const cmd = (await agent.poll(0, 3000)).json.commands[0]
  if (cmd && result) await agent.result(cmd.cid, result)
  return { res: await pending, cmd }
}
async function oneApp(t) {
  const ctx = await startHub(t)
  const a = agentOf(ctx.port)
  await a.register({ sync: sync() })
  return { ...ctx, a }
}

// ---- the hub routes ---------------------------------------------------------------------------------------------------------------

test('thread goes to the owner as the command thread with before and limit; its answer comes back intact', async (t) => {
  const { port, a } = await oneApp(t)
  await a.send(a.add(1))
  const { res, cmd } = await viaAgent(a, port, 'thread', { id: a.itemId(1), before: 30, limit: 10 }, THREAD)
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args], ['thread', a.itemId(1), { before: 30, limit: 10, sessionId: 's1' }])
  assert.deepEqual([res.status, res.json], [200, THREAD])
})

test('thread without paging arguments sends the session id of the item only', async (t) => {
  const { port, a } = await oneApp(t)
  await a.send(a.add(1))
  const { cmd } = await viaAgent(a, port, 'thread', { id: a.itemId(1) }, THREAD)
  assert.deepEqual(cmd.args, { sessionId: 's1' })
})

test('post goes to the owner as the command post with the text', async (t) => {
  const { port, a } = await oneApp(t)
  await a.send(a.add(1))
  const { res, cmd } = await viaAgent(a, port, 'post', { id: a.itemId(1), text: 'and now?' }, { ok: true })
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args], ['post', a.itemId(1), { text: 'and now?' }])
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
})

test('thread and post work on a resolved item too: it need not be open', async (t) => {
  const { port, a } = await oneApp(t)
  await a.send(a.add(1), { op: 'resolve', id: a.itemId(1), resolution: { kind: 'reviewed', by: 'card' } })
  const thread = await viaAgent(a, port, 'thread', { id: a.itemId(1) }, THREAD)
  assert.deepEqual([thread.res.status, thread.cmd.kind], [200, 'thread'])
  const post = await viaAgent(a, port, 'post', { id: a.itemId(1), text: 'one more' }, { ok: true })
  assert.deepEqual([post.res.status, post.cmd.kind], [200, 'post'])
})

test('an unknown item is 409 not-found, and a refusal of the owner keeps its status and code', async (t) => {
  const { port, a } = await oneApp(t)
  await a.send(a.add(1))
  assert.deepEqual([(await act(port, 'thread', { id: 'nope' })).json, (await act(port, 'post', { id: 'nope', text: 'x' })).json], [{ ok: false, error: 'not-found' }, { ok: false, error: 'not-found' }])
  const gone = await viaAgent(a, port, 'thread', { id: a.itemId(1) }, { ok: false, error: 'no-log' })
  assert.deepEqual([gone.res.status, gone.res.json], [409, { ok: false, error: 'no-log' }])
  const empty = await viaAgent(a, port, 'post', { id: a.itemId(1), text: '' }, { ok: false, error: 'empty' })
  assert.deepEqual([empty.res.status, empty.res.json], [400, { ok: false, error: 'empty' }])
})

test('an owner that never fetches thread or post: 504 owner-timeout at the timeout of the kind (15 s and 35 s)', async (t) => {
  assert.deepEqual([TIMEOUT_MS.thread, TIMEOUT_MS.post], [15_000, 35_000])
  const ctx = await startHub(t, { commandTimeoutsMs: { thread: 100, post: 100 } })
  const a = agentOf(ctx.port)
  await a.register({ sync: sync() })
  await a.send(a.add(1))
  const thread = await act(ctx.port, 'thread', { id: a.itemId(1) })
  const post = await act(ctx.port, 'post', { id: a.itemId(1), text: 'x' })
  assert.deepEqual([thread.status, thread.json, post.status, post.json], [504, { ok: false, error: 'owner-timeout' }, 504, { ok: false, error: 'owner-timeout' }])
})

test('the owner is offline: thread and post say so, also for a resolved item', async (t) => {
  const { hub, port, a } = await oneApp(t)
  await a.send(a.add(1), a.add(2), { op: 'resolve', id: a.itemId(2), resolution: { kind: 'reviewed', by: 'card' } })
  hub.instances.bye(a.id)
  for (const n of [1, 2]) {
    assert.deepEqual((await act(port, 'thread', { id: a.itemId(n) })).json, { ok: false, error: 'owner-offline' }, 'thread ' + n)
    assert.deepEqual((await act(port, 'post', { id: a.itemId(n), text: 'x' })).json, { ok: false, error: 'owner-offline' }, 'post ' + n)
  }
})

test('thread and post are known actions of the hub', () => {
  assert.ok(ACTION_KINDS.includes('thread') && ACTION_KINDS.includes('post'))
})

// ---- ownerless items --------------------------------------------------------------------------------------------------------------

const row = (id, over = {}) => ({ id, seq: 1, type: 'completed', status: 'open', createdAt: 1_800_000_000_000, sessionId: 's-' + id, payload: { reply: 'r' }, ...over })
async function legacyHub(t) {
  const dir = tmpDir(t)
  writeFileSync(join(dir, 'queue.json'), JSON.stringify({ v: 1, seq: 3, items: [row('old', { seq: 1, status: 'resolved', resolution: { kind: 'reviewed', by: 'card' } }), row('open', { seq: 2 })] }))
  return startHub(t, { dir })
}

test('an ownerless resolved item has nobody to ask: owner-offline, like late-answer', async (t) => {
  const { port } = await legacyHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  assert.deepEqual((await act(port, 'thread', { id: 'old' })).json, { ok: false, error: 'owner-offline' })
  assert.deepEqual((await act(port, 'post', { id: 'old', text: 'x' })).json, { ok: false, error: 'owner-offline' })
  assert.deepEqual((await a.poll(0, 0)).json.commands, [])
})

test('thread on an ownerless open item goes to the coordinator like open-session: the command alone, no adopt, the item is not taken', async (t) => {
  const { hub, port } = await legacyHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  const pending = act(port, 'thread', { id: 'open' })
  const cmds = (await a.poll(0, 3000)).json.commands
  assert.deepEqual(cmds.map((c) => c.kind), ['thread'], 'no apply / adopt first')
  assert.deepEqual([cmds[0].itemId, cmds[0].args], ['open', { sessionId: 's-open' }], 'the coordinator does not hold the item: it is told the session')
  assert.equal(hub.store.get('open').owner, undefined, 'the owner is not set while it reads')
  await a.result(cmds[0].cid, { ok: true, ...THREAD })
  assert.deepEqual((await pending).json, { ok: true, ...THREAD })
  assert.equal(hub.store.get('open').owner, undefined, 'a read does not adopt the item either')
  const failing = act(port, 'thread', { id: 'open' })
  const again = (await a.poll(1, 3000)).json.commands
  assert.deepEqual(again.map((c) => c.kind), ['thread'])
  await a.result(again[0].cid, { ok: false, error: 'no-log' })
  assert.deepEqual((await failing).json, { ok: false, error: 'no-log' })
  assert.equal(hub.store.get('open').owner, undefined)
})

test('post on an ownerless open item still adopts first and a refusal leaves it ownerless as session-unavailable', async (t) => {
  const { hub, port } = await legacyHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  const again = act(port, 'post', { id: 'open', text: 'hello' })
  const first = (await a.poll(0, 3000)).json.commands
  assert.deepEqual(first.map((c) => c.kind), ['apply', 'post'])
  const got = first.find((c) => c.kind === 'post')
  await a.result(got.cid, { ok: false, error: 'no-session' })
  assert.deepEqual((await again).json, { ok: false, error: 'session-unavailable' })
  assert.equal(hub.store.get('open').owner, undefined)
})

test('with no app online an ownerless open item is owner-offline', async (t) => {
  const { port } = await legacyHub(t)
  assert.deepEqual((await act(port, 'thread', { id: 'open' })).json, { ok: false, error: 'owner-offline' })
})

// ---- the phone --------------------------------------------------------------------------------------------------------------------

test('a paired phone may read the thread and post: the owner gets the commands, and the answer reaches the phone', async (t) => {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: sync() })
  await a.send(a.add(1))
  const p = await h.pairPhone()
  const phoneAct = async (kind, body, result) => {
    const pending = p.call('POST', PD + '/v1/' + kind, body)
    const cmd = (await a.poll(0, 3000)).json.commands[0]
    await a.result(cmd.cid, result)
    return { res: await pending, cmd }
  }
  const thread = await phoneAct('thread', { id: a.itemId(1), limit: 40 }, THREAD)
  assert.deepEqual([thread.res.status, thread.res.json, thread.cmd.args], [200, THREAD, { limit: 40, sessionId: 's1' }])
  const post = await phoneAct('post', { id: a.itemId(1), text: 'hi from the phone' }, { ok: true })
  assert.deepEqual([post.res.status, post.cmd.kind, post.cmd.args], [200, 'post', { text: 'hi from the phone' }])
})

test('the chat actions keep the other fences: a stranger is 401, a foreign Origin is refused, a revoked phone is 401', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  for (const kind of ['thread', 'post']) {
    assert.equal((await h.stranger('POST', PD + '/v1/' + kind, { id: 'x', text: 'x' })).status, 401, kind + ' stranger')
    const evil = await p.call('POST', PD + '/v1/' + kind, { id: 'x', text: 'x' }, { origin: 'https://evil.example' })
    assert.deepEqual([evil.status, evil.json], [403, { error: 'bad-origin' }], kind + ' origin')
  }
  await h.desktop('POST', '/hub/v1/devices/' + p.deviceId + '/revoke', {})
  assert.equal((await p.call('POST', PD + '/v1/thread', { id: 'x' })).status, 401)
})

test('DEVICE_ACTIONS lists thread and post for the phone', () => {
  const http = readFileSync(join(root, 'hub', 'http.js'), 'utf8')
  const m = /const DEVICE_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(http)
  const actions = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  assert.ok(actions.includes('thread') && actions.includes('post'))
})

// ---- the app side -----------------------------------------------------------------------------------------------------------------

test('the executor runs thread and post against the local queue and answers with what it returns', async () => {
  const calls = []
  const queue = { thread: async (id, opts) => { calls.push(['thread', id, opts]); return THREAD }, post: async (id, text) => { calls.push(['post', id, text]); return { ok: true } } }
  const ex = createExecutor({ queue, adapter: {} })
  assert.deepEqual(await ex.execute({ cid: 'c1', kind: 'thread', itemId: 'i1', args: { before: 9, limit: 3 } }), THREAD)
  assert.deepEqual(await ex.execute({ cid: 'c2', kind: 'thread', itemId: 'i1' }), THREAD)
  assert.deepEqual(await ex.execute({ cid: 'c3', kind: 'post', itemId: 'i2', args: { text: 'go' } }), { ok: true })
  assert.deepEqual(calls, [['thread', 'i1', { before: 9, limit: 3 }], ['thread', 'i1', {}], ['post', 'i2', 'go']])
})

function hubQueue(connected = true) {
  const calls = []
  const local = Object.fromEntries(['snapshot', 'thread', 'post'].map((m) => [m, async (...a) => { calls.push(['local-' + m, ...a]); return { ok: true, from: 'local' } }]))
  local.onChange = () => () => {}
  local.uiState = () => ({})
  const client = {
    state: connected ? 'connected' : 'degraded', mirror: { ready: true, snapshot: () => ({ snapshotId: 'e:1', open: [], resolved: [] }), workspaces: () => [], onChange: () => () => {} },
    call: async (kind, body) => { calls.push(['hub', kind, body]); return { ok: true, from: 'hub' } }, onState: () => () => {},
  }
  return { calls, queue: createHubQueue({ local, client, now: () => 1 }) }
}

test('in hub mode thread and post go through the hub with only the arguments that were given', async () => {
  const { calls, queue } = hubQueue()
  await queue.thread('a', { before: 12, limit: 5 })
  await queue.thread('a')
  await queue.post('a', 'hi')
  assert.deepEqual(calls, [['hub', 'thread', { id: 'a', before: 12, limit: 5 }], ['hub', 'thread', { id: 'a' }], ['hub', 'post', { id: 'a', text: 'hi' }]])
})

test('without the hub the local service answers thread and post', async () => {
  const { calls, queue } = hubQueue(false)
  assert.deepEqual(await queue.thread('a', { limit: 2 }), { ok: true, from: 'local' })
  assert.deepEqual(await queue.post('a', 'hi'), { ok: true, from: 'local' })
  assert.deepEqual(calls, [['local-thread', 'a', { limit: 2 }], ['local-post', 'a', 'hi', {}]]) // the third argument is the post options (the idempotency key)
})

test('the overlay proxy forwards thread and post to the hub and returns its answer untouched', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, THREAD]
  const p = await startProxy(t, { hub })
  const res = await p.post('/v1/thread', { id: 'x', before: 4 })
  assert.deepEqual([res.status, res.json], [200, THREAD])
  await p.post('/v1/post', { id: 'x', text: 'hi' })
  assert.deepEqual(hub.requests.map((r) => [r.url, r.body]), [['/review-queue/v1/thread', { id: 'x', before: 4 }], ['/review-queue/v1/post', { id: 'x', text: 'hi' }]])
})
