import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExecutor } from '../agent/executor.js'

function make({ openSession, results = {} } = {}) {
  const calls = []
  const rec = (name) => (...args) => { calls.push([name, ...args]); return results[name] ?? { ok: true, from: name } }
  const queue = {
    answer: rec('answer'), lateAnswer: async (...a) => rec('lateAnswer')(...a), approve: rec('approve'), approveSimilar: rec('approveSimilar'), deny: rec('deny'),
    reply: async (...a) => rec('reply')(...a), archive: async (...a) => rec('archive')(...a), addTodo: rec('addTodo'), confirmTodo: rec('confirmTodo'), cancelTodo: rec('cancelTodo'),
  }
  const adapter = { adopt: rec('adopt'), applyRemote: rec('applyRemote') }
  const executor = createExecutor({ queue, adapter, ...(openSession === undefined ? {} : { openSession }) })
  return { executor, calls }
}
let n = 0
const cmd = (kind, itemId, args = {}) => ({ cid: 'c' + ++n, seq: n, kind, itemId, args })

test('every command runs its service call and answers with what that returns', async () => {
  const { executor, calls } = make({ openSession: async (id) => ({ ok: true, opened: id }) })
  const answers = [{ id: 'q', selected: ['a'] }]
  const table = [
    [cmd('answer', 'i1', { answers }), { ok: true, from: 'answer' }, ['answer', 'i1', answers]],
    [cmd('late-answer', 'i1', { answers }), { ok: true, from: 'lateAnswer' }, ['lateAnswer', 'i1', answers]],
    [cmd('approve', 'i2', { via: 'phone', confirmed: true, held: false }), { ok: true, from: 'approve' }, ['approve', 'i2', { via: 'phone', confirmed: true, held: false }]],
    [cmd('approve-similar', 'i2', { via: 'phone', confirmed: true }), { ok: true, from: 'approveSimilar' }, ['approveSimilar', 'i2', { via: 'phone', confirmed: true }]],
    [cmd('deny', 'i2'), { ok: true, from: 'deny' }, ['deny', 'i2']],
    [cmd('reply', 'i3', { text: 'go' }), { ok: true, from: 'reply' }, ['reply', 'i3', 'go']],
    [cmd('archive', 'i4'), { ok: true, from: 'archive' }, ['archive', 'i4']],
    [cmd('todo-cancel', 'i5'), { ok: true, from: 'cancelTodo' }, ['cancelTodo', 'i5']],
    [cmd('open-session', 'i3', { sessionId: 's3' }), { ok: true, opened: 's3' }, undefined],
    [cmd('apply', 'i6', { change: { op: 'drop', id: 'i6' } }), { ok: true, from: 'applyRemote' }, ['applyRemote', { op: 'drop', id: 'i6' }]],
  ]
  for (const [command, expected, call] of table) {
    assert.deepEqual(await executor.execute(command), expected, command.kind)
    if (call) assert.deepEqual(calls.at(-1), call, command.kind)
  }
})

test('todo-suggest adds a todo with the union list; todo-start with a workspace adds one there; with an item it adopts then confirms', async () => {
  const { executor, calls } = make()
  const workspaces = [{ id: 'aaaa/w1', title: 'alpha' }]
  await executor.execute(cmd('todo-suggest', undefined, { text: 'fix', sparc: true, workspaces }))
  assert.deepEqual(calls.at(-1), ['addTodo', 'fix', { sparc: true, workspaces }])
  await executor.execute(cmd('todo-start', undefined, { text: 'fix', sparc: false, workspaceId: 'w1' }))
  assert.deepEqual(calls.at(-1), ['addTodo', 'fix', { workspaceId: 'w1', sparc: false }])
  await executor.execute(cmd('todo-start', 'i7', { workspaceId: 'w1' }))
  assert.deepEqual(calls.at(-1), ['confirmTodo', 'i7', { workspaceId: 'w1' }])
  const moved = { id: 'bbbb-000000000009', type: 'todo', text: 'x' }
  const result = await executor.execute(cmd('todo-start', moved.id, { workspaceId: 'w1', item: moved }))
  assert.deepEqual(calls.slice(-2), [['adopt', moved], ['confirmTodo', moved.id, { workspaceId: 'w1' }]])
  assert.equal(result.from, 'confirmTodo')
})

test('an unknown command, a missing opener and a throwing call are answered as refusals, never thrown', async () => {
  const bare = make()
  assert.deepEqual(await bare.executor.execute(cmd('explode', 'i1')), { ok: false, error: 'unknown-command' })
  assert.deepEqual(await bare.executor.execute(cmd('open-session', 'i1', { sessionId: 's' })), { ok: false, error: 'no-controller' })
  const boom = createExecutor({ queue: { deny: () => { throw new Error('kaboom') } }, adapter: {} })
  assert.deepEqual(await boom.execute(cmd('deny', 'i1')), { ok: false, error: 'kaboom' })
  const odd = createExecutor({ queue: { deny: () => undefined }, adapter: {} })
  assert.deepEqual(await odd.execute(cmd('deny', 'i1')), { ok: false, error: 'failed' })
})

test('a cid that was answered is answered again from the cache, also when both arrive together', async () => {
  const { executor, calls } = make()
  const c = cmd('approve', 'i1', { via: 'desktop' })
  const [first, second] = await Promise.all([executor.execute(c), executor.execute(c)])
  const third = await executor.execute({ ...c })
  assert.deepEqual([second, third], [first, first])
  assert.equal(calls.filter((x) => x[0] === 'approve').length, 1)
})

test('only the last 200 results are kept', async () => {
  const { executor, calls } = make()
  const first = cmd('deny', 'i1')
  await executor.execute(first)
  for (let i = 0; i < 200; i++) await executor.execute(cmd('deny', 'loop' + i))
  await executor.execute(first)
  assert.equal(calls.filter((x) => x[0] === 'deny' && x[1] === 'i1').length, 2)
  const recent = cmd('deny', 'recent')
  await executor.execute(recent)
  await executor.execute(recent)
  assert.equal(calls.filter((x) => x[1] === 'recent').length, 1)
})

test('commands run one at a time, in the order they were given', async () => {
  const order = []
  let release
  const gate = new Promise((r) => { release = r })
  const executor = createExecutor({ queue: { reply: async (id) => { order.push('start ' + id); await gate; order.push('end ' + id); return { ok: true } }, deny: (id) => { order.push('deny ' + id); return { ok: true } } }, adapter: {} })
  const slow = executor.execute(cmd('reply', 'a', { text: 'x' }))
  const quick = executor.execute(cmd('deny', 'b'))
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(order, ['start a'])
  release()
  await Promise.all([slow, quick])
  assert.deepEqual(order, ['start a', 'end a', 'deny b'])
})

// ---- thread is a read: not serialized, not remembered ----------------------------------------------------------------------------------

test('a slow thread read does not delay an approve queued after it', async () => {
  const order = []
  let release
  const gate = new Promise((r) => { release = r })
  const executor = createExecutor({
    queue: { thread: async () => { order.push('thread start'); await gate; order.push('thread end'); return { ok: true, messages: [] } }, approve: () => { order.push('approve'); return { ok: true } } },
    adapter: {},
  })
  const slow = executor.execute(cmd('thread', 'a'))
  const approved = await executor.execute(cmd('approve', 'b', { via: 'desktop' }))
  assert.deepEqual(approved, { ok: true })
  assert.deepEqual(order, ['thread start', 'approve'], 'the approve ran while the read was still going')
  release()
  assert.deepEqual(await slow, { ok: true, messages: [] })
})

test('a thread read does not wait for a slow command that was queued before it', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const executor = createExecutor({ queue: { reply: async () => { await gate; return { ok: true } }, thread: () => ({ ok: true, messages: [] }) }, adapter: {} })
  const slow = executor.execute(cmd('reply', 'a', { text: 'x' }))
  assert.deepEqual(await executor.execute(cmd('thread', 'b')), { ok: true, messages: [] })
  release()
  await slow
})

test('the result of a thread read is not kept: the same cid reads again, and 200 reads push nothing out of the cache', async () => {
  const reads = []
  const approvals = []
  const executor = createExecutor({
    queue: { thread: (id) => { reads.push(id); return { ok: true, messages: [] } }, approve: (id) => { approvals.push(id); return { ok: true } } },
    adapter: {},
  })
  const approve = cmd('approve', 'keep', { via: 'phone' })
  await executor.execute(approve)
  const read = cmd('thread', 'i1')
  await executor.execute(read)
  await executor.execute({ ...read })
  assert.deepEqual(reads, ['i1', 'i1'])
  for (let i = 0; i < 250; i++) await executor.execute(cmd('thread', 'r' + i))
  await executor.execute({ ...approve })
  assert.deepEqual(approvals, ['keep'], 'the approve is still answered from the cache')
})

test('a post is still serialized and cached by cid like any other accepted command', async () => {
  const order = []
  let release
  const gate = new Promise((r) => { release = r })
  const posts = []
  const executor = createExecutor({
    queue: { post: async (id, text) => { posts.push(text); order.push('post start'); await gate; order.push('post end'); return { ok: true } }, deny: () => { order.push('deny'); return { ok: true } } },
    adapter: {},
  })
  const p = cmd('post', 'a', { text: 'hello' })
  const first = executor.execute(p)
  const queued = executor.execute(cmd('deny', 'b'))
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(order, ['post start'])
  release()
  await Promise.all([first, queued])
  assert.deepEqual(order, ['post start', 'post end', 'deny'])
  assert.deepEqual(await executor.execute({ ...p }), { ok: true })
  assert.deepEqual(posts, ['hello'], 'delivered again after a lost response: it does not run twice')
})
