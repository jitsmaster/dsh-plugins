import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'

// The todo routes: POST /v1/todo, /v1/todo-confirm, /v1/todo-cancel and GET /v1/workspaces.
let server, base, store, queue, calls
before(async () => {
  let n = 0
  store = createStore({ uuid: () => 'i' + ++n })
  calls = []
  let sessions = 0
  const controller = {
    create: async (arg) => { calls.push(['create', arg]); return { sessionId: 'S' + ++sessions } },
    rename: async (arg) => { calls.push(['rename', arg]) },
    prompt: async (req) => { calls.push(['prompt', req]); return {} },
  }
  const registry = { list: () => [{ id: 'w1', title: 'Alpha', path: 'D:/a/alpha', sessionIds: [] }, { id: 'w2', title: 'Beta', path: 'D:/a/beta', sessionIds: [] }] }
  queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, registryOf: () => registry })
  const serve = createRouter({ queue, dev: undefined })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('POST /v1/todo with a workspace answers at once and starts the session in the background', async () => {
  const res = await post('/v1/todo', { text: 'Do the thing', workspaceId: 'w1' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.state, 'starting')
  await queue.todoIdle()
  assert.deepEqual(calls.map((c) => c[0]), ['create', 'rename', 'prompt'])
  assert.equal(store.get(body.id).state, 'started')
})

test('POST /v1/todo without a workspace waits for a confirmation; POST /v1/todo-confirm starts it, with a workspace override', async () => {
  calls.length = 0
  const body = await (await post('/v1/todo', { text: 'Something for Beta', sparc: false })).json()
  assert.equal(body.state, 'awaiting-confirm')
  await queue.todoIdle()
  assert.equal(store.get(body.id).suggested.workspaceId, 'w2')
  assert.deepEqual(calls, [])
  const ok = await post('/v1/todo-confirm', { id: body.id, workspaceId: 'w1' })
  assert.equal(ok.status, 200)
  await queue.todoIdle()
  assert.deepEqual(calls[0], ['create', { workspaceId: 'w1' }])
})

test('POST /v1/todo-cancel cancels; a second one is a 409 not-open', async () => {
  calls.length = 0
  const { id } = await (await post('/v1/todo', { text: 'Nobody named here' })).json()
  await queue.todoIdle()
  assert.equal((await post('/v1/todo-cancel', { id })).status, 200)
  const again = await post('/v1/todo-cancel', { id })
  assert.equal(again.status, 409)
  assert.deepEqual(await again.json(), { ok: false, error: 'not-open' })
  assert.deepEqual(calls, [])
})

test('bad input is a 400: empty, too long, unknown workspace, nothing to start in; the rest a 409', async () => {
  const code = async (path, body) => { const r = await post(path, body); return [r.status, (await r.json()).error] }
  assert.deepEqual(await code('/v1/todo', { text: '  ' }), [400, 'empty'])
  assert.deepEqual(await code('/v1/todo', {}), [400, 'empty'])
  assert.deepEqual(await code('/v1/todo', { text: 'x'.repeat(4001) }), [400, 'too-long'])
  assert.deepEqual(await code('/v1/todo', { text: 'ok', workspaceId: 'nope' }), [400, 'unknown-workspace'])
  const { id } = await (await post('/v1/todo', { text: 'Nobody named here either' })).json()
  await queue.todoIdle()
  assert.deepEqual(await code('/v1/todo-confirm', { id }), [400, 'no-workspace'])
  assert.deepEqual(await code('/v1/todo-confirm', { id, workspaceId: 'nope' }), [400, 'unknown-workspace'])
  assert.deepEqual(await code('/v1/todo-confirm', { id: 'ghost' }), [409, 'not-open'])
  assert.equal(store.get(id).state, 'awaiting-confirm')
})

test('the sparc flag is a strict boolean; GET /v1/workspaces lists id and title; wrong methods are 405', async () => {
  calls.length = 0
  await post('/v1/todo', { text: 'Plain', workspaceId: 'w1', sparc: 'yes' })
  await queue.todoIdle()
  assert.equal(calls.find((c) => c[0] === 'prompt')[1].content[0].text, 'Plain', 'only true turns SPARC on')
  const res = await fetch(base + '/v1/workspaces')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { workspaces: [{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }] })
  assert.equal((await fetch(base + '/v1/todo')).status, 405)
  assert.equal((await post('/v1/workspaces', {})).status, 405)
})

test('the snapshot shows a todo and a state change wakes the long poll', async () => {
  const snap = await (await fetch(base + '/v1/snapshot')).json()
  const stamp = snap.snapshotId + '|' + (snap.focusId ?? '') + '|' + (snap.reading ?? '') + '|' + (snap.ui?.seq ?? 0)
  const pending = fetch(base + '/v1/snapshot?wait=5000&since=' + encodeURIComponent(stamp)).then((r) => r.json())
  await new Promise((r) => setTimeout(r, 30))
  await post('/v1/todo', { text: 'Wake up call' })
  const woke = await pending
  assert.equal(woke.unchanged, undefined)
  assert.ok(woke.open.some((i) => i.type === 'todo' && i.text === 'Wake up call'))
})
