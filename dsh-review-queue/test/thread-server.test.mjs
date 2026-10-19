import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'

// POST /v1/thread and /v1/post next to /v1/reply (standalone server.js; the hub serves the same URLs).

let server, base, store, reads, prompts, thread
before(async () => {
  let n = 0
  store = createStore({ uuid: () => 'i' + ++n })
  reads = []
  prompts = []
  thread = { ok: true, messages: [{ id: 2, role: 'user', text: 'hi' }], hasMore: false, cursor: 2 }
  const controller = { prompt: async (req) => { prompts.push(req); return {} } }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, threadOf: async (opts) => { reads.push(opts); return thread } })
  const serve = createRouter({ queue })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))

const post = (path, body, headers = { 'content-type': 'application/json' }) => fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
const item = (over = {}) => store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'Did X.', payload: { reply: 'r' }, ...over })

test('POST /v1/thread answers with the whole thread, the page cursor included', async () => {
  const c = item()
  const res = await post('/v1/thread', { id: c.id, before: 30, limit: 5 })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, sessionId: 's1', title: 'One', messages: [{ id: 2, role: 'user', text: 'hi' }], hasMore: false, cursor: 2 })
  assert.deepEqual(reads.at(-1), { sessionId: 's1', before: 30, limit: 5 })
})

test('a full page of long messages comes through the JSON answer unchanged', async () => {
  const messages = Array.from({ length: 40 }, (_, k) => ({ id: k + 1, role: k % 2 ? 'assistant' : 'user', text: 'é\n' + String(k).repeat(3990), time: 1000 + k }))
  thread = { ok: true, messages, hasMore: true, cursor: 1 }
  const res = await post('/v1/thread', { id: item({ sessionId: 'big' }).id })
  assert.deepEqual((await res.json()).messages, messages)
})

test('thread of an unknown item, of a todo and of an unreadable log are 409 with the reason', async () => {
  assert.deepEqual([(await post('/v1/thread', { id: 'nope' })).status, (await (await post('/v1/thread', { id: 'nope' })).json())], [409, { ok: false, error: 'not-found' }])
  const todo = store.add({ type: 'todo', text: 'x', state: 'starting' })
  assert.deepEqual(await (await post('/v1/thread', { id: todo.id })).json(), { ok: false, error: 'no-session' })
  thread = { ok: false, error: 'no-log' }
  const res = await post('/v1/thread', { id: item({ sessionId: 'gone' }).id })
  assert.deepEqual([res.status, await res.json()], [409, { ok: false, error: 'no-log' }])
})

test('POST /v1/post queues the prompt and resolves an open completed item as replied', async () => {
  const c = item({ sessionId: 'p1' })
  const res = await post('/v1/post', { id: c.id, text: 'next step please' })
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }])
  assert.deepEqual([prompts.at(-1).sessionId, prompts.at(-1).content[0].text], ['p1', 'next step please'])
  assert.deepEqual(store.get(c.id).resolution, { kind: 'replied', by: 'card' })
})

test('post of another item type keeps it open; a second post to the resolved item still goes through', async () => {
  const q = store.add({ type: 'question', sessionId: 'q1', payload: { questions: [] } })
  assert.equal((await post('/v1/post', { id: q.id, text: 'hi' })).status, 200)
  assert.equal(store.get(q.id).status, 'open')
  const c = item({ sessionId: 'p2' })
  await post('/v1/post', { id: c.id, text: 'one' })
  assert.equal((await post('/v1/post', { id: c.id, text: 'two' })).status, 200)
  assert.equal(prompts.at(-1).content[0].text, 'two')
})

test('POST /v1/post with a key: a repeat of an accepted key answers duplicate and prompts once', async () => {
  const c = item({ sessionId: 'p-key' })
  const before = prompts.length
  assert.deepEqual([(await post('/v1/post', { id: c.id, text: 'once', key: 'key-1' })).status, prompts.length - before], [200, 1])
  const again = await post('/v1/post', { id: c.id, text: 'once', key: 'key-1' })
  assert.deepEqual([again.status, await again.json(), prompts.length - before], [200, { ok: true, duplicate: true }, 1])
})

test('post: empty and too-long text are 400, an unknown item or a todo 409', async () => {
  const c = item({ sessionId: 'p3' })
  assert.deepEqual([(await post('/v1/post', { id: c.id, text: '  ' })).status, (await post('/v1/post', { id: c.id, text: 'y'.repeat(4001) })).status], [400, 400])
  assert.deepEqual([(await post('/v1/post', { id: 'nope', text: 'x' })).status, (await (await post('/v1/post', { id: 'nope', text: 'x' })).json())], [409, { ok: false, error: 'not-found' }])
  const todo = store.add({ type: 'todo', text: 'x', state: 'starting' })
  const res = await post('/v1/post', { id: todo.id, text: 'x' })
  assert.deepEqual([res.status, await res.json()], [409, { ok: false, error: 'not-a-session' }])
})

test('both routes need POST, JSON and a small body, like reply', async () => {
  for (const path of ['/v1/thread', '/v1/post']) {
    assert.equal((await fetch(base + path)).status, 405, path)
    assert.equal((await post(path, { id: 'x' }, { 'content-type': 'text/plain' })).status, 415, path)
    assert.equal((await post(path, '{nope')).status, 400, path)
    assert.equal((await post(path, { id: 'x', text: 'y'.repeat(100_000) })).status, 413, path)
  }
})

test('POST /v1/thread ignores a sessionId in the body: an unknown item stays not-found and nothing is read', async () => {
  const before = reads.length
  const res = await post('/v1/thread', { id: 'nope', sessionId: 's1' })
  assert.deepEqual([res.status, await res.json()], [409, { ok: false, error: 'not-found' }])
  assert.equal(reads.length, before)
})

test('POST /v1/thread ignores a sessionId in the body for a known item as well', async () => {
  thread = { ok: true, messages: [], hasMore: false }
  const c = item({ sessionId: 'mine' })
  const res = await post('/v1/thread', { id: c.id, sessionId: 'someone-elses' })
  assert.equal((await res.json()).sessionId, 'mine')
  assert.equal(reads.at(-1).sessionId, 'mine')
})
