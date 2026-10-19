import { test, before, after as afterAll } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { createExecutor } from '../agent/executor.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { postJson } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

// Review follow-up (payload): the phone asks for the newest page with `after` = the id of the newest message it shows; when the log has nothing
// newer the answer is { ok: true, unchanged: true } and no page is sent (docs/hub.md 6.8, docs/mobile.md "Chat thread").
const messages = [{ id: 3, role: 'user', text: 'hi', time: 5 }, { id: 4, role: 'assistant', text: 'hello' }]
const page = { ok: true, messages, hasMore: true, cursor: 3 }
function setup(read = async () => page) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const reads = []
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => undefined, threadOf: async (opts) => { reads.push(opts); return read(opts) } })
  const id = store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'x', payload: { reply: 'r', questions: [] } }).id
  return { queue, id, reads, store }
}
const answer = { ok: true, sessionId: 's1', title: 'One', messages, hasMore: true, cursor: 3 }

// ---- the service ---------------------------------------------------------------------------------------------------------------------------

test('thread with after = the newest message id answers unchanged and sends no messages', async () => {
  const { queue, id } = setup()
  assert.deepEqual(await queue.thread(id, { after: 4 }), { ok: true, unchanged: true })
})

test('thread with an older after (something newer exists) answers the normal page', async () => {
  const { queue, id } = setup()
  assert.deepEqual(await queue.thread(id, { after: 3 }), answer)
  assert.deepEqual(await queue.thread(id, { after: 0 }), answer)
})

test('after is for the newest page only: with a before cursor the page is answered whatever after says', async () => {
  const { queue, id } = setup()
  assert.deepEqual(await queue.thread(id, { before: 20, after: 4 }), answer)
})

test('an after that is not a number, or that is newer than anything in the log (the log was replaced), gets the page', async () => {
  const { queue, id } = setup()
  for (const bad of ['4', null, NaN, 4.5, -1, 99, {}]) assert.deepEqual(await queue.thread(id, { after: bad }), answer, String(bad))
})

test('an empty log is never unchanged', async () => {
  const { queue, id } = setup(async () => ({ ok: true, messages: [], hasMore: false }))
  assert.deepEqual(await queue.thread(id, { after: 0 }), { ok: true, sessionId: 's1', title: 'One', messages: [], hasMore: false })
})

test('after is not given to the log reader: the page is read as always and the service decides', async () => {
  const { queue, id, reads } = setup()
  await queue.thread(id, { after: 4, limit: 40 })
  assert.deepEqual(reads, [{ sessionId: 's1', before: undefined, limit: 40 }])
})

test('a failing read is still the error, whatever after is', async () => {
  const { queue, id } = setup(async () => ({ ok: false, error: 'no-log' }))
  assert.deepEqual(await queue.thread(id, { after: 4 }), { ok: false, error: 'no-log' })
})

// ---- the standalone server (the hub serves the same URL) ----------------------------------------------------------------------------------

let server, base, sid
before(async () => {
  const { queue, id } = setup()
  sid = id
  const serve = createRouter({ queue })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
})
afterAll(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
const post = (body) => fetch(base + '/v1/thread', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('POST /v1/thread {id, after} answers 200 { ok: true, unchanged: true } when nothing is newer', async () => {
  const res = await post({ id: sid, after: 4 })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, unchanged: true })
})

test('POST /v1/thread {id, after} with newer messages answers the page', async () => {
  const res = await post({ id: sid, after: 2, limit: 5 })
  assert.deepEqual(await res.json(), answer)
})

// ---- through the hub ------------------------------------------------------------------------------------------------------------------------

test('the hub hands after to the owner in the thread command and gives its unchanged answer back', async (t) => {
  const ctx = await startHub(t)
  const a = agentOf(ctx.port)
  await a.register({ sync: sync() })
  await a.send(a.add(1))
  const pending = postJson(ctx.port, P + '/v1/thread', { id: a.itemId(1), after: 7, limit: 40 })
  const cmd = (await a.poll(0, 3000)).json.commands[0]
  assert.deepEqual([cmd.kind, cmd.args], ['thread', { limit: 40, after: 7, sessionId: 's1' }])
  await a.result(cmd.cid, { ok: true, unchanged: true })
  const res = await pending
  assert.deepEqual([res.status, res.json], [200, { ok: true, unchanged: true }])
})

test('without after the command args are as before', async (t) => {
  const ctx = await startHub(t)
  const a = agentOf(ctx.port)
  await a.register({ sync: sync() })
  await a.send(a.add(1))
  const pending = postJson(ctx.port, P + '/v1/thread', { id: a.itemId(1) })
  const cmd = (await a.poll(0, 3000)).json.commands[0]
  assert.deepEqual(cmd.args, { sessionId: 's1' })
  await a.result(cmd.cid, { ok: true, unchanged: true })
  await pending
})

test('the executor passes after on to the local queue and answers unchanged as given', async () => {
  const calls = []
  const queue = { thread: async (id, opts) => { calls.push([id, opts]); return { ok: true, unchanged: true } } }
  const ex = createExecutor({ queue, adapter: {} })
  assert.deepEqual(await ex.execute({ cid: 'c1', kind: 'thread', itemId: 'i1', args: { limit: 40, after: 7 } }), { ok: true, unchanged: true })
  assert.deepEqual(calls, [['i1', { limit: 40, after: 7 }]])
})

test('in hub mode the app queue sends after to the hub only when it is given', async () => {
  const calls = []
  const local = { thread: async () => ({ ok: true, from: 'local' }), onChange: () => () => {}, uiState: () => ({}) }
  const client = { state: 'connected', mirror: { ready: true, snapshot: () => ({ snapshotId: 'e:1', open: [], resolved: [] }), workspaces: () => [], onChange: () => () => {} }, call: async (kind, body) => { calls.push([kind, body]); return { ok: true } }, onState: () => () => {} }
  const queue = createHubQueue({ local, client, now: () => 1 })
  await queue.thread('a', { limit: 40, after: 7 })
  await queue.thread('a', { limit: 40 })
  assert.deepEqual(calls, [['thread', { id: 'a', limit: 40, after: 7 }], ['thread', { id: 'a', limit: 40 }]])
})
