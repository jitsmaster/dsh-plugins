import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { startFakeHub, startProxy } from './agent-proxy-helpers.mjs'

// Quit and Pause all and quit are gone: no queue method, no route.
test('there is no pauseAll or quitApp, and /v1/quit and /v1/pause-all are not routes', async (t) => {
  const queue = createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}) })
  assert.equal(queue.pauseAll, undefined)
  assert.equal(queue.quitApp, undefined)
  const server = createServer(createRouter({ queue }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  for (const route of ['/v1/quit', '/v1/pause-all']) {
    const res = await fetch('http://127.0.0.1:' + server.address().port + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(res.status, 404, route)
  }
})

// ---- POST /v1/running-sessions: which top-level sessions of this app are running (Resume all polls it to free a place early) ----------------

const sess = (sessionId, over = {}) => ({ sessionId, running: true, ...over })
function runningQueue(controller, extra = {}) {
  return createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => controller, ...extra })
}

test('runningSessions lists the running top-level sessions only (no subagents, no children, none that are idle)', async () => {
  const seenArgs = []
  const queue = runningQueue({ list: async (...args) => { seenArgs.push(args); return { items: [sess('a'), sess('b', { running: false }), sess('c', { parentSessionId: 'a' }), sess('d', { origin: 'subagent' }), sess('e', { running: 'yes' }), sess('f', { origin: 'user' })] } } })
  assert.deepEqual(await queue.runningSessions(), { ok: true, ids: ['a', 'f'] })
  assert.deepEqual(seenArgs[0][0], {})
  assert.ok(seenArgs[0][1] instanceof AbortSignal, 'the Remote list call needs a caller signal')
})

test('runningSessions says which app answered when it knows its instance id (hub mode), and an empty list is ok', async () => {
  const queue = runningQueue({ list: async () => ({ items: [] }) }, { instanceId: 'inst-1' })
  assert.deepEqual(await queue.runningSessions(), { ok: true, ids: [], instanceId: 'inst-1' })
  assert.deepEqual(await runningQueue({ list: async () => ({}) }).runningSessions(), { ok: true, ids: [] })
})

test('runningSessions: no controller (or none that lists), and a list that fails, are errors, never a throw', async () => {
  assert.deepEqual(await createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => undefined }).runningSessions(), { ok: false, error: 'no-controller' })
  assert.deepEqual(await runningQueue({}).runningSessions(), { ok: false, error: 'no-controller' })
  const logged = []
  const r = await runningQueue({ list: async () => { throw new Error('boom at C:/secret/path') } }, { log: (line) => logged.push(line) }).runningSessions()
  assert.deepEqual(r, { ok: false, error: 'list-failed' }, 'the controller\'s own text never goes to the client')
  assert.ok(logged.some((l) => /boom/.test(l)), 'the detail goes to the log')
})

test('runningSessions: concurrent calls share one controller list, an answer is reused for 1.5 s, then a new list is asked; errors are not cached', async () => {
  let t = 10_000
  let lists = 0
  let release
  const gate = new Promise((r) => { release = r })
  const state = { items: [sess('a')], fail: false }
  const queue = runningQueue({ list: async () => { lists++; await gate; if (state.fail) throw new Error('x'); return { items: state.items } } }, { now: () => t, log() {} })
  const first = [queue.runningSessions(), queue.runningSessions(), queue.runningSessions()]
  release()
  assert.deepEqual((await Promise.all(first)).map((r) => r.ids), [['a'], ['a'], ['a']])
  assert.equal(lists, 1, 'three callers, one list')
  state.items = [sess('b')]
  t += 1_499
  assert.deepEqual((await queue.runningSessions()).ids, ['a'], 'a result younger than 1.5 s is reused')
  assert.equal(lists, 1)
  t += 1
  assert.deepEqual((await queue.runningSessions()).ids, ['b'], 'older: a new list')
  assert.equal(lists, 2)
  state.fail = true
  t += 5_000
  assert.equal((await queue.runningSessions()).ok, false)
  state.fail = false
  assert.equal((await queue.runningSessions()).ok, true, 'the error was not kept')
  assert.equal(lists, 4)
})

test('runningSessions: the share window counts from the COMPLETION of a slow list, and a clock stepping back expires it', async () => {
  let t = 10_000
  let lists = 0
  const queue = runningQueue({ list: async () => { lists++; t += 4_000; return { items: [sess('a')] } } }, { now: () => t })
  await queue.runningSessions()
  const doneAt = t
  t = doneAt + 1_499
  await queue.runningSessions()
  assert.equal(lists, 1, 'within 1.5 s of the completion')
  t = doneAt + 1_500
  await queue.runningSessions()
  assert.equal(lists, 2)
  t -= 10_000
  await queue.runningSessions()
  assert.equal(lists, 3, 'a negative age is expired')
})

test('runningSessions: a list that never answers does not hold every caller forever: list-failed after the limit, and the next call asks again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let lists = 0
  const logged = []
  const queue = runningQueue({ list: () => { lists++; return new Promise(() => {}) } }, { log: (l) => logged.push(l) })
  const a = queue.runningSessions()
  const b = queue.runningSessions()
  assert.equal(lists, 1)
  t.mock.timers.tick(6_001)
  assert.deepEqual(await Promise.all([a, b]), [{ ok: false, error: 'list-failed' }, { ok: false, error: 'list-failed' }])
  assert.ok(logged.some((l) => /timed out/.test(l)))
  queue.runningSessions()
  assert.equal(lists, 2, 'the failed call was not kept')
})

test('the route /v1/running-sessions: 200 with the ids, 409 with the reason, POST only', async (t) => {
  for (const [controller, expected] of [[{ list: async () => ({ items: [sess('a')] }) }, [200, { ok: true, ids: ['a'] }]], [undefined, [409, { ok: false, error: 'no-controller' }]]]) {
    const server = createServer(createRouter({ queue: runningQueue(controller) }))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    t.after(() => new Promise((r) => server.close(r)))
    const url = 'http://127.0.0.1:' + server.address().port + '/v1/running-sessions'
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.deepEqual([res.status, await res.json()], expected)
    assert.equal((await fetch(url)).status, 405)
  }
})

test('through the proxy /v1/running-sessions is answered by this app in every hub mode; the hub is never asked', async (t) => {
  for (const mode of ['hub', 'degraded', 'standalone']) {
    const hub = await startFakeHub(t)
    const queue = runningQueue({ list: async () => ({ items: [sess('a')] }) })
    const p = await startProxy(t, { mode, hub, queue })
    const a = await p.post('/v1/running-sessions', {})
    assert.deepEqual([a.status, a.json], [200, { ok: true, ids: ['a'] }], mode)
    assert.deepEqual(hub.requests, [], mode + ': nothing went to the hub')
  }
})
