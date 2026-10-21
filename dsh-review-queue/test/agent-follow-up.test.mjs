import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExecutor } from '../agent/executor.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { startFakeHub, startProxy } from './agent-proxy-helpers.mjs'

// Follow-up todo, app side (docs/hub.md 6.4a): the executor's three commands, the hub queue forwarding followUp / sessionId, and the proxy relaying
// the bodies (and the session list) to the hub.

let n = 0
const cmd = (kind, itemId, args = {}) => ({ cid: 'f' + ++n, seq: n, kind, itemId, args })
const later = (ms) => new Promise((r) => setTimeout(r, ms))

function make({ sessions = [], results = {}, followUpSessions } = {}) {
  const calls = []
  const rec = (name) => (...args) => { calls.push([name, ...args]); return results[name] ?? { ok: true, from: name } }
  const queue = { addTodo: rec('addTodo'), confirmTodo: rec('confirmTodo'), approve: rec('approve'), reply: async (...a) => rec('reply')(...a) }
  if (followUpSessions !== 'none') queue.followUpSessions = followUpSessions ?? (async () => { calls.push(['followUpSessions']); return sessions })
  const adapter = { adopt: rec('adopt'), applyRemote: rec('applyRemote') }
  return { executor: createExecutor({ queue, adapter }), calls }
}

// ---- executor -------------------------------------------------------------------------------------------------------------------------

test('sessions-list answers this app\'s follow-up candidates: { ok: true, sessions }', async () => {
  const sessions = [{ sessionId: 's1', title: 'T1', workspaceTitle: 'W', updatedAt: 5, running: true, snippet: 'last words' }, { sessionId: 's2', title: 'T2' }]
  const { executor, calls } = make({ sessions })
  assert.deepEqual(await executor.execute(cmd('sessions-list')), { ok: true, sessions })
  assert.deepEqual(calls, [['followUpSessions']])
})

test('sessions-list keeps at most 60 sessions, clips long text and drops what is not a session', async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ sessionId: 's' + i, title: 'T' + i, updatedAt: 1000 - i }))
  const { executor } = make({ sessions: [null, { title: 'no id' }, { sessionId: 's-long', title: 'x'.repeat(5000), snippet: 'y'.repeat(5000), evil: 'field' }, ...many] })
  const answer = await executor.execute(cmd('sessions-list'))
  assert.equal(answer.sessions.length, 60)
  assert.deepEqual(answer.sessions[0].sessionId, 's-long')
  assert.ok(answer.sessions[0].title.length <= 200 && answer.sessions[0].snippet.length <= 200)
  assert.deepEqual(Object.keys(answer.sessions[0]).sort(), ['sessionId', 'snippet', 'title'])
  assert.deepEqual(answer.sessions.slice(1, 3).map((s) => s.sessionId), ['s0', 's1'])
})

test('sessions-list that cannot be answered is a refusal, never a throw: a failing list, and an app without one', async () => {
  const boom = make({ followUpSessions: async () => { throw new Error('kaboom') } })
  assert.deepEqual(await boom.executor.execute(cmd('sessions-list')), { ok: false, error: 'kaboom' })
  const bare = make({ followUpSessions: 'none' })
  const answer = await bare.executor.execute(cmd('sessions-list'))
  assert.equal(answer.ok, false)
  assert.equal(typeof answer.error, 'string')
})

test('sessions-list is a read: it runs at once beside a slow command and its result is not kept (the same cid lists again)', async () => {
  const order = []
  let release
  const gate = new Promise((r) => { release = r })
  let lists = 0
  const approvals = []
  const executor = createExecutor({
    queue: {
      reply: async () => { order.push('reply start'); await gate; order.push('reply end'); return { ok: true } },
      followUpSessions: async () => { lists++; return [] },
      approve: (id) => { approvals.push(id); return { ok: true } },
    },
    adapter: {},
  })
  const slow = executor.execute(cmd('reply', 'a', { text: 'x' }))
  await later(20)
  const listed = await executor.execute(cmd('sessions-list'))
  assert.deepEqual(listed, { ok: true, sessions: [] }, 'it did not wait for the reply')
  assert.deepEqual(order, ['reply start'])
  release()
  await slow
  const keep = cmd('approve', 'keep', { via: 'phone' })
  await executor.execute(keep)
  const read = cmd('sessions-list')
  await executor.execute(read)
  await executor.execute({ ...read })
  assert.equal(lists, 3, 'once for the first, twice for the repeated cid')
  for (let i = 0; i < 250; i++) await executor.execute(cmd('sessions-list'))
  await executor.execute({ ...keep })
  assert.deepEqual(approvals, ['keep'], 'the reads pushed nothing out of the 200 cached results')
})

test('followup-suggest adds the follow-up with the words and the hub\'s union of sessions, and answers what addTodo answers', async () => {
  const sessions = [{ sessionId: 's1', title: 'T1', owner: 'aaaa1111' }]
  const { executor, calls } = make({ results: { addTodo: { ok: true, id: 'aaaa-000000000001', state: 'awaiting-confirm' } } })
  const answer = await executor.execute(cmd('followup-suggest', undefined, { text: 'also null', followUp: 'the PR review', sessions }))
  assert.deepEqual(answer, { ok: true, id: 'aaaa-000000000001', state: 'awaiting-confirm' })
  assert.deepEqual(calls, [['addTodo', 'also null', { followUp: 'the PR review', sessions }]])
})

test('followup-suggest passes the count of apps the hub could not ask on to the follow-up', async () => {
  const { executor, calls } = make()
  await executor.execute(cmd('followup-suggest', undefined, { text: 'also null', followUp: 'the PR review', sessions: [], skippedApps: 2 }))
  assert.deepEqual(calls, [['addTodo', 'also null', { followUp: 'the PR review', sessions: [], skippedApps: 2 }]])
})

test('followup-send confirms the item with the session; a moved item is adopted first', async () => {
  const { executor, calls } = make()
  const first = await executor.execute(cmd('followup-send', 'i7', { sessionId: 'sb1' }))
  assert.deepEqual([first, calls.at(-1)], [{ ok: true, from: 'confirmTodo' }, ['confirmTodo', 'i7', { sessionId: 'sb1' }]])
  const moved = { id: 'aaaa-000000000009', type: 'todo', kind: 'followup', text: 'x', candidates: [] }
  await executor.execute(cmd('followup-send', moved.id, { sessionId: 'sb1', item: moved }))
  assert.deepEqual(calls.slice(-2), [['adopt', moved], ['confirmTodo', moved.id, { sessionId: 'sb1' }]])
})

test('followup-send is not run twice for one cid: a re-delivery (also at the same time) gets the first answer and sends nothing again', async () => {
  const { executor, calls } = make({ results: { confirmTodo: { ok: true, state: 'starting' } } })
  const c = cmd('followup-send', 'i1', { sessionId: 'sb1' })
  const [first, second] = await Promise.all([executor.execute(c), executor.execute(c)])
  const third = await executor.execute({ ...c })
  assert.deepEqual([second, third], [first, first])
  assert.equal(calls.filter((x) => x[0] === 'confirmTodo').length, 1)
  await executor.execute(cmd('followup-send', 'i1', { sessionId: 'sb1' })) // a new command (the user's retry) is a new send
  assert.equal(calls.filter((x) => x[0] === 'confirmTodo').length, 2)
})

test('followup-send runs in the serial chain: it waits for a slow command queued before it', async () => {
  const order = []
  let release
  const gate = new Promise((r) => { release = r })
  const executor = createExecutor({
    queue: { reply: async () => { order.push('reply start'); await gate; order.push('reply end'); return { ok: true } }, confirmTodo: () => { order.push('send'); return { ok: true } } },
    adapter: {},
  })
  const slow = executor.execute(cmd('reply', 'a', { text: 'x' }))
  const send = executor.execute(cmd('followup-send', 'b', { sessionId: 's' }))
  await later(30)
  assert.deepEqual(order, ['reply start'])
  release()
  await Promise.all([slow, send])
  assert.deepEqual(order, ['reply start', 'reply end', 'send'])
})

// ---- hub queue ------------------------------------------------------------------------------------------------------------------------

function fakeLocal() {
  const calls = []
  const local = {
    addTodo: (...a) => { calls.push(['addTodo', ...a]); return { ok: true, from: 'local' } },
    confirmTodo: (...a) => { calls.push(['confirmTodo', ...a]); return { ok: true, from: 'local' } },
    followUpSessions: async () => { calls.push(['followUpSessions']); return [{ sessionId: 'own1', title: 'Own' }] },
    onChange: () => () => {}, snapshot: () => ({ snapshotId: 'l', open: [], resolved: [] }), uiState: () => undefined,
  }
  return Object.assign(local, { calls })
}
function fakeClient(state = 'connected') {
  const c = {
    state, calls: [],
    mirror: { ready: true, snapshot: () => ({ snapshotId: 'e:1', open: [], resolved: [] }), workspaces: () => [], onChange: () => () => {} },
    onState: () => () => {},
    call: async (kind, body) => { c.calls.push([kind, body]); return { ok: true, from: 'hub' } },
  }
  return c
}
const hubQueue = (local, client) => createHubQueue({ local, client, controllerOf: () => ({}), now: () => 5000 })

test('hub mode: addTodo sends the words of a follow-up to the hub (and nothing else added)', async () => {
  const client = fakeClient()
  const queue = hubQueue(fakeLocal(), client)
  assert.deepEqual(await queue.addTodo('also null', { followUp: 'the PR review' }), { ok: true, from: 'hub' })
  assert.deepEqual(client.calls, [['todo', { text: 'also null', followUp: 'the PR review' }]])
  await queue.addTodo('plain', {})
  assert.deepEqual(client.calls.at(-1), ['todo', { text: 'plain' }], 'an ordinary todo has no followUp field')
})

test('hub mode: addTodo never sends a sessions list of its own to the hub', async () => {
  const client = fakeClient()
  const queue = hubQueue(fakeLocal(), client)
  await queue.addTodo('x', { followUp: 'words', sessions: [{ sessionId: 'evil' }] })
  assert.deepEqual(client.calls, [['todo', { text: 'x', followUp: 'words' }]])
})

test('hub mode: confirmTodo sends the chosen session to the hub', async () => {
  const client = fakeClient()
  const queue = hubQueue(fakeLocal(), client)
  await queue.confirmTodo('i1', { sessionId: 'sb1' })
  assert.deepEqual(client.calls, [['todo-confirm', { id: 'i1', sessionId: 'sb1' }]])
  await queue.confirmTodo('i2', { workspaceId: 'aaaa/w1' })
  assert.deepEqual(client.calls.at(-1), ['todo-confirm', { id: 'i2', workspaceId: 'aaaa/w1' }])
})

test('without a hub the local service gets the follow-up words and the session, unchanged', async () => {
  const local = fakeLocal()
  const queue = hubQueue(local, fakeClient('degraded'))
  await queue.addTodo('also null', { followUp: 'the PR review' })
  await queue.confirmTodo('i1', { sessionId: 'sa1' })
  assert.deepEqual(local.calls, [['addTodo', 'also null', { followUp: 'the PR review' }], ['confirmTodo', 'i1', { sessionId: 'sa1' }]])
})

test('hub mode: a call that cannot reach the hub is answered hub-unreachable and logged with the action and the error code only', async () => {
  const lines = []
  const client = fakeClient()
  client.call = async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1 with a secret path D:/x'), { code: 'ECONNREFUSED' }) }
  const queue = createHubQueue({ local: fakeLocal(), client, controllerOf: () => ({}), now: () => 5000, log: (l) => lines.push(l) })
  assert.deepEqual(await queue.addTodo('also null', { followUp: 'the PR review' }), { ok: false, error: 'hub-unreachable' })
  assert.deepEqual(await queue.confirmTodo('i1', { sessionId: 'sb1' }), { ok: false, error: 'hub-unreachable' })
  assert.deepEqual(lines, ['hub-queue: todo failed (ECONNREFUSED)', 'hub-queue: todo-confirm failed (ECONNREFUSED)'])
  const quiet = createHubQueue({ local: fakeLocal(), client, controllerOf: () => ({}), now: () => 5000 })
  assert.deepEqual(await quiet.addTodo('x', { followUp: 'y' }), { ok: false, error: 'hub-unreachable' }, 'without a log it is still answered')
})

test('the hub queue has no followUpSessions: the list of an app is read by the executor from the local service, the union is the hub\'s', () => {
  assert.equal('followUpSessions' in hubQueue(fakeLocal(), fakeClient()), false)
})

// ---- proxy ----------------------------------------------------------------------------------------------------------------------------

test('proxy in hub mode relays a follow-up todo to the hub with its words and relays the hub\'s answer (and its refusal)', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = (rec) => (rec.body.followUp === '' ? [400, { ok: false, error: 'empty-query' }] : [200, { ok: true, id: 'aaaa-000000000001', state: 'awaiting-confirm' }])
  const api = await startProxy(t, { hub })
  const ok = await api.post('/v1/todo', { text: 'also null', followUp: 'the PR review' })
  assert.deepEqual([ok.status, ok.json.state], [200, 'awaiting-confirm'])
  assert.deepEqual([hub.requests[0].method, hub.requests[0].url, hub.requests[0].body], ['POST', '/review-queue/v1/todo', { text: 'also null', followUp: 'the PR review' }])
  assert.equal(hub.requests[0].headers['x-rq-role'], 'desktop')
  const bad = await api.post('/v1/todo', { text: 'x', followUp: '' })
  assert.deepEqual([bad.status, bad.json], [400, { ok: false, error: 'empty-query' }])
})

test('proxy in hub mode relays the confirm with its session', async (t) => {
  const hub = await startFakeHub(t)
  const api = await startProxy(t, { hub })
  const res = await api.post('/v1/todo-confirm', { id: 'aaaa-000000000001', sessionId: 'sb1' })
  assert.equal(res.status, 200)
  assert.deepEqual([hub.requests[0].url, hub.requests[0].body], ['/review-queue/v1/todo-confirm', { id: 'aaaa-000000000001', sessionId: 'sb1' }])
})

test('proxy without a hub answers a follow-up todo from the local service', async (t) => {
  const api = await startProxy(t, { mode: 'standalone', reason: 'x' })
  const res = await api.post('/v1/todo', { text: 'also null', followUp: 'the PR review' })
  assert.deepEqual([res.status, res.json.ok, res.json.state], [200, true, 'awaiting-confirm'])
  const item = api.store.get(res.json.id)
  assert.deepEqual([item.kind, item.query, item.text], ['followup', 'the PR review', 'also null'])
})

test('proxy: there is no session list route any more: the hub is not asked and the answer is the local unknown-action', async (t) => {
  const hub = await startFakeHub(t)
  const api = await startProxy(t, { hub })
  const res = await api.get('/v1/followup-sessions')
  assert.deepEqual([res.status, res.json], [404, { error: 'unknown-action' }])
  assert.deepEqual(hub.requests, [])
})
