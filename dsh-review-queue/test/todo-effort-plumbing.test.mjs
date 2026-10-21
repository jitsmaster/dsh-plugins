import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { createExecutor } from '../agent/executor.js'
import { postJson } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

// The effort of a new todo travels like SPARC does: form -> POST /v1/todo -> hub (todo-start / todo-suggest) -> the app's addTodo.
// GET /v1/model-efforts answers the form's dropdown. The phone has the field too (todo-effort-phone.test.mjs).

test('GET /v1/model-efforts and POST /v1/todo with an effort, on the app server', async (t) => {
  const store = createStore({})
  const calls = []
  const controller = {
    create: async () => ({ sessionId: 'S1' }), rename: async () => {}, prompt: async () => ({}),
    modelCatalog: async () => ({ default: { provider: 'p', model: 'm' }, groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }] }], failures: [] }),
    selectModel: async (r) => { calls.push(r); return {} },
  }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, registryOf: () => ({ list: () => [{ id: 'w1', title: 'Alpha', path: 'D:/a', sessionIds: [] }] }), defaultModelOf: () => ({ saveSelection: async () => {} }) })
  const serve = createRouter({ queue })
  const server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const base = 'http://127.0.0.1:' + server.address().port
  const got = await fetch(base + '/v1/model-efforts')
  assert.equal(got.status, 200)
  assert.deepEqual(await got.json(), { ok: true, model: { provider: 'p', id: 'm', name: 'M' }, efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' })
  assert.equal((await fetch(base + '/v1/model-efforts', { method: 'POST', body: '{}' })).status, 405)
  const res = await fetch(base + '/v1/todo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', workspaceId: 'w1', effort: 'high' }) })
  assert.equal(res.status, 200)
  await queue.todoIdle()
  assert.deepEqual(calls, [{ sessionId: 'S1', provider: 'p', model: 'm', reasoningEffort: 'high' }])
  const bad = await fetch(base + '/v1/todo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', workspaceId: 'w1', effort: 5 }) })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'bad-effort')
})

test('the hub queue sends the effort to the hub with the todo, only when there is one', async () => {
  const hubCalls = []
  const local = { onChange: () => () => {}, uiState: () => undefined, addTodo: () => ({ ok: true }) }
  const client = { state: 'connected', mirror: { ready: true, snapshot: () => ({ snapshotId: 'e:1', open: [], resolved: [] }), workspaces: () => [], onChange: () => () => {} }, onState: () => () => {}, call: async (kind, body) => { hubCalls.push([kind, body]); return { ok: true } } }
  const queue = createHubQueue({ local, client, controllerOf: () => ({}), now: () => 5000 })
  await queue.addTodo('look', { workspaceId: 'aaaa/w1', effort: 'high' })
  await queue.addTodo('look', { workspaceId: 'aaaa/w1' })
  assert.deepEqual(hubCalls[0], ['todo', { text: 'look', workspaceId: 'aaaa/w1', effort: 'high' }])
  assert.equal('effort' in hubCalls[1][1], false)
})

const ws = (id, title, path) => ({ id, title, path })
async function viaAgent(agent, port, body, result, role) {
  const pending = postJson(port, P + '/v1/todo', body)
  const got = await agent.poll(0, 3000)
  const cmd = got.json.commands[0]
  if (cmd) await agent.result(cmd.cid, result)
  await pending
  return cmd
}
async function oneAgent(t, over) {
  const ctx = await startHub(t, over)
  const a = agentOf(ctx.port)
  await a.register({ sync: sync({ workspaces: [ws('w1', 'alpha', 'D:/a')] }) })
  await a.post('presence', { desktopActive: true })
  return { ...ctx, a }
}

test('the hub hands the effort to the owner app in todo-start and to the coordinator in todo-suggest', async (t) => {
  const { port, a } = await oneAgent(t)
  const start = await viaAgent(a, port, { text: 'look', workspaceId: 'aaaa/w1', effort: 'high' }, { ok: true })
  assert.equal(start.kind, 'todo-start')
  assert.equal(start.args.effort, 'high')
  const suggest = await viaAgent(a, port, { text: 'look', effort: 'low' }, { ok: true })
  assert.equal(suggest.kind, 'todo-suggest')
  assert.equal(suggest.args.effort, 'low')
  const none = await viaAgent(a, port, { text: 'look', workspaceId: 'aaaa/w1' }, { ok: true })
  assert.equal('effort' in none.args, false)
})

test('the executor passes the effort on to addTodo for todo-suggest and todo-start, only when there is one', async () => {
  const calls = []
  const executor = createExecutor({ queue: { addTodo: (text, opts) => { calls.push([text, opts]); return { ok: true } } }, adapter: {} })
  await executor.execute({ kind: 'todo-suggest', args: { text: 'a', workspaces: [], effort: 'high' } })
  await executor.execute({ kind: 'todo-start', args: { text: 'b', workspaceId: 'w1', effort: 'low' } })
  await executor.execute({ kind: 'todo-start', args: { text: 'c', workspaceId: 'w1' } })
  assert.equal(calls[0][1].effort, 'high')
  assert.equal(calls[1][1].effort, 'low')
  assert.equal('effort' in calls[2][1], false)
})

test('index.js gives the queue the default model service, so the default is restored after an effort is selected', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(src.includes("'agentDefaultModel'"))
  assert.match(src, /createReviewQueue\(\{ store, capture, controllerOf, defaultModelOf,/)
})
