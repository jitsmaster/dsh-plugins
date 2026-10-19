import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createExecutor } from '../agent/executor.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { postKeyOf } from '../post-key.js'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'
import { postJson } from './hub-helpers.mjs'

// The idempotency key of a phone post (docs/hub.md 6.8): the phone sends one key per composed message, a retry of the same message reuses it,
// and the service answers a repeat of an ACCEPTED key with { ok: true, duplicate: true } without prompting the session again.

function setup({ prompt, now } = {}) {
  let n = 0
  let clock = 1_000_000
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const prompts = []
  const controller = { prompt: prompt ?? (async (req) => { prompts.push(req); return {} }) }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, now: now ?? (() => clock) })
  return { store, queue, prompts, tick: (ms) => { clock += ms } }
}
const done = (store, over = {}) => store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'T', summary: 'x', payload: { reply: 'r' }, ...over })

// ---- the key validator ---------------------------------------------------------------------------------------------------------------

test('postKeyOf accepts a string of 1 to 64 characters of letters, digits, underscore and dash, and ignores anything else', () => {
  for (const ok of ['a', 'abc-123_XYZ', crypto.randomUUID(), 'k'.repeat(64)]) assert.equal(postKeyOf(ok), ok, ok)
  for (const bad of ['', 'k'.repeat(65), 'a b', 'a/b', 'a.b', 'a\n', 'é', 7, null, undefined, {}, ['k']]) assert.equal(postKeyOf(bad), undefined, JSON.stringify(bad))
})

// ---- the service ---------------------------------------------------------------------------------------------------------------------

test('a repeat of an accepted key answers duplicate and prompts the session only once', async () => {
  const { store, queue, prompts } = setup()
  const c = done(store)
  assert.deepEqual(await queue.post(c.id, 'go on', { key: 'k1' }), { ok: true })
  assert.deepEqual(await queue.post(c.id, 'go on', { key: 'k1' }), { ok: true, duplicate: true })
  assert.equal(prompts.length, 1)
})

test('a duplicate also answers after the item was resolved by the first post, and for another item type', async () => {
  const { store, queue, prompts } = setup()
  const c = done(store)
  const q = store.add({ type: 'question', sessionId: 'sq', payload: { questions: [] } })
  await queue.post(c.id, 'a', { key: 'kc' })
  await queue.post(q.id, 'b', { key: 'kq' })
  assert.equal(store.get(c.id).status, 'resolved')
  assert.deepEqual(await queue.post(c.id, 'a', { key: 'kc' }), { ok: true, duplicate: true })
  assert.deepEqual(await queue.post(q.id, 'b', { key: 'kq' }), { ok: true, duplicate: true })
  assert.equal(prompts.length, 2)
})

test('a failed attempt is not remembered: the retry with the same key prompts again', async () => {
  let fail = true
  const sent = []
  const { store, queue } = setup({ prompt: async (req) => { if (fail) throw new Error('closed'); sent.push(req); return {} } })
  const c = done(store)
  assert.deepEqual(await queue.post(c.id, 'go on', { key: 'k1' }), { ok: false, error: 'post-failed' })
  fail = false
  assert.deepEqual(await queue.post(c.id, 'go on', { key: 'k1' }), { ok: true })
  assert.equal(sent.length, 1)
})

test('refused posts (empty text, paused, unknown item, no session) leave nothing behind for their key', async () => {
  const { store, queue, prompts } = setup()
  const c = done(store)
  assert.deepEqual(await queue.post(c.id, '  ', { key: 'k1' }), { ok: false, error: 'empty' })
  assert.deepEqual(await queue.post('nope', 'x', { key: 'k1' }), { ok: false, error: 'not-found' })
  assert.deepEqual(await queue.post(done(store, { type: 'paused', sessionId: 'sp' }).id, 'x', { key: 'k1' }), { ok: false, error: 'paused' })
  assert.deepEqual(await queue.post(c.id, 'real', { key: 'k1' }), { ok: true })
  assert.equal(prompts.length, 1)
})

test('different keys, a missing key and an invalid key are never treated as duplicates', async () => {
  const { store, queue, prompts } = setup()
  const c = done(store)
  await queue.post(c.id, 'one', { key: 'k1' })
  await queue.post(c.id, 'two', { key: 'k2' })
  await queue.post(c.id, 'three')
  await queue.post(c.id, 'four', {})
  const bad = 'x'.repeat(65)
  await queue.post(c.id, 'five', { key: bad })
  assert.deepEqual(await queue.post(c.id, 'five again', { key: bad }), { ok: true }, 'an invalid key is ignored, so nothing is remembered')
  assert.deepEqual(await queue.post(c.id, 'six', { key: 42 }), { ok: true })
  assert.equal(prompts.length, 7)
})

test('a repeat while the first attempt is still on its way is busy, not a duplicate: only an accepted attempt is remembered', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const sent = []
  const { store, queue } = setup({ prompt: async (req) => { sent.push(req); await gate; return {} } })
  const c = done(store)
  const first = queue.post(c.id, 'go on', { key: 'k1' })
  assert.deepEqual(await queue.post(c.id, 'go on', { key: 'k1' }), { ok: false, error: 'busy' })
  release()
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(await queue.post(c.id, 'go on', { key: 'k1' }), { ok: true, duplicate: true })
  assert.equal(sent.length, 1)
})

test('a key is remembered for 10 minutes', async () => {
  const { store, queue, prompts, tick } = setup()
  const c = done(store)
  await queue.post(c.id, 'a', { key: 'k1' })
  tick(10 * 60_000 - 1)
  assert.deepEqual(await queue.post(c.id, 'a', { key: 'k1' }), { ok: true, duplicate: true })
  tick(2)
  assert.deepEqual(await queue.post(c.id, 'a', { key: 'k1' }), { ok: true }, 'forgotten after ten minutes')
  assert.equal(prompts.length, 2)
})

test('at most 200 keys are remembered: the oldest is forgotten first', async () => {
  const { store, queue, prompts } = setup()
  const c = done(store)
  for (let i = 0; i < 201; i++) assert.deepEqual(await queue.post(c.id, 'm' + i, { key: 'k' + i }), { ok: true })
  assert.equal(prompts.length, 201)
  assert.deepEqual(await queue.post(c.id, 'm200', { key: 'k200' }), { ok: true, duplicate: true }, 'the newest is kept')
  assert.deepEqual(await queue.post(c.id, 'm1', { key: 'k1' }), { ok: true, duplicate: true }, 'the 200th newest is kept')
  assert.deepEqual(await queue.post(c.id, 'm0', { key: 'k0' }), { ok: true }, 'the oldest was dropped')
  assert.equal(prompts.length, 202)
})

// ---- the transport: server -> hub routing -> executor -> service ----------------------------------------------------------------------

test('the executor passes the key of a post command to the service', async () => {
  const calls = []
  const ex = createExecutor({ queue: { post: async (id, text, opts) => { calls.push([id, text, opts]); return { ok: true } } }, adapter: {} })
  await ex.execute({ cid: 'c1', kind: 'post', itemId: 'i1', args: { text: 'go', key: 'k1' } })
  await ex.execute({ cid: 'c2', kind: 'post', itemId: 'i1', args: { text: 'go' } })
  assert.deepEqual(calls, [['i1', 'go', { key: 'k1' }], ['i1', 'go', { key: undefined }]])
})

test('in hub mode the key goes to the hub with the post, and only when one was given', async () => {
  const calls = []
  const local = { snapshot: async () => ({}), thread: async () => ({}), post: async () => ({ ok: true }), onChange: () => () => {}, uiState: () => ({}) }
  const client = { state: 'connected', mirror: { ready: true, snapshot: () => ({ snapshotId: 'e:1', open: [], resolved: [] }), workspaces: () => [], onChange: () => () => {} }, call: async (kind, body) => { calls.push([kind, body]); return { ok: true } }, onState: () => () => {} }
  const queue = createHubQueue({ local, client, now: () => 1 })
  await queue.post('a', 'hi', { key: 'k1' })
  await queue.post('a', 'hi')
  assert.deepEqual(calls, [['post', { id: 'a', text: 'hi', key: 'k1' }], ['post', { id: 'a', text: 'hi' }]])
})

test('the hub routing hands a valid key to the owner and drops an invalid one', async (t) => {
  const ctx = await startHub(t)
  const a = agentOf(ctx.port)
  await a.register({ sync: sync() })
  await a.send(a.add(1))
  const viaAgent = async (body) => {
    const pending = postJson(ctx.port, P + '/v1/post', body)
    const cmd = (await a.poll(0, 3000)).json.commands[0]
    await a.result(cmd.cid, { ok: true })
    await pending
    return cmd.args
  }
  assert.deepEqual(await viaAgent({ id: a.itemId(1), text: 'hi', key: 'abc-123_XYZ' }), { text: 'hi', key: 'abc-123_XYZ' })
  assert.deepEqual(await viaAgent({ id: a.itemId(1), text: 'hi', key: 'x'.repeat(65) }), { text: 'hi' })
  assert.deepEqual(await viaAgent({ id: a.itemId(1), text: 'hi', key: 'bad key!' }), { text: 'hi' })
  assert.deepEqual(await viaAgent({ id: a.itemId(1), text: 'hi', key: 5 }), { text: 'hi' })
  assert.deepEqual(await viaAgent({ id: a.itemId(1), text: 'hi' }), { text: 'hi' })
})
