import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createSessionCounter } from '../sessions.js'
import { installCapture } from '../capture.js'
import { parseSince, stampMatches, fullStampOf, archKeyOf } from '../server.js'

// Caveats of the Archive session button: the flag is part of the long-poll token, and archiving closes the session's question and permission cards.
const tick = () => new Promise((r) => setImmediate(r))
function setup({ verdict = () => ({ protected: false }), capture = {}, archiveSession = async () => {} } = {}) {
  const store = createStore()
  const state = { running: [] }
  const controller = { list: async () => ({ items: ['idle', 'other'].map((sessionId) => ({ sessionId, running: state.running.includes(sessionId), updatedAt: 1, blank: false })) }) }
  const sessions = createSessionCounter({ controllerOf: () => controller, ttlMs: 0 })
  const guard = { check: async (id) => verdict(id) }
  const registry = { archivedSessionIds: [], archiveSession }
  const queue = createReviewQueue({ store, capture, log: () => {}, sessions, registryOf: () => registry, prGuardOf: () => guard })
  const snap = async () => { queue.snapshot({ watch: true }); await sessions.refresh(); await tick(); await tick(); return queue.snapshot({ watch: true }) }
  return { store, queue, state, snap, sessions }
}

test('the snapshot carries an archKey that changes with the archivable flags and is the 7th token part', async () => {
  const { store, snap, state, sessions } = setup()
  store.add({ type: 'completed', sessionId: 'idle' })
  const first = await snap()
  assert.ok(first.archKey, 'an archivable item gives a non-empty key')
  assert.equal(fullStampOf(first).split('|')[6], first.archKey)
  state.running.push('idle'); await tick(); await sessions.refresh()
  const second = await snap()
  assert.notEqual(second.archKey, first.archKey)
  assert.equal(second.archKey, '')
})

test('stampMatches: a token with the old archKey does not match; a six-part token from an older client still does', async () => {
  const { store, snap } = setup()
  store.add({ type: 'completed', sessionId: 'idle' })
  const s = await snap()
  const six = fullStampOf(s).split('|').slice(0, 6).join('|')
  assert.equal(stampMatches(s, parseSince(six)), true)
  assert.equal(stampMatches(s, parseSince(six + '|')), false, 'the client saw no archivable item, the server has one')
  assert.equal(stampMatches(s, parseSince(six + '|' + s.archKey)), true)
  assert.equal(stampMatches({ snapshotId: 'a:1' }, parseSince('a:1||||||')), true, 'a snapshot without a key (the hub) is not held to it')
})

test('the flag arriving later (the PR guard answered) wakes the listeners', async () => {
  const { store, queue, sessions } = setup()
  store.add({ type: 'completed', sessionId: 'idle' })
  let woke = 0
  queue.onChange(() => { woke++ })
  queue.snapshot({ watch: true }); await sessions.refresh(); await tick(); await tick()
  const before = woke
  assert.ok(before >= 1, 'the verdict that makes the item archivable emits a change')
})

test('the long-poll token of the overlay client has the archKey as 7th part', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, fetch: async () => ({}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  const T = registered.factory(() => ({ createElement() {}, Fragment: Symbol('F'), useState: (v) => [v, () => {}], useEffect() {}, useRef() {}, useSyncExternalStore() {} })).__test
  assert.equal(T.sinceOf({ snapshotId: 'e:1', archKey: 'k9' }).split('|')[6], 'k9')
  assert.equal(T.sinceOf({ snapshotId: 'e:1' }).split('|')[6], '')
})

test('archiving closes the open question and permission cards of that session (and only that session)', async () => {
  const { store, queue } = setup()
  const q = store.add({ type: 'question', sessionId: 'idle' })
  const p = store.add({ type: 'permission', sessionId: 'idle', tool: 'Bash', input: {} })
  const c = store.add({ type: 'completed', sessionId: 'idle' })
  const other = store.add({ type: 'question', sessionId: 'other' })
  assert.deepEqual(await queue.archiveSession(c.id), { ok: true })
  for (const id of [q.id, p.id, c.id]) assert.deepEqual(store.get(id).resolution, { kind: 'archived', by: 'card' })
  assert.equal(store.get(other.id).status, 'open')
})

test('archiving closes pending cards through capture.closeOpen so nothing stays pending; a refused archive closes nothing', async () => {
  const closed = []
  const store0 = null
  const capture = { closeOpen: (id, resolution) => { closed.push([id, resolution]); return true } }
  const { store, queue } = setup({ capture })
  const q = store.add({ type: 'question', sessionId: 'idle' })
  const p = store.add({ type: 'permission', sessionId: 'idle' })
  await queue.archiveSession(q.id)
  assert.deepEqual(closed.map((x) => x[0]).sort(), [p.id, q.id].sort())
  assert.deepEqual(closed[0][1], { kind: 'archived', by: 'card' })
  const failing = setup({ archiveSession: async () => { throw new Error('boom') } })
  const q2 = failing.store.add({ type: 'question', sessionId: 'idle' })
  assert.equal((await failing.queue.archiveSession(q2.id)).ok, false)
  assert.equal(failing.store.get(q2.id).status, 'open')
})

test('capture.closeOpen settles a pending permission and a pending question', async () => {
  const handlers = {}
  const ctx = { on: (n, fn) => { (handlers[n] ??= []).push(fn) }, get: () => undefined, logger: { warn() {}, info() {} } }
  const store = createStore()
  const capture = installCapture(ctx, { store, summarizer: { summarize: async () => ({ text: 'x', source: 'llm' }) } })
  const agent = { id: 'a1', session: { id: 'a1', header: { cwd: 'D:/p' }, deriveMessages: () => [] } }
  const never = () => new Promise(() => {})
  handlers['approval/request'][0]({ agent, toolName: 'shell', callId: 'p1' }, never)
  handlers['user-questions/request'][0]({ agent, questions: [{ id: 'q1', question: 'Q?', options: [{ label: 'A' }] }], wait: { callId: 'c1' } }, never)
  const [a, b] = store.snapshot().open
  for (const i of [a, b]) assert.equal(capture.closeOpen(i.id, { kind: 'archived', by: 'card' }, 'test'), true)
  assert.deepEqual(store.snapshot().open, [])
  assert.equal(capture.decidePermission(a.type === 'permission' ? a.id : b.id, 'approve').ok, false, 'no pending entry is left')
})

test('hub mode: the full answer carries the archKey of the app-marked items', async (t) => {
  const { hubItem, hubSnap, startFakeHub, startProxy, OWN } = await import('./agent-proxy-helpers.mjs')
  const hub = await startFakeHub(t)
  hub.respond = () => [200, hubSnap('E:5', [hubItem(1, { owner: OWN, sessionId: 'idle' })])]
  const { queue, sessions } = setup()
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:5', []) })
  queue.watchSessions()
  const ask = async () => (await p.get('/v1/snapshot?watch=1')).json
  await ask(); await sessions.refresh(); await tick(); await tick()
  const snap = await ask()
  assert.equal(snap.open[0].archivable, true)
  assert.equal(snap.archKey, archKeyOf(snap.open))
  assert.ok(snap.archKey)
})

