import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { postJson } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

// A STARTED follow-up todo (kind 'followup', state 'started', sessionId set) is an item with a session of its own, so the DESKTOP path (these callers
// have no role 'device') can still read and post to it like a done item; every other todo (awaiting confirmation, starting, failed, an ordinary started one)
// "has no session of its own yet" (thread: no-session, post: not-a-session). A paired PHONE gets no thread or post for a follow-up in any state: see
// hub-device-follow-up.test.mjs (the hub refuses it before the owner is asked). The service (service.js) cannot tell a phone from the desktop; the hub does.
const act = (port, kind, body) => postJson(port, P + '/v1/' + kind, body)
const SENT = { type: 'todo', kind: 'followup', text: 'run the tests', query: 'login', state: 'started', sessionId: 's2', sessionTitle: 'Docs' }

// ---- the hub ---------------------------------------------------------------------------------------------------------------------------------

test('hub (desktop caller): thread and post of a started follow-up reach the owner of the item (resolved or not)', async (t) => {
  const { port } = await startHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, SENT), { op: 'resolve', id: a.itemId(1), resolution: { kind: 'followed-up', by: 'card', sessionId: 's2' } })
  const pending = act(port, 'thread', { id: a.itemId(1) })
  const cmd = (await a.poll(0, 3000)).json.commands[0]
  assert.equal(cmd.kind, 'thread')
  assert.equal(cmd.args.sessionId, 's2')
  await a.result(cmd.cid, { ok: true, messages: [], hasMore: false })
  assert.equal((await pending).status, 200)
  const posting = act(port, 'post', { id: a.itemId(1), text: 'and the lint' })
  const post = (await a.poll(cmd.cid, 3000)).json.commands[0]
  assert.equal(post.kind, 'post')
  await a.result(post.cid, { ok: true })
  assert.deepEqual((await posting).json, { ok: true })
})

test('hub: an unsent follow-up and an ordinary started todo are still refused before the owner is asked', async (t) => {
  const { port } = await startHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  await a.send(
    a.add(1, { ...SENT, state: 'awaiting-confirm', sessionId: undefined }),
    a.add(2, { ...SENT, state: 'starting', sessionId: 's2' }),
    a.add(3, { ...SENT, state: 'failed', error: 'x', sessionId: 's2' }),
    a.add(4, { type: 'todo', text: 'fix it', state: 'started', sessionId: 's4' }),
    a.add(5, { ...SENT, sessionId: undefined }),
  )
  for (const n of [1, 2, 3, 4, 5]) {
    assert.deepEqual((await act(port, 'thread', { id: a.itemId(n) })).json, { ok: false, error: 'no-session' }, 'thread ' + n)
    assert.deepEqual((await act(port, 'post', { id: a.itemId(n), text: 'hello' })).json, { ok: false, error: 'not-a-session' }, 'post ' + n)
  }
  assert.deepEqual((await a.poll(0, 0)).json.commands, [], 'nothing was sent to the app')
})

// ---- the app (service.js) -------------------------------------------------------------------------------------------------------------------

function app() {
  const store = createStore()
  const reads = []
  const prompts = []
  const controller = { prompt: async (req) => { prompts.push(req); return {} } }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, threadOf: async (opts) => { reads.push(opts); return { ok: true, messages: [{ id: 1, role: 'user', text: 'hi' }], hasMore: false, cursor: 1 } } })
  return { store, queue, reads, prompts }
}

test('service: thread of a started follow-up reads the session it went to; post queues a prompt there and leaves the resolved item as it is', async () => {
  const { store, queue, reads, prompts } = app()
  const item = store.add({ ...SENT })
  store.resolve(item.id, { kind: 'followed-up', by: 'card', sessionId: 's2' })
  const read = await queue.thread(item.id)
  assert.equal(read.ok, true)
  assert.equal(read.sessionId, 's2')
  assert.equal(read.title, 'Docs')
  assert.deepEqual(reads.at(-1).sessionId, 's2')
  assert.deepEqual(await queue.post(item.id, 'and the lint'), { ok: true })
  assert.deepEqual([prompts.at(-1).sessionId, prompts.at(-1).content[0].text], ['s2', 'and the lint'])
  assert.equal(store.get(item.id).resolution.kind, 'followed-up')
  assert.equal(store.get(item.id).status, 'resolved')
})

test('service: every other todo is refused: thread no-session, post not-a-session, nothing read or prompted', async () => {
  const { store, queue, reads, prompts } = app()
  const others = [
    store.add({ ...SENT, state: 'awaiting-confirm', sessionId: undefined }),
    store.add({ ...SENT, state: 'starting', sessionId: 's2' }),
    store.add({ ...SENT, state: 'failed', error: 'x', sessionId: 's2' }),
    store.add({ type: 'todo', text: 'fix it', state: 'started', sessionId: 's4' }),
    store.add({ ...SENT, sessionId: undefined }),
  ]
  for (const item of others) {
    assert.deepEqual(await queue.thread(item.id), { ok: false, error: 'no-session' }, item.state)
    assert.deepEqual(await queue.post(item.id, 'x'), { ok: false, error: 'not-a-session' }, item.state)
  }
  assert.deepEqual([reads.length, prompts.length], [0, 0])
})
