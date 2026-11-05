import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// A trusted caller (dsh-session-link) can ask for a new-session todo that waits for the user's confirm, and can mark where it came from.
const WORKSPACES = [
  { id: 'w1', title: 'Orca', path: 'D:/dev/ai/orca-engine', sessionIds: [] },
  { id: 'w2', title: 'dsh-plugins', path: 'D:/dev/ai/dsh-plugins', sessionIds: [] },
]
const SOURCE = { sessionId: 's1', title: 'T' }

function fakeLlm({ answer = '{"select":null}', seen = {} } = {}) {
  return {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'claude-haiku-x' }],
    prepareCall: async () => ({ config: {}, stream: async function* () { seen.calls = (seen.calls ?? 0) + 1; yield { type: 'text-delta', text: answer } } }),
  }
}

function setup({ llm, noRegistry, seen } = {}) {
  let n = 0
  let t = 1000
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const calls = []
  let sessions = 0
  const controller = {
    create: async (arg) => { calls.push(['create', arg]); return { sessionId: 'S' + ++sessions } },
    rename: async (arg) => { calls.push(['rename', arg]) },
    prompt: async (req, signal) => { calls.push(['prompt', req, signal]); return {} },
  }
  const registry = { list: () => WORKSPACES, archivedSessionIds: [] }
  const queue = createReviewQueue({
    store, capture: { decidePermission: () => ({ ok: false, error: 'not-pending' }) }, controllerOf: () => controller, registryOf: noRegistry ? () => undefined : () => registry,
    llm: llm ?? fakeLlm({ seen }), sparcText: () => 'SPARC', suggestTimeoutMs: 40, now: () => 5000,
  })
  return { store, queue, calls }
}
const names = (calls) => calls.map((c) => c[0])

test('requireConfirm with a workspace waits for the confirm: no session, no model call, source and suggestion stored', async () => {
  const seen = {}
  const { queue, store, calls } = setup({ seen })
  const r = queue.addTodo('task', { workspaceId: 'w1', requireConfirm: true, source: SOURCE })
  assert.equal(r.ok, true)
  assert.equal(r.state, 'awaiting-confirm')
  await queue.todoIdle()
  assert.deepEqual(names(calls), [])
  assert.equal(seen.calls, undefined)
  const item = store.get(r.id)
  assert.equal(item.state, 'awaiting-confirm')
  assert.equal(item.suggested.workspaceId, 'w1')
  assert.equal(item.suggested.title, 'Orca')
  assert.equal(item.suggested.reason, 'picked by the requesting session')
  assert.equal(item.source.sessionId, 's1')
  assert.ok(!item.suggesting)
})

test('without requireConfirm a given workspace starts at once, unchanged', async () => {
  const { queue, calls } = setup()
  const r = queue.addTodo('task', { workspaceId: 'w1' })
  assert.equal(r.state, 'starting')
  await queue.todoIdle()
  assert.deepEqual(names(calls), ['create', 'rename', 'prompt'])
})

test('requireConfirm: false starts at once too, and source rides along', async () => {
  const { queue, store, calls } = setup()
  const r = queue.addTodo('task', { workspaceId: 'w1', requireConfirm: false, source: SOURCE })
  assert.equal(r.state, 'starting')
  await queue.todoIdle()
  assert.deepEqual(names(calls), ['create', 'rename', 'prompt'])
  assert.equal(store.get(r.id).source.sessionId, 's1')
})

test('requireConfirm with an unknown workspace or no registry is refused', () => {
  assert.deepEqual(setup().queue.addTodo('task', { workspaceId: 'nope', requireConfirm: true }), { ok: false, error: 'unknown-workspace' })
  assert.deepEqual(setup({ noRegistry: true }).queue.addTodo('task', { workspaceId: 'w1', requireConfirm: true }), { ok: false, error: 'no-registry' })
})

test('requireConfirm without a workspace takes the suggestion path and keeps source; confirm then starts it', async () => {
  const seen = {}
  const { queue, store, calls } = setup({ llm: fakeLlm({ answer: '{"select":"w2","reason":"fits"}', seen }) })
  const r = queue.addTodo('some task', { requireConfirm: true, source: SOURCE })
  assert.equal(r.state, 'awaiting-confirm')
  assert.equal(store.get(r.id).suggesting, true)
  await queue.todoIdle()
  assert.equal(seen.calls, 1)
  const item = store.get(r.id)
  assert.equal(item.suggested.workspaceId, 'w2')
  assert.equal(item.source.sessionId, 's1')
  assert.deepEqual(names(calls), [])
  assert.deepEqual(queue.confirmTodo(r.id), { ok: true, state: 'starting' })
  await queue.todoIdle()
  assert.deepEqual(calls[0], ['create', { workspaceId: 'w2' }])
  assert.deepEqual(names(calls), ['create', 'rename', 'prompt'])
})

test('confirm after requireConfirm with a workspace creates the session there and resolves started', async () => {
  const { queue, store, calls } = setup()
  const r = queue.addTodo('task', { workspaceId: 'w1', requireConfirm: true, source: SOURCE })
  assert.equal(queue.confirmTodo(r.id).ok, true)
  await queue.todoIdle()
  assert.deepEqual(calls[0], ['create', { workspaceId: 'w1' }])
  assert.deepEqual(names(calls), ['create', 'rename', 'prompt'])
  const item = store.get(r.id)
  assert.equal(item.status, 'resolved')
  assert.equal(item.state, 'started')
  assert.equal(item.resolution.sessionId, 'S1')
  assert.equal(item.source.sessionId, 's1')
})

test('a bad source session id or a non-boolean requireConfirm is refused', () => {
  const { queue } = setup()
  assert.deepEqual(queue.addTodo('task', { workspaceId: 'w1', source: { sessionId: '../x', title: 'T' } }), { ok: false, error: 'bad-source' })
  assert.deepEqual(queue.addTodo('task', { workspaceId: 'w1', requireConfirm: 'yes' }), { ok: false, error: 'bad-require-confirm' })
})

test('sparc and effort are stored with requireConfirm and applied on confirm', async () => {
  const { queue, store, calls } = setup()
  const r = queue.addTodo('task', { workspaceId: 'w1', requireConfirm: true, sparc: true, effort: 'high' })
  const item = store.get(r.id)
  assert.equal(item.sparc, true)
  assert.equal(item.effort, 'high')
  queue.confirmTodo(r.id)
  await queue.todoIdle()
  // The fake controller has no modelCatalog, so applying the effort fails the start after create, like an effort todo elsewhere.
  assert.equal(calls[0][0], 'create')
  assert.match(store.get(r.id).error ?? '', /effort|not available/)
})

test('the service declares requireConfirm support, so dsh-session-link can refuse an older queue', () => {
  const { queue } = setup()
  assert.deepEqual(queue.supports, { requireConfirm: true })
})
