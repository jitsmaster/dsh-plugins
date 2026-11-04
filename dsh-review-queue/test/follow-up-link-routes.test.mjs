import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { P, startPhoneHub } from './hub-device-helpers.mjs'
import { agentOf } from './hub-agent-helpers.mjs'
import { act, answers, autopilot, followItem, nothingQueued, sess, twoApps, ws } from './hub-follow-up-helpers.mjs'
import { startHubApp } from './hub-app-helpers.mjs'
import { makeWorld } from './plugin-helpers.mjs'

// The session-link options (mode, source, excludeSessionIds) reach a follow-up todo only through the trusted `todo-link` action: every public
// entry (the standalone route, the hub's `todo`, a phone, the app proxy) drops them, and the plugin's own hub queue uses todo-link.
const BODY = { text: 'x', followUp: 'engine', mode: 'steer', source: { sessionId: 'evil', title: 'Evil' }, excludeSessionIds: ['s1'] }
const SESSIONS = [sess('s1', 200, { title: 'Engine one' }), sess('s2', 100, { title: 'Engine two' })]
const suggestOf = (seen) => seen.find((c) => c.kind === 'followup-suggest')

test('1 standalone server: POST /v1/todo ignores mode, source and excludeIds', async (t) => {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const controller = { list: async () => ({ items: [{ sessionId: 's1', updatedAt: 20, running: false, blank: false }, { sessionId: 's2', updatedAt: 10, running: false, blank: false }] }), prompt: async () => ({}), create: async () => ({ sessionId: 'N' }), rename: async () => {} }
  const registry = { list: () => [{ id: 'w1', title: 'Alpha', path: 'D:/a', sessionIds: ['s1'] }], archivedSessionIds: [] }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, registryOf: () => registry, titlesOf: async (ids) => new Map(ids.map((id) => [id, 'Engine ' + id])) })
  const serve = createRouter({ queue })
  const server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const res = await fetch('http://127.0.0.1:' + server.address().port + '/v1/todo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BODY) })
  const out = await res.json()
  assert.equal(out.ok, true)
  await queue.todoIdle()
  const item = store.get(out.id)
  assert.equal(item.mode, undefined)
  assert.equal(item.source, undefined)
  assert.equal(item.excludeIds, undefined)
  assert.ok(item.candidates.some((c) => c.sessionId === 's1'))
})

test('2 hub HTTP: POST /v1/todo strips the options and still lists s1', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, SESSIONS))
  const seenB = autopilot(t, b, answers(b, []))
  const res = await act(port, 'todo', BODY)
  assert.equal(res.status, 200)
  const args = suggestOf([...seenA, ...seenB]).args
  for (const key of ['mode', 'source', 'excludeSessionIds']) assert.equal(key in args, false, key)
  assert.deepEqual(args.sessions.map((s) => s.sessionId).sort(), ['s1', 's2'])
})

test('3 hub HTTP: POST /v1/todo-link as desktop carries the options and drops the excluded session', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, SESSIONS))
  const seenB = autopilot(t, b, answers(b, []))
  const res = await act(port, 'todo-link', BODY)
  assert.equal(res.status, 200)
  const args = suggestOf([...seenA, ...seenB]).args
  assert.equal(args.mode, 'steer')
  assert.equal(args.source.sessionId, 'evil')
  assert.deepEqual(args.excludeSessionIds, ['s1'])
  assert.deepEqual(args.sessions.map((s) => s.sessionId), ['s2'])
})

test('4 hub HTTP: a paired phone gets 403 desktop-only on todo-link and nothing is asked or stored', async (t) => {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: { n: 0, openItems: [], resolvedItems: [], workspaces: [ws('w1', 'alpha', 'D:/a')], sessionIds: [] } })
  const p = await h.pairPhone()
  const res = await p.call('POST', P + '/v1/todo-link', BODY)
  assert.deepEqual([res.status, res.json], [403, { error: 'desktop-only' }])
  await nothingQueued(a)
  assert.equal(h.hub.store.count(() => true), 0)
})

test('5 app proxy in hub mode: /v1/todo-link is not forwarded to the hub; /v1/todo is, and the hub strips it', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const A = await startHubApp(t, world, { label: 'DSH :1', webPort: 11011, workspaces: () => [{ id: 'w1', title: 'alpha', path: 'D:/a' }] })
  await A.inState('hub')
  const post = async (path) => { const r = await fetch(A.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BODY) }); return r.status }
  assert.equal(await post('/v1/todo-link'), 404, 'falls to the local server, which has no such route')
  assert.equal(world.hub.store.count(() => true), 0, 'nothing reached the hub')
})

function hubQueueWith() {
  const hubCalls = []
  const local = { onChange: () => () => {}, uiState: () => undefined, addTodo: () => ({ ok: true }) }
  const client = {
    state: 'connected', mirror: { ready: true, snapshot: () => ({ snapshotId: 'e:1', open: [], resolved: [] }), workspaces: () => [], onChange: () => () => {} },
    onState: () => () => {}, call: async (kind, body) => { hubCalls.push([kind, body]); return { ok: true } },
  }
  return { queue: createHubQueue({ local, client, controllerOf: () => ({}), now: () => 5000 }), hubCalls }
}

test('6 hub queue: addTodo with link options uses todo-link; without them it is todo', async () => {
  const { queue, hubCalls } = hubQueueWith()
  const source = { sessionId: 'me', title: 'Me' }
  await queue.addTodo('x', { followUp: 'engine', mode: 'steer', source, excludeSessionIds: ['me'] })
  await queue.addTodo('y', { followUp: 'engine' })
  assert.deepEqual(hubCalls, [
    ['todo-link', { text: 'x', followUp: 'engine', mode: 'steer', excludeSessionIds: ['me'], source }],
    ['todo', { text: 'y', followUp: 'engine' }],
  ])
})

test('7 hub confirm: a session in excludeIds is refused with excluded-session and nothing is sent', async (t) => {
  const { port, a, b } = await twoApps(t)
  await a.send(followItem(a, 1, { candidates: [{ sessionId: 'sa1', title: 'A', owner: a.id }], excludeIds: ['sa1'] }))
  const res = await act(port, 'todo-confirm', { id: a.itemId(1), sessionId: 'sa1' })
  assert.equal(res.json.ok, false)
  assert.equal(res.json.error, 'excluded-session')
  await nothingQueued(a)
  await nothingQueued(b)
})

test('8 a trusted todo-link never offers an excluded session, also when the words name it by number', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('s1', 200, { title: 'PR 77 review' }), sess('s2', 100, { title: 'Docs' })]))
  const seenB = autopilot(t, b, answers(b, []))
  const res = await act(port, 'todo-link', { text: 'x', followUp: 'PR 77', excludeSessionIds: ['s1'] })
  assert.equal(res.status, 200)
  const all = [...seenA, ...seenB]
  assert.deepEqual(suggestOf(all).args.sessions.map((s) => s.sessionId), ['s2'])
})
