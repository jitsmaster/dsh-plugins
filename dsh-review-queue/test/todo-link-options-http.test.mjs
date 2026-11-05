import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter, outcome } from '../server.js'
import { createProxy } from '../agent/proxy.js'
import { act, autopilot, twoApps } from './hub-follow-up-helpers.mjs'
import { makeWorld, startPlugin, waitFor } from './plugin-helpers.mjs'

// requireConfirm, source, mode and excludeSessionIds are trusted-plugin options (the todo-link action only). A browser, a phone or the app proxy
// that sends them gets the untrusted behaviour: a given workspace starts at once, nothing is stored as the source.
const OPTIONS = { requireConfirm: true, source: { sessionId: 's1', title: 'T' }, mode: 'steer', excludeSessionIds: ['x'] }
const LINK_KEYS = ['requireConfirm', 'source', 'mode', 'excludeSessionIds', 'excludeIds']

function localQueue() {
  let n = 0
  let sessions = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const calls = []
  const controller = {
    create: async (arg) => { calls.push(['create', arg]); return { sessionId: 'S' + ++sessions } },
    rename: async () => {},
    prompt: async (req) => { calls.push(['prompt', req]); return {} },
  }
  const registry = { list: () => [{ id: 'w1', title: 'Alpha', path: 'D:/a', sessionIds: [] }], archivedSessionIds: [] }
  return { store, calls, queue: createReviewQueue({ store, capture: {}, controllerOf: () => controller, registryOf: () => registry }) }
}

const listen = async (t, handler) => {
  const server = createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  return 'http://127.0.0.1:' + server.address().port
}
const postTodo = async (base) => {
  const res = await fetch(base + '/v1/todo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Do the thing', workspaceId: 'w1', ...OPTIONS }) })
  return res.json()
}
const assertUntrusted = (item) => {
  assert.equal(item.state === 'starting' || item.state === 'started', true, 'state ' + item.state)
  for (const key of LINK_KEYS) assert.equal(key in item, false, key)
}

test('1 standalone server: POST /v1/todo with a workspace starts at once and keeps no link option', async (t) => {
  const { store, queue, calls } = localQueue()
  const serve = createRouter({ queue })
  const base = await listen(t, (req, res) => serve(req, res))
  const out = await postTodo(base)
  assert.deepEqual([out.ok, out.state], [true, 'starting'])
  await queue.todoIdle()
  assertUntrusted(store.get(out.id))
  assert.equal(calls[0][0], 'create')
})

test('2 app proxy (local fallthrough): POST /v1/todo keeps no link option either', async (t) => {
  const { store, queue } = localQueue()
  const serve = createRouter({ queue })
  const proxy = createProxy({ queue, serve, hubUrl: () => undefined, secret: () => 'P'.repeat(43), instanceId: () => 'aaaa1111' })
  proxy.setMode('standalone', 'test')
  const base = await listen(t, (req, res) => proxy.handle(req, res))
  const out = await postTodo(base)
  assert.deepEqual([out.ok, out.state], [true, 'starting'])
  await queue.todoIdle()
  assertUntrusted(store.get(out.id))
})

test('3 hub HTTP: POST /v1/todo with a workspace sends todo-start without any link option', async (t) => {
  const { port, a, b } = await twoApps(t)
  const reply = (agent) => (cmd) => ({ ok: true, id: agent.itemId(9), state: cmd.kind === 'todo-start' ? 'starting' : 'awaiting-confirm' })
  const seenA = autopilot(t, a, reply(a))
  const seenB = autopilot(t, b, reply(b))
  const res = await act(port, 'todo', { text: 'Do the thing', workspaceId: 'bbbb/w1', ...OPTIONS }, { 'x-rq-instance': a.id })
  assert.deepEqual([res.status, res.json.state], [200, 'starting'])
  const sent = [...seenA, ...seenB]
  assert.deepEqual(sent.map((c) => c.kind), ['todo-start'])
  for (const key of LINK_KEYS) assert.equal(key in sent[0].args, false, key)
  assert.equal(sent[0].args.item, undefined)
})

test('4 app proxy in hub mode (real plugin wiring): POST /v1/todo starts at once and keeps no link option', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const registry = { list: () => [{ id: 'wa1', title: 'alpha', path: 'D:\\dev\\alpha', sessionIds: [] }], archivedSessionIds: [] }
  const prompted = []
  const sessionController = { create: async () => ({ sessionId: 'sess-1' }), rename: async () => ({}), prompt: async (request) => { prompted.push(request.sessionId); return {} } }
  const A = await startPlugin(t, world, { label: 'DSH :1', webPort: 14011, services: { workspaceRegistry: registry, sessionController } })
  await A.inState('hub')
  const list = await waitFor(async () => { const l = (await A.get('/v1/workspaces')).json.workspaces; return l.length === 1 && l }, 5000, 'workspaces')
  const res = await A.post('/v1/todo', { text: 'Do the thing', workspaceId: list[0].id, ...OPTIONS })
  assert.deepEqual([res.status, res.json.ok, res.json.error], [200, true, undefined])
  await waitFor(() => prompted.length === 1, 5000, 'the session was prompted')
  const card = await waitFor(async () => (await A.snapshot()).resolved.find((i) => i.type === 'todo' && i.state === 'started'), 5000, 'the todo started')
  assertUntrusted(card)
})

test('5 outcome: a trusted-path bad-source or bad-require-confirm is a 400, not a 409', () => {
  for (const error of ['bad-source', 'bad-require-confirm']) {
    const seen = {}
    outcome({ writeHead: (status) => { seen.status = status }, end: (text) => { seen.body = JSON.parse(text) } }, { ok: false, error })
    assert.deepEqual([seen.status, seen.body], [400, { ok: false, error }], error)
  }
})
