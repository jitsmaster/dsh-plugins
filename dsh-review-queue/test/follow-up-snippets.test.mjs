import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { createExecutor } from '../agent/executor.js'
import { SNIPPET_LIMIT, listFollowUpSessions, snippetsFromThread } from '../follow-up.js'
import { createThreadCache, readThread } from '../thread.js'
import { fakeLlm, promptOf, setupFollowUp } from './follow-up-helpers.mjs'
import { log, tmpRoot, writeLog } from './paused-helpers.mjs'

// The snippet read of a follow-up (the last chat message of each session) decodes whole session logs, so it is done as little as possible: not at all when a ticket / PR number of the words
// already decides, for 8 sessions at most, into a cache of its own, with one listing of the sessions folder per pass, and it stops as soon as the answer has been given.
const NOW = 5_000_000
const item = (sessionId, extra = {}) => ({ sessionId, updatedAt: NOW - 1000, running: false, blank: false, ...extra })
const controllerOf = (items) => ({ list: async () => ({ items }) })
const titles = (obj) => async (ids) => new Map(ids.filter((id) => obj[id]).map((id) => [id, obj[id]]))
const registry = { list: () => [], archivedSessionIds: [] }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- (a) only the model step needs snippets ----------------------------------------------------------------------------------------------

test('a ticket number of the words that decides one title: no snippet is read', async () => {
  const asked = []
  const out = await listFollowUpSessions({
    controller: controllerOf([item('a', { updatedAt: 2 }), item('b', { updatedAt: 1 })]), registry, query: 'the one for ticket 25001',
    titlesOf: titles({ a: 'Fix: login - 25001', b: 'Other work' }), snippetsOf: async (ids) => { asked.push(ids); return new Map([['a', 'x']]) },
  })
  assert.deepEqual(asked, [])
  assert.deepEqual(out.map((c) => [c.sessionId, c.title, c.snippet]), [['a', 'Fix: login - 25001', undefined], ['b', 'Other work', undefined]])
})

test('a number that decides nothing (no title has it, or two do) still reads the snippets, after the titles', async () => {
  for (const given of [{ a: 'Alpha', b: 'Beta' }, { a: 'Fix 25001', b: 'Also 25001' }, {}]) {
    const order = []
    const out = await listFollowUpSessions({
      controller: controllerOf([item('a', { updatedAt: 2 }), item('b', { updatedAt: 1 })]), registry, query: 'ticket 25001',
      titlesOf: async (ids) => { order.push('titles'); return titles(given)(ids) }, snippetsOf: async (ids) => { order.push('snippets ' + ids.join()); return new Map([['a', 'last words']]) },
    })
    assert.deepEqual(order, ['titles', 'snippets a,b'], JSON.stringify(given))
    assert.equal(out[0].snippet, 'last words')
  }
})

test('words without a ticket or PR number change nothing: the titles and the snippets are asked together, and a bare number does not count', async () => {
  for (const query of ['the PR review', 'the 25001 one', undefined]) {
    const order = []
    await listFollowUpSessions({
      controller: controllerOf([item('a')]), registry, query,
      titlesOf: async () => { order.push('titles start'); await sleep(40); order.push('titles end'); return new Map([['a', 'Fix 25001']]) },
      snippetsOf: async () => { order.push('snippets start'); return new Map() },
    })
    assert.deepEqual(order.slice(0, 2), ['titles start', 'snippets start'], String(query))
  }
})

test('service: a ticket number in the words decides without reading a snippet; a model pick reads them (8 at most); the hub can ask for none', async () => {
  const asked = []
  const snippetsOf = async (ids) => { asked.push(ids); return new Map() }
  const ref = setupFollowUp({ llm: fakeLlm({ answer: '{"select":null}' }), snippetsOf })
  const one = ref.queue.addTodo('msg', { followUp: 'the one for ticket 25001' })
  await ref.queue.todoIdle()
  assert.equal(ref.store.get(one.id).suggested.sessionId, 's-old')
  assert.deepEqual(asked, [])
  const seen = {}
  const model = setupFollowUp({ llm: fakeLlm({ answer: '{"select":"s-pr"}', seen }), snippetsOf })
  model.queue.addTodo('msg', { followUp: 'the review' })
  await model.queue.todoIdle()
  assert.deepEqual(asked.length, 1)
  assert.ok(asked[0].length <= 8 && asked[0].length === 3)
  assert.ok(promptOf(seen).includes('s-pr'))
  asked.length = 0
  assert.equal((await model.queue.followUpSessions({ snippets: false })).length, 3)
  assert.deepEqual(asked, [], 'snippets: false reads none')
  await model.queue.followUpSessions()
  await model.queue.followUpSessions({})
  assert.equal(asked.length, 2, 'by default the snippets are read')
})

test('sessions-list from the hub: args.snippets false asks the queue for none; without it the call is as before', async () => {
  const calls = []
  const executor = createExecutor({ queue: { followUpSessions: async (...args) => { calls.push(args); return [] } }, adapter: {} })
  await executor.execute({ cid: 'x1', seq: 1, kind: 'sessions-list', args: {} })
  await executor.execute({ cid: 'x2', seq: 2, kind: 'sessions-list', args: { snippets: false } })
  assert.deepEqual(calls, [[], [{ snippets: false }]])
})

// ---- (b) 8 snippets at most --------------------------------------------------------------------------------------------------------------

test('the default snippet limit is 8', async () => {
  assert.equal(SNIPPET_LIMIT, 8)
  const controller = controllerOf(Array.from({ length: 30 }, (_, i) => item('s' + i, { updatedAt: i })))
  let asked
  await listFollowUpSessions({ controller, registry, snippetsOf: async (ids) => { asked = ids; return new Map() } })
  assert.deepEqual(asked, ['s29', 's28', 's27', 's26', 's25', 's24', 's23', 's22'])
})

// ---- (c) a cache of their own ------------------------------------------------------------------------------------------------------------

test('the snippet reads use a thread cache of their own, the same one every pass, small, and not the default one the phone chat uses', async () => {
  const seen = []
  const threadOf = async (opts) => { seen.push(opts.cache); return { ok: true, messages: [{ text: 't' }] } }
  const read = snippetsFromThread(threadOf)
  await read(['a', 'b'])
  await read(['c'])
  assert.equal(seen.length, 3)
  assert.ok(seen[0] && typeof seen[0].recall === 'function' && typeof seen[0].flight === 'function', 'a thread cache')
  assert.ok(seen.every((c) => c === seen[0]), 'one cache for all passes')
  assert.ok(seen[0].max <= 8, 'small: ' + seen[0].max)
  const other = snippetsFromThread(threadOf)
  await other(['a'])
  assert.notEqual(seen[3], seen[0], 'each reader has its own')
})

test('the logs read for snippets land in that cache (a real log read), the cache that was given is used', async (t) => {
  const root = tmpRoot(t)
  for (const id of ['s1', 's2', 's3']) writeLog(root, id, [[log.head(), log.user('hello ' + id), log.assistant('answer of ' + id)]])
  const cache = createThreadCache()
  const read = snippetsFromThread((opts) => readThread({ root, ...opts }), { cache })
  const out = await read(['s1', 's2', 's3'])
  assert.deepEqual([...out], [['s1', 'answer of s1'], ['s2', 'answer of s2'], ['s3', 'answer of s3']])
  assert.equal(cache.size, 3)
})

// ---- (d) stops at the deadline ------------------------------------------------------------------------------------------------------------

test('the snippet reader stops before each next session once its signal is aborted', async () => {
  const ac = new AbortController()
  const calls = []
  const threadOf = async ({ sessionId }) => { calls.push(sessionId); await sleep(10); if (calls.length >= 2) ac.abort(); return { ok: true, messages: [{ text: 't ' + sessionId }] } }
  const out = await snippetsFromThread(threadOf)(Array.from({ length: 20 }, (_, i) => 's' + i), ac.signal)
  const started = calls.length
  assert.ok(started >= 2 && started <= 6, 'a few reads were under way when it stopped: ' + started)
  await sleep(60)
  assert.equal(calls.length, started, 'nothing more was started')
  assert.ok(out instanceof Map)
  const done = new AbortController()
  done.abort()
  const none = []
  assert.equal((await snippetsFromThread(async ({ sessionId }) => { none.push(sessionId); return { ok: false } })(['a', 'b'], done.signal)).size, 0)
  assert.deepEqual(none, [], 'an aborted signal reads nothing')
})

test('listFollowUpSessions hands the snippet reader a signal and aborts it when the answer is given, also when the reader was late', async () => {
  const signals = []
  const controller = controllerOf([item('a')])
  await listFollowUpSessions({ controller, registry, snippetsOf: async (ids, signal) => { signals.push(signal); return new Map([['a', 'x']]) } })
  assert.ok(signals[0] instanceof AbortSignal)
  assert.equal(signals[0].aborted, true, 'aborted once the answer was sent')
  const late = []
  await listFollowUpSessions({ controller, registry, snippetTimeoutMs: 30, snippetsOf: (ids, signal) => { late.push(signal); return new Promise(() => {}) } })
  assert.equal(late[0].aborted, true, 'a reader that is given up on is told to stop')
})

test('a slow log read stops at the snippet time limit: the rest of the sessions are not read afterwards', async () => {
  const reads = []
  const threadOf = async ({ sessionId }) => { reads.push(sessionId); await sleep(120); return { ok: true, messages: [{ text: 't' }] } }
  const controller = controllerOf(Array.from({ length: 8 }, (_, i) => item('s' + i, { updatedAt: i })))
  await listFollowUpSessions({ controller, registry, snippetsOf: snippetsFromThread(threadOf), snippetTimeoutMs: 60 })
  const during = reads.length
  await sleep(250)
  assert.equal(reads.length, during, 'no read starts after the answer: ' + reads.length + ' vs ' + during)
  assert.ok(during < 8, 'it did not get through all of them: ' + during)
})

// ---- (e) one listing of the sessions folder per pass ---------------------------------------------------------------------------------------

test('one listing of the sessions folder serves every read of a pass (and the next pass lists again)', async (t) => {
  const root = tmpRoot(t)
  for (const id of ['s1', 's2', 's3', 's4', 's5']) writeLog(root, id, [[log.head(), log.user('q'), log.assistant('answer of ' + id)]])
  const listed = []
  const counting = async (path, opts) => { listed.push(path); return readdir(path, opts) }
  const read = snippetsFromThread((opts) => readThread({ root, ...opts }), { readdir: counting, cache: createThreadCache({ throttleMs: 0 }) })
  const out = await read(['s1', 's2', 's3', 's4', 's5'])
  assert.equal(out.size, 5)
  assert.equal(out.get('s4'), 'answer of s4')
  assert.deepEqual(listed, [root])
  await read(['s1'])
  assert.deepEqual(listed, [root, root], 'a new pass lists again')
})

test('the read passes its listing as the fs of the thread reader, and a failing listing only loses the snippets', async () => {
  const seen = []
  await snippetsFromThread(async (opts) => { seen.push(typeof opts.fs?.readdir); return { ok: true, messages: [] } })(['a'])
  assert.deepEqual(seen, ['function'])
  const out = await snippetsFromThread((opts) => readThread({ root: 'Z:/does/not/exist', ...opts }), { readdir: async () => { throw new Error('gone') } })(['a', 'b'])
  assert.equal(out.size, 0)
})
