import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listFollowUpSessions, snippetsFromThread } from '../follow-up.js'

// listFollowUpSessions: the sessions a follow-up todo can be sent to, from this app's session controller. Never throws.
const NOW = 5_000_000
const item = (sessionId, extra = {}) => ({ sessionId, updatedAt: NOW - 1000, running: false, blank: false, ...extra })
const controllerOf = (items) => ({ list: async () => ({ items }) })
const titles = (obj) => async (ids) => new Map(ids.filter((id) => obj[id]).map((id) => [id, obj[id]]))
const registry = (workspaces = [], archivedSessionIds = []) => ({ list: () => workspaces, archivedSessionIds })

test('asks the controller for its list with an abort signal', async () => {
  const seen = []
  const controller = { list: async (arg, signal) => { seen.push([arg, signal]); return { items: [] } } }
  await listFollowUpSessions({ controller, registry: registry() })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0][0], {})
  assert.ok(seen[0][1] instanceof AbortSignal)
})

test('keeps top-level, non-blank, non-archived sessions only (the filter of the session counter)', async () => {
  const controller = controllerOf([
    item('ok'),
    item('child', { parentSessionId: 'ok' }),
    item('sub', { origin: 'subagent' }),
    item('blank', { blank: true }),
    item('arch-registry'),
    item('arch-option'),
    { sessionId: 7 }, null, 'text', { updatedAt: 1 },
    item('running-first-turn', { running: true, blank: false }),
  ])
  const out = await listFollowUpSessions({ controller, registry: registry([], ['arch-registry']), archived: new Set(['arch-option']), titlesOf: titles({}) })
  assert.deepEqual(out.map((c) => c.sessionId).sort(), ['ok', 'running-first-turn'])
})

test('sorted newest first (updatedAt), a missing time last, and capped to the limit', async () => {
  const controller = controllerOf([item('b', { updatedAt: 200 }), item('none', { updatedAt: undefined }), item('c', { updatedAt: 300 }), item('a', { updatedAt: 100 })])
  const all = await listFollowUpSessions({ controller, registry: registry() })
  assert.deepEqual(all.map((c) => c.sessionId), ['c', 'b', 'a', 'none'])
  const two = await listFollowUpSessions({ controller, registry: registry(), limit: 2 })
  assert.deepEqual(two.map((c) => c.sessionId), ['c', 'b'])
  const many = controllerOf(Array.from({ length: 100 }, (_, i) => item('s' + i, { updatedAt: i })))
  const def = await listFollowUpSessions({ controller: many, registry: registry() })
  assert.equal(def.length, 60, 'the default limit is 60')
  assert.equal(def[0].sessionId, 's99')
})

test('title from titlesOf (asked once for the kept ids), else Untitled session; a failing titlesOf is ignored', async () => {
  const asked = []
  const controller = controllerOf([item('a', { updatedAt: 2 }), item('b', { updatedAt: 1 })])
  const out = await listFollowUpSessions({ controller, registry: registry(), titlesOf: async (ids) => { asked.push(ids); return new Map([['a', 'Alpha work']]) } })
  assert.deepEqual(out.map((c) => [c.sessionId, c.title]), [['a', 'Alpha work'], ['b', 'Untitled session']])
  assert.deepEqual(asked, [['a', 'b']])
  const broken = await listFollowUpSessions({ controller, registry: registry(), titlesOf: async () => { throw new Error('no titles') } })
  assert.deepEqual(broken.map((c) => c.title), ['Untitled session', 'Untitled session'])
  const none = await listFollowUpSessions({ controller, registry: registry() })
  assert.deepEqual(none.map((c) => c.title), ['Untitled session', 'Untitled session'])
})

test('workspaceId and workspaceTitle come from the registry entry that holds the session; running and updatedAt are carried', async () => {
  const controller = controllerOf([item('a', { running: true, updatedAt: 42 }), item('b'), item('loose')])
  const ws = [{ id: 'w1', title: 'Alpha', path: 'D:/x/alpha', sessionIds: ['a'] }, { id: 'w2', path: 'D:/x/beta', sessionIds: ['b'] }]
  const out = await listFollowUpSessions({ controller, registry: registry(ws) })
  const by = Object.fromEntries(out.map((c) => [c.sessionId, c]))
  assert.deepEqual([by.a.workspaceId, by.a.workspaceTitle, by.a.running, by.a.updatedAt], ['w1', 'Alpha', true, 42])
  assert.deepEqual([by.b.workspaceId, by.b.workspaceTitle], ['w2', 'beta'], 'a workspace without a title shows its folder name')
  assert.equal(by.loose.workspaceId, undefined)
  assert.equal(by.loose.workspaceTitle, undefined)
  assert.equal(by.loose.running, false)
})

test('works without a registry', async () => {
  const out = await listFollowUpSessions({ controller: controllerOf([item('a')]), registry: undefined })
  assert.equal(out.length, 1)
  assert.equal(out[0].workspaceId, undefined)
})

test('snippets: asked for the snippetLimit newest sessions only, cut to one line of at most 120 characters', async () => {
  const controller = controllerOf(Array.from({ length: 6 }, (_, i) => item('s' + i, { updatedAt: i })))
  const asked = []
  const snippetsOf = async (ids) => { asked.push(ids); return new Map([['s5', 'first line\nsecond   line'], ['s4', 'x'.repeat(300)], ['s0', 'never asked']]) }
  const out = await listFollowUpSessions({ controller, registry: registry(), snippetsOf, snippetLimit: 3 })
  assert.deepEqual(asked, [['s5', 's4', 's3']])
  const by = Object.fromEntries(out.map((c) => [c.sessionId, c]))
  assert.equal(by.s5.snippet, 'first line second line')
  assert.equal(by.s4.snippet.length, 120)
  assert.ok(by.s4.snippet.startsWith('xxxx'))
  assert.equal(by.s3.snippet, undefined)
  assert.equal(by.s0.snippet, undefined, 'a snippet of a session that was not asked about is dropped')
})

test('the default snippetLimit is 8', async () => {
  const controller = controllerOf(Array.from({ length: 30 }, (_, i) => item('s' + i, { updatedAt: i })))
  let count
  await listFollowUpSessions({ controller, registry: registry(), snippetsOf: async (ids) => { count = ids.length; return new Map() } })
  assert.equal(count, 8)
})

test('a snippetsOf that never answers is given up after the snippet time limit and the list is still returned', async () => {
  const controller = controllerOf([item('a'), item('b', { updatedAt: 1 })])
  const started = Date.now()
  const out = await listFollowUpSessions({ controller, registry: registry(), titlesOf: titles({ a: 'Alpha' }), snippetsOf: () => new Promise(() => {}), snippetTimeoutMs: 50 })
  assert.ok(Date.now() - started < 2000, 'bounded')
  assert.deepEqual(out.map((c) => [c.sessionId, c.title, c.snippet]), [['a', 'Alpha', undefined], ['b', 'Untitled session', undefined]])
})

test('the snippet time limit is 3 s by default', async () => {
  const controller = controllerOf([item('a')])
  const started = Date.now()
  const out = await listFollowUpSessions({ controller, registry: registry(), snippetsOf: () => new Promise(() => {}) })
  const took = Date.now() - started
  assert.ok(took >= 2800 && took < 6000, 'took ' + took)
  assert.equal(out.length, 1)
})

test('a snippetsOf that throws or answers something odd is ignored', async () => {
  const controller = controllerOf([item('a')])
  for (const snippetsOf of [async () => { throw new Error('boom') }, async () => undefined, async () => ({ a: 'x' }), async () => new Map([['a', 42]])]) {
    const out = await listFollowUpSessions({ controller, registry: registry(), snippetsOf })
    assert.equal(out.length, 1)
    assert.equal(out[0].snippet, undefined)
  }
})

test('never throws: a failing list, no controller or garbage give [] and the failure is logged', async () => {
  const logs = []
  const log = (line) => logs.push(line)
  assert.deepEqual(await listFollowUpSessions({ controller: { list: async () => { throw new Error('down') } }, registry: registry(), log }), [])
  assert.ok(logs.length === 1 && /Error/.test(logs[0]) && !/down/.test(logs[0]), JSON.stringify(logs)) // the error name only: a message can carry a path or content
  assert.deepEqual(await listFollowUpSessions({ controller: undefined, registry: registry(), log }), [])
  assert.deepEqual(await listFollowUpSessions({ controller: {}, registry: registry(), log }), [])
  assert.deepEqual(await listFollowUpSessions({ controller: { list: async () => ({ items: 'x' }) }, registry: registry(), log }), [])
  assert.deepEqual(await listFollowUpSessions({ controller: { list: async () => null }, registry: registry(), log }), [])
  assert.deepEqual(await listFollowUpSessions({ controller: { list: () => { throw new Error('sync') } }, registry: registry(), log }), [])
  const broken = await listFollowUpSessions({ controller: controllerOf([item('a')]), registry: { list: () => { throw new Error('registry down') }, get archivedSessionIds() { throw new Error('x') } }, log })
  assert.deepEqual(broken.map((c) => c.sessionId), ['a'], 'a broken registry only loses the workspaces')
  assert.deepEqual(await listFollowUpSessions({ log }), [])
  assert.deepEqual(await listFollowUpSessions(), [])
})

test('a controller whose list never answers does not hang the call beyond its own bounded wait', async () => {
  const seen = []
  const controller = { list: (arg, signal) => new Promise((_, reject) => { seen.push(signal); signal.addEventListener('abort', () => reject(new Error('aborted'))) }) }
  const call = listFollowUpSessions({ controller, registry: registry(), listTimeoutMs: 40 })
  assert.deepEqual(await call, [])
  assert.equal(seen[0].aborted, true)
})

// The whole answer (list, titles, snippets) shares ONE deadline (totalMs, 4.5 s by default: the hub gives an app up after 6 s), and what is known by then is returned.
const never = () => new Promise(() => {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('late titles and snippets cost no more than the overall deadline: the candidates are returned without them', { timeout: 4000 }, async () => {
  const controller = { list: async () => { await sleep(100); return { items: [item('a', { updatedAt: 2 }), item('b', { updatedAt: 1 })] } } }
  const started = Date.now()
  const out = await listFollowUpSessions({ controller, registry: registry(), titlesOf: never, snippetsOf: never, totalMs: 400 })
  const took = Date.now() - started
  assert.ok(took >= 350 && took < 1500, 'took ' + took + ' ms (deadline 400)')
  assert.deepEqual(out.map((c) => [c.sessionId, c.title, c.snippet]), [['a', 'Untitled session', undefined], ['b', 'Untitled session', undefined]])
})

test('the snippets that are late are dropped but the titles that arrived in time are kept', { timeout: 4000 }, async () => {
  const controller = { list: async () => { await sleep(50); return { items: [item('a')] } } }
  const started = Date.now()
  const out = await listFollowUpSessions({ controller, registry: registry(), titlesOf: titles({ a: 'Alpha' }), snippetsOf: never, totalMs: 300 })
  assert.ok(Date.now() - started < 1500, 'took ' + (Date.now() - started) + ' ms (deadline 300, the snippet limit alone is 3 s)')
  assert.deepEqual(out.map((c) => [c.title, c.snippet]), [['Alpha', undefined]])
})

test('a list call that ignores its signal is given up at the overall deadline, not after its own 10 s plus grace', { timeout: 4000 }, async () => {
  const logs = []
  const started = Date.now()
  const out = await listFollowUpSessions({ controller: { list: never }, registry: registry(), totalMs: 200, log: (l) => logs.push(l) })
  const took = Date.now() - started
  assert.deepEqual(out, [])
  assert.ok(took < 1500, 'took ' + took + ' ms')
  assert.equal(logs.length, 1)
})

test('the titles and the snippets are asked together, so one slow reader does not wait for the other', async () => {
  const controller = controllerOf([item('a')])
  const order = []
  await listFollowUpSessions({
    controller, registry: registry(),
    titlesOf: async () => { order.push('titles start'); await sleep(60); order.push('titles end'); return new Map() },
    snippetsOf: async () => { order.push('snippets start'); await sleep(10); order.push('snippets end'); return new Map() },
  })
  assert.deepEqual(order, ['titles start', 'snippets start', 'snippets end', 'titles end'])
})

// snippetsFromThread: the optional snippet reader, from the thread reader (thread.js readThread) with limit 1.
test('snippetsFromThread reads the newest message of each session with limit 1 and gives id -> text', async () => {
  const calls = []
  const threadOf = async (opts) => {
    calls.push(opts)
    if (opts.sessionId === 'bad') return { ok: false, error: 'no-log' }
    if (opts.sessionId === 'empty') return { ok: true, messages: [] }
    if (opts.sessionId === 'throws') throw new Error('x')
    return { ok: true, messages: [{ id: 3, role: 'assistant', text: 'Last thing said in ' + opts.sessionId }] }
  }
  const read = snippetsFromThread(threadOf)
  const out = await read(['a', 'bad', 'empty', 'throws', 'b'])
  assert.ok(out instanceof Map)
  assert.deepEqual([...out], [['a', 'Last thing said in a'], ['b', 'Last thing said in b']])
  assert.ok(calls.every((c) => c.limit === 1))
  assert.deepEqual(calls.map((c) => c.sessionId).sort(), ['a', 'b', 'bad', 'empty', 'throws'])
})

test('snippetsFromThread is undefined without a thread reader, and reads with a small concurrency', async () => {
  assert.equal(snippetsFromThread(undefined), undefined)
  let active = 0
  let peak = 0
  const threadOf = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return { ok: true, messages: [{ text: 't' }] } }
  const out = await snippetsFromThread(threadOf)(Array.from({ length: 12 }, (_, i) => 's' + i))
  assert.equal(out.size, 12)
  assert.ok(peak <= 4, 'peak ' + peak)
})
