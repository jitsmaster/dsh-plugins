import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// queue.thread(id, { before, limit }) and queue.post(id, text): the chat view of the phone (docs/mobile.md "Chat thread").

function setup({ prompt, threadOf, log } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const prompts = []
  const reads = []
  const controller = { prompt: prompt ?? (async (req, signal) => { if (!(signal instanceof AbortSignal)) throw new TypeError('no signal'); prompts.push(req); return {} }) }
  const reader = threadOf ?? (async (opts) => { reads.push(opts); return { ok: true, messages: [{ id: 3, role: 'user', text: 'hi' }], hasMore: true, cursor: 3 } })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, threadOf: reader, ...(log ? { log } : {}) })
  const bare = createReviewQueue({ store, capture: {}, controllerOf: () => undefined })
  const nobody = createReviewQueue({ store, capture: {}, controllerOf: () => undefined, threadOf: reader })
  return { store, queue, bare, nobody, prompts, reads }
}
const item = (type, over = {}) => ({ type, sessionId: 's-' + type, sessionTitle: 'Title of ' + type, summary: 'x', payload: { reply: 'r', questions: [] }, ...over })

// ---- thread -----------------------------------------------------------------------------------------------------------------------

test('thread gives the messages of the item session with its title, for an open or a resolved item', async () => {
  const { store, queue, reads } = setup()
  const open = store.add(item('completed'))
  const done = store.add(item('completed', { sessionId: 's2', sessionTitle: 'Two' }))
  store.resolve(done.id, { kind: 'reviewed', by: 'card' })
  const expected = (sessionId, title) => ({ ok: true, sessionId, title, messages: [{ id: 3, role: 'user', text: 'hi' }], hasMore: true, cursor: 3 })
  assert.deepEqual(await queue.thread(open.id, { before: 20, limit: 10 }), expected('s-completed', 'Title of completed'))
  assert.deepEqual(await queue.thread(done.id), expected('s2', 'Two'))
  assert.deepEqual(reads, [{ sessionId: 's-completed', before: 20, limit: 10 }, { sessionId: 's2', before: undefined, limit: undefined }])
})

test('thread works for every item type that has a session, except a todo', async () => {
  const { store, queue } = setup()
  for (const type of ['question', 'permission', 'completed', 'pr-merged', 'paused']) {
    const r = await queue.thread(store.add(item(type)).id)
    assert.equal(r.ok, true, type)
  }
  assert.deepEqual(await queue.thread(store.add(item('todo')).id), { ok: false, error: 'no-session' })
})

test('thread refuses an unknown item and an item without a session', async () => {
  const { store, queue, reads } = setup()
  assert.deepEqual(await queue.thread('nope'), { ok: false, error: 'not-found' })
  const noSession = store.add(item('completed', { sessionId: undefined }))
  assert.deepEqual(await queue.thread(noSession.id), { ok: false, error: 'no-session' })
  const numeric = store.add(item('completed', { sessionId: 7 }))
  assert.deepEqual(await queue.thread(numeric.id), { ok: false, error: 'no-session' })
  assert.deepEqual(reads, [])
})

test('thread passes the error of the reader on, leaves out an absent cursor and has an empty title when the item has none', async () => {
  const failing = setup({ threadOf: async () => ({ ok: false, error: 'no-log' }) })
  assert.deepEqual(await failing.queue.thread(failing.store.add(item('completed')).id), { ok: false, error: 'no-log' })
  const empty = setup({ threadOf: async () => ({ ok: true, messages: [], hasMore: false }) })
  const id = empty.store.add(item('completed', { sessionTitle: undefined })).id
  assert.deepEqual(await empty.queue.thread(id), { ok: true, sessionId: 's-completed', title: '', messages: [], hasMore: false })
})

test('thread answers unreadable when the reader throws and no-reader when none is configured', async () => {
  const boom = setup({ threadOf: async () => { throw new Error('EIO') } })
  assert.deepEqual(await boom.queue.thread(boom.store.add(item('completed')).id), { ok: false, error: 'unreadable' })
  const { store, bare } = setup()
  assert.deepEqual(await bare.thread(store.add(item('completed')).id), { ok: false, error: 'no-reader' })
})

test('a reader that throws is logged by its error code only, never by its message', async () => {
  const lines = []
  const secret = 'sk-live-SECRET-token-1234 /home/someone/private.txt'
  const coded = setup({ log: (line) => lines.push(line), threadOf: async () => { throw Object.assign(new Error(secret), { code: 'EIO' }) } })
  assert.deepEqual(await coded.queue.thread(coded.store.add(item('completed')).id), { ok: false, error: 'unreadable' })
  const named = setup({ log: (line) => lines.push(line), threadOf: async () => { throw new RangeError(secret) } })
  assert.deepEqual(await named.queue.thread(named.store.add(item('completed')).id), { ok: false, error: 'unreadable' })
  assert.deepEqual(lines, ['thread: EIO', 'thread: RangeError'])
  assert.equal(lines.join('\n').includes('SECRET'), false)
})

// ---- post -------------------------------------------------------------------------------------------------------------------------

test('post queues the trimmed text as a prompt of the item session and resolves an open completed item as replied by the card', async () => {
  const { store, queue, prompts } = setup()
  const c = store.add(item('completed'))
  assert.deepEqual(await queue.post(c.id, '  and add tests  '), { ok: true })
  assert.equal(prompts.length, 1)
  assert.deepEqual([prompts[0].sessionId, prompts[0].mode, prompts[0].content], ['s-completed', 'queue', [{ type: 'text', text: 'and add tests' }]])
  assert.match(prompts[0].requestId, /^review-/)
  assert.deepEqual([store.get(c.id).status, store.get(c.id).resolution], ['resolved', { kind: 'replied', by: 'card' }])
})

test('post keeps the state of every other item: other types stay open, a resolved item keeps its resolution', async () => {
  const { store, queue, prompts } = setup()
  for (const type of ['question', 'permission', 'pr-merged']) {
    const i = store.add(item(type))
    assert.deepEqual(await queue.post(i.id, 'hello'), { ok: true }, type)
    assert.equal(store.get(i.id).status, 'open', type)
  }
  const done = store.add(item('completed', { sessionId: 's9' }))
  store.resolve(done.id, { kind: 'reviewed', by: 'card' })
  assert.deepEqual(await queue.post(done.id, 'one more thing'), { ok: true })
  assert.deepEqual(store.get(done.id).resolution, { kind: 'reviewed', by: 'card' })
  assert.equal(prompts.length, 4)
})

test('post refuses a paused item, open or resolved: resuming one is done at the PC, nothing is prompted and the item keeps its state', async () => {
  const { store, queue, prompts } = setup()
  const open = store.add(item('paused'))
  assert.deepEqual(await queue.post(open.id, 'hello'), { ok: false, error: 'paused' })
  assert.equal(store.get(open.id).status, 'open')
  const gone = store.add(item('paused', { sessionId: 's-paused-2' }))
  store.resolve(gone.id, { kind: 'dismissed', by: 'card' })
  assert.deepEqual(await queue.post(gone.id, 'hello'), { ok: false, error: 'paused' })
  assert.deepEqual(store.get(gone.id).resolution, { kind: 'dismissed', by: 'card' })
  assert.deepEqual(prompts, [])
})

test('the thread of a paused item is still readable', async () => {
  const { store, queue } = setup()
  assert.equal((await queue.thread(store.add(item('paused')).id)).ok, true)
})

test('post refuses a todo and an item without a session, and an unknown item', async () => {
  const { store, queue, prompts } = setup()
  assert.deepEqual(await queue.post('nope', 'hi'), { ok: false, error: 'not-found' })
  assert.deepEqual(await queue.post(store.add(item('todo')).id, 'hi'), { ok: false, error: 'not-a-session' })
  assert.deepEqual(await queue.post(store.add(item('completed', { sessionId: undefined })).id, 'hi'), { ok: false, error: 'not-a-session' })
  assert.deepEqual(prompts, [])
})

test('post refuses empty and over-long text with the limits of reply, and a missing controller', async () => {
  const { store, queue, nobody, prompts } = setup()
  const c = store.add(item('completed'))
  for (const text of ['', '   ', undefined, null, 42, {}]) assert.deepEqual(await queue.post(c.id, text), { ok: false, error: 'empty' }, JSON.stringify(text))
  assert.deepEqual(await queue.post(c.id, 'x'.repeat(4001)), { ok: false, error: 'too-long' })
  assert.deepEqual(await nobody.post(c.id, 'hi'), { ok: false, error: 'no-controller' })
  assert.equal(store.get(c.id).status, 'open')
  assert.deepEqual(prompts, [])
  assert.deepEqual(await queue.post(c.id, 'x'.repeat(4000)), { ok: true }, 'exactly 4000 is allowed')
})

test('a session the controller does not know is no-session, any other failure the fixed code post-failed; the item keeps its state', async () => {
  const unknown = setup({ prompt: async () => { throw Object.assign(new Error('x'), { code: 'session/not-found' }) } })
  const c = unknown.store.add(item('completed'))
  assert.deepEqual(await unknown.queue.post(c.id, 'hi'), { ok: false, error: 'no-session' })
  const closed = setup({ prompt: async () => { throw new Error('session closed') } })
  const d = closed.store.add(item('completed'))
  assert.deepEqual(await closed.queue.post(d.id, 'hi'), { ok: false, error: 'post-failed' })
  assert.deepEqual([unknown.store.get(c.id).status, closed.store.get(d.id).status], ['open', 'open'])
})

test('an item resolved while the prompt is on its way is not resolved twice', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { store, queue } = setup({ prompt: async () => { await gate; return {} } })
  const c = store.add(item('completed'))
  const pending = queue.post(c.id, 'hi')
  store.resolve(c.id, { kind: 'reviewed', by: 'card' })
  release()
  assert.deepEqual(await pending, { ok: true })
  assert.deepEqual(store.get(c.id).resolution, { kind: 'reviewed', by: 'card' })
})

// ---- thread of an item the local store does not hold (ownerless item read by the coordinator through the hub) -----------------------

test('thread of an item this store lacks reads the session id given with the command, with an empty title', async () => {
  const { queue, reads } = setup()
  assert.deepEqual(await queue.thread('not-here', { before: 20, limit: 10, sessionId: 's-remote' }), { ok: true, sessionId: 's-remote', title: '', messages: [{ id: 3, role: 'user', text: 'hi' }], hasMore: true, cursor: 3 })
  assert.deepEqual(reads, [{ sessionId: 's-remote', before: 20, limit: 10 }])
})

test('thread of an unknown item without a usable session id is still not-found and reads nothing', async () => {
  const { queue, reads } = setup()
  for (const sessionId of [undefined, '', 7, null, {}, ['s']]) assert.deepEqual(await queue.thread('not-here', { sessionId }), { ok: false, error: 'not-found' }, String(sessionId))
  assert.deepEqual(await queue.thread('not-here'), { ok: false, error: 'not-found' })
  assert.deepEqual(reads, [])
})

test('thread of a known item uses the session of the store, not the one given; a known todo is still refused', async () => {
  const { store, queue, reads } = setup()
  const known = store.add(item('completed'))
  assert.equal((await queue.thread(known.id, { sessionId: 'other' })).sessionId, 's-completed')
  assert.deepEqual(reads, [{ sessionId: 's-completed', before: undefined, limit: undefined }])
  const todo = store.add(item('todo'))
  assert.deepEqual(await queue.thread(todo.id, { sessionId: 's-remote' }), { ok: false, error: 'no-session' })
  assert.equal(reads.length, 1)
})

test('thread of an unknown item with no reader configured says no-reader', async () => {
  const { bare } = setup()
  assert.deepEqual(await bare.thread('not-here', { sessionId: 's-remote' }), { ok: false, error: 'no-reader' })
})

test('a controller error never reaches the phone as text: post and reply answer post-failed and log the code or name only', async () => {
  const lines = []
  const secret = 'sk-live-SECRET-token-1234 C:\\Users\\someone\\private.txt'
  const coded = setup({ log: (l) => lines.push(l), prompt: async () => { throw Object.assign(new Error(secret), { code: 'EPIPE' }) } })
  const named = setup({ log: (l) => lines.push(l), prompt: async () => { throw new RangeError(secret) } })
  const plain = setup({ log: (l) => lines.push(l), prompt: async () => { throw secret } })
  for (const s of [coded, named, plain]) {
    const c = s.store.add(item('completed'))
    assert.deepEqual(await s.queue.post(c.id, 'hi'), { ok: false, error: 'post-failed' })
    assert.deepEqual(await s.queue.reply(c.id, 'hi'), { ok: false, error: 'post-failed' }, 'reply shares the helper')
    assert.equal(s.store.get(c.id).status, 'open')
  }
  // Every post is traced (item, session, text length, outcome, duration) since "Logs every post to a session"; a failure names the code or name only.
  const outcomes = lines.map((l) => /^post: item \S+ session \S+ chars 2 failed: (\S+) after \d+ ms$/.exec(l)?.[1])
  assert.deepEqual(outcomes, ['EPIPE', 'EPIPE', 'RangeError', 'RangeError', 'error', 'error'])
  assert.equal(lines.join('\n').includes('SECRET'), false)
})

test('session/not-found answers no-session and the trace names only its code', async () => {
  const lines = []
  const s = setup({ log: (l) => lines.push(l), prompt: async () => { throw Object.assign(new Error('x'), { code: 'session/not-found' }) } })
  assert.deepEqual(await s.queue.post(s.store.add(item('completed')).id, 'hi'), { ok: false, error: 'no-session' })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^post: item \S+ session \S+ chars 2 failed: session\/not-found after \d+ ms$/)
})

test('thread of an unknown item reads a carried session id only when it is a valid one (the validator of thread.js): no path, no dot at the end', async () => {
  const { queue, reads } = setup()
  for (const sessionId of ['../etc', '..', '.', 'a/b', 'a\\b', 'a.', 'a ', '.hidden', 'x'.repeat(129)]) assert.deepEqual(await queue.thread('not-here', { sessionId }), { ok: false, error: 'not-found' }, sessionId)
  assert.deepEqual(reads, [])
  assert.equal((await queue.thread('not-here', { sessionId: 'abc-123_X' })).ok, true)
})

// ---- one post at a time per session ---------------------------------------------------------------------------------------

/** A prompt that stays open until released; every call is recorded. */
function gated() {
  const gate = { release: undefined, started: [] }
  const wait = new Promise((r) => { gate.release = r })
  gate.prompt = async (req) => { gate.started.push(req); await wait; return {} }
  return gate
}

test('a second post for the same open done item while the first is on its way answers busy and prompts nothing more', async () => {
  const gate = gated()
  const { store, queue } = setup({ prompt: gate.prompt })
  const c = store.add(item('completed'))
  const first = queue.post(c.id, 'one')
  assert.deepEqual(await queue.post(c.id, 'two'), { ok: false, error: 'busy' })
  assert.equal(gate.started.length, 1)
  gate.release()
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(store.get(c.id).resolution, { kind: 'replied', by: 'card' })
  assert.equal(gate.started.length, 1)
})

test('the in-flight mark is released when the prompt fails, so the next post goes through', async () => {
  let fail = true
  const sent = []
  const { store, queue } = setup({ prompt: async (req) => { if (fail) throw new Error('closed'); sent.push(req); return {} } })
  const c = store.add(item('completed'))
  assert.deepEqual(await queue.post(c.id, 'one'), { ok: false, error: 'post-failed' })
  fail = false
  assert.deepEqual(await queue.post(c.id, 'two'), { ok: true })
  assert.equal(sent.length, 1)
})

test('an empty text does not leave the item marked as busy', async () => {
  const { store, queue } = setup()
  const c = store.add(item('completed'))
  assert.deepEqual(await queue.post(c.id, ' '), { ok: false, error: 'empty' })
  assert.deepEqual(await queue.post(c.id, 'fine'), { ok: true })
})

test('a second post for the same session answers busy for every item type, open or resolved, and prompts nothing more', async () => {
  const gate = gated()
  const { store, queue } = setup({ prompt: gate.prompt })
  const q = store.add(item('question'))
  const done = store.add(item('completed', { sessionId: 's9' }))
  store.resolve(done.id, { kind: 'reviewed', by: 'card' })
  const posts = [queue.post(q.id, 'a'), queue.post(q.id, 'b'), queue.post(done.id, 'c'), queue.post(done.id, 'd')]
  assert.equal(gate.started.length, 2, 'one prompt per session')
  gate.release()
  assert.deepEqual(await Promise.all(posts), [{ ok: true }, { ok: false, error: 'busy' }, { ok: true }, { ok: false, error: 'busy' }])
  assert.equal(gate.started.length, 2)
  assert.equal(store.get(q.id).status, 'open', 'a question stays open')
})

test('two items of one session share the busy mark: it is per session id, not per item', async () => {
  const gate = gated()
  const { store, queue } = setup({ prompt: gate.prompt })
  const a = store.add(item('question', { sessionId: 'shared' }))
  const b = store.add(item('permission', { sessionId: 'shared' }))
  const first = queue.post(a.id, 'one')
  assert.deepEqual(await queue.post(b.id, 'two'), { ok: false, error: 'busy' })
  gate.release()
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(await queue.post(b.id, 'three'), { ok: true }, 'released once the first post is done')
})

test('the in-flight mark of another item type is released when its prompt fails', async () => {
  let fail = true
  const { store, queue } = setup({ prompt: async () => { if (fail) throw new Error('closed'); return {} } })
  const q = store.add(item('question'))
  assert.deepEqual(await queue.post(q.id, 'one'), { ok: false, error: 'post-failed' })
  fail = false
  assert.deepEqual(await queue.post(q.id, 'two'), { ok: true })
})

test('different open done items post at the same time; the busy mark is per session', async () => {
  const gate = gated()
  const { store, queue } = setup({ prompt: gate.prompt })
  const a = store.add(item('completed', { sessionId: 'sa' }))
  const b = store.add(item('completed', { sessionId: 'sb' }))
  const posts = [queue.post(a.id, 'a'), queue.post(b.id, 'b')]
  assert.equal(gate.started.length, 2)
  gate.release()
  assert.deepEqual(await Promise.all(posts), [{ ok: true }, { ok: true }])
})

test('an open done item resolved while its post is on its way is still busy: the session has a post in flight', async () => {
  const gate = gated()
  const { store, queue } = setup({ prompt: gate.prompt })
  const c = store.add(item('completed'))
  const first = queue.post(c.id, 'one')
  store.resolve(c.id, { kind: 'reviewed', by: 'card' })
  const second = queue.post(c.id, 'two')
  assert.equal(gate.started.length, 1)
  gate.release()
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: false, error: 'busy' }])
  assert.deepEqual(store.get(c.id).resolution, { kind: 'reviewed', by: 'card' })
})
