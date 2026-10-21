import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'

// The follow-up routes: POST /v1/todo { followUp } and POST /v1/todo-confirm { sessionId }.
let server, base, store, queue, prompts, listCalls
before(async () => {
  let n = 0
  store = createStore({ uuid: () => 'i' + ++n })
  prompts = []
  listCalls = 0
  const controller = {
    list: async () => { listCalls++; return { items: [{ sessionId: 's1', updatedAt: 20, running: true, blank: false }, { sessionId: 's2', updatedAt: 10, running: false, blank: false }, { sessionId: 'sub', updatedAt: 30, origin: 'subagent' }] } },
    prompt: async (req) => { if (req.sessionId === 'unknown-to-controller') throw Object.assign(new Error('not found'), { code: 'session/not-found' }); prompts.push(req); return {} },
    create: async () => ({ sessionId: 'NEW' }),
    rename: async () => {},
  }
  const registry = { list: () => [{ id: 'w1', title: 'Alpha', path: 'D:/a/alpha', sessionIds: ['s1'] }], archivedSessionIds: [] }
  const titlesOf = async (ids) => new Map(ids.map((id) => [id, id === 's1' ? 'Login redirect fix' : 'Docs cleanup']))
  queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, registryOf: () => registry, titlesOf })
  const serve = createRouter({ queue, dev: undefined })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const code = async (path, body) => { const r = await post(path, body); return [r.status, (await r.json()).error] }

test('there is no GET /v1/followup-sessions: an unknown action (404), whatever the method', async () => {
  const res = await fetch(base + '/v1/followup-sessions')
  assert.deepEqual([res.status, await res.json()], [404, { error: 'unknown-action' }])
  assert.equal((await post('/v1/followup-sessions', {})).status, 404)
})

test('POST /v1/todo with followUp makes a waiting follow-up card and sends nothing; confirm with a sessionId sends the one prompt', async () => {
  const res = await post('/v1/todo', { text: 'Also add a test', followUp: 'the docs one' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual([body.ok, body.state], [true, 'awaiting-confirm'])
  await queue.todoIdle()
  const item = store.get(body.id)
  assert.equal(item.kind, 'followup')
  assert.equal(item.query, 'the docs one')
  assert.deepEqual(prompts, [])
  const ok = await post('/v1/todo-confirm', { id: body.id, sessionId: 's2' })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true, state: 'starting' })
  await queue.todoIdle()
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 's2')
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: 'Also add a test' }])
  assert.equal(store.get(body.id).state, 'started')
})

test('a sessions array in the request body is ignored: only this app\'s own list is a candidate', async () => {
  const { id } = await (await post('/v1/todo', { text: 'x', followUp: 'anything', sessions: [{ sessionId: 'injected', title: 'Injected' }] })).json()
  await queue.todoIdle()
  assert.deepEqual(store.get(id).candidates.map((c) => c.sessionId), ['s1', 's2'])
  assert.deepEqual(await code('/v1/todo-confirm', { id, sessionId: 'injected' }), [400, 'unknown-session'])
  await post('/v1/todo-cancel', { id })
})

test('new errors map to 400: empty-query, too-long, no-session (confirm), unknown-session', async () => {
  assert.deepEqual(await code('/v1/todo', { text: 'x', followUp: '   ' }), [400, 'empty-query'])
  assert.deepEqual(await code('/v1/todo', { text: 'x', followUp: 7 }), [400, 'empty-query'])
  assert.deepEqual(await code('/v1/todo', { text: 'x', followUp: 'y'.repeat(301) }), [400, 'too-long'])
  assert.deepEqual(await code('/v1/todo', { text: ' ', followUp: 'the docs one' }), [400, 'empty'])
  const { id } = await (await post('/v1/todo', { text: 'x', followUp: 'something vague' })).json()
  await queue.todoIdle()
  assert.deepEqual(await code('/v1/todo-confirm', { id }), [400, 'no-session'])
  assert.deepEqual(await code('/v1/todo-confirm', { id, sessionId: 'ghost' }), [400, 'unknown-session'])
  assert.deepEqual(await code('/v1/todo-confirm', { id, sessionId: 7 }), [400, 'unknown-session'], 'the id is a string, so a number never matches')
  assert.deepEqual(await code('/v1/todo-confirm', { id: 'nope', sessionId: 's1' }), [409, 'not-open'])
  assert.equal(store.get(id).state, 'awaiting-confirm')
})

test('confirm of a model pick of a running session without a sessionId is a 400 no-session and sends nothing', async () => {
  const item = store.add({ type: 'todo', kind: 'followup', text: 'x', query: 'q', state: 'awaiting-confirm', candidates: [{ sessionId: 's1', title: 'Login redirect fix', running: true }], suggested: { sessionId: 's1', title: 'Login redirect fix', reason: 'looks right', running: true } })
  const before = prompts.length
  assert.deepEqual(await code('/v1/todo-confirm', { id: item.id }), [400, 'no-session'])
  assert.equal(prompts.length, before)
  assert.equal(store.get(item.id).state, 'awaiting-confirm')
  assert.equal((await post('/v1/todo-confirm', { id: item.id, sessionId: 's1' })).status, 200, 'the same session named in the body is sent')
  await queue.todoIdle()
})

test('no-session stays a 409 for the other routes (a reply to a session this app does not know)', async () => {
  const item = store.add({ type: 'completed', sessionId: 'unknown-to-controller', title: 'x', summary: 's' })
  assert.deepEqual(await code('/v1/reply', { id: item.id, text: 'hello' }), [409, 'no-session'])
})

test('a workspace todo is unchanged through the same route', async () => {
  const body = await (await post('/v1/todo', { text: 'plain', workspaceId: 'w1' })).json()
  assert.equal(body.state, 'starting')
  await queue.todoIdle()
  assert.equal(store.get(body.id).kind, undefined)
  assert.equal(listCalls > 0, true)
})
