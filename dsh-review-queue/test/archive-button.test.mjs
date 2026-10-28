import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createSessionCounter } from '../sessions.js'
import { hubItem, hubSnap, startFakeHub, startProxy, OWN } from './agent-proxy-helpers.mjs'

// The one-click "Archive session" button on every open row: the server decides (item.archivable on the open items of the snapshot).
const tick = () => new Promise((r) => setImmediate(r))
function setup({ running = ['run'], verdict = () => ({ protected: false }), items } = {}) {
  const store = createStore()
  const state = { running: [...running], checks: [] }
  const controller = { list: async () => ({ items: (items ?? ['run', 'idle', 'pr']).map((sessionId) => ({ sessionId, running: state.running.includes(sessionId), updatedAt: 1, blank: false })) }) }
  const sessions = createSessionCounter({ controllerOf: () => controller })
  const guard = { check: async (id) => { state.checks.push(id); return verdict(id) } }
  const registry = { archivedSessionIds: [], archiveSession: async () => {} }
  const queue = createReviewQueue({ store, capture: {}, log: () => {}, sessions, registryOf: () => registry, prGuardOf: () => guard })
  const snap = async () => { queue.snapshot({ watch: true }); await sessions.refresh(); await tick(); await tick(); return queue.snapshot({ watch: true }) }
  return { store, queue, state, snap, sessions }
}
const flagOf = (s, id) => s.open.find((i) => i.id === id).archivable === true

test('unknown state is not archivable; once the running list and the PR verdict are known an idle session is', async () => {
  const { store, queue, snap } = setup()
  const q = store.add({ type: 'question', sessionId: 'idle', sessionTitle: 'T' })
  assert.equal(flagOf(queue.snapshot({ watch: true }), q.id), false, 'nothing is known on the first snapshot')
  assert.equal(flagOf(await snap(), q.id), true)
})

test('a session with a turn running is not archivable, an idle one with a pending question or permission is', async () => {
  const { store, snap } = setup()
  const running = store.add({ type: 'permission', sessionId: 'run', tool: 'Bash', input: {} })
  const asking = store.add({ type: 'question', sessionId: 'idle' })
  const done = store.add({ type: 'completed', sessionId: 'idle' })
  const s = await snap()
  assert.equal(flagOf(s, running.id), false)
  assert.equal(flagOf(s, asking.id), true)
  assert.equal(flagOf(s, done.id), true)
})

test('a PR session whose PR is still open is not archivable; a merged one is', async () => {
  const { store, snap } = setup({ verdict: (id) => (id === 'pr' ? { protected: true, prId: '7' } : { protected: false }) })
  const open = store.add({ type: 'completed', sessionId: 'pr' })
  const other = store.add({ type: 'completed', sessionId: 'idle' })
  const s = await snap()
  assert.equal(flagOf(s, open.id), false)
  assert.equal(flagOf(s, other.id), true)
})

test('todos and items without a session are never archivable, and the flag is only on open items', async () => {
  const { store, snap } = setup()
  const todo = store.add({ type: 'todo', text: 'x' })
  const bare = store.add({ type: 'completed' })
  const done = store.add({ type: 'completed', sessionId: 'idle' })
  store.resolve(done.id, { kind: 'reviewed', by: 'card' })
  const s = await snap()
  assert.equal(flagOf(s, todo.id), false)
  assert.equal(flagOf(s, bare.id), false)
  assert.equal(s.resolved.find((i) => i.id === done.id).archivable, undefined)
})

test('the guard is asked once per session within its short cache, not once per snapshot', async () => {
  const { store, snap, state } = setup()
  store.add({ type: 'completed', sessionId: 'idle' })
  await snap(); await snap(); await snap()
  assert.equal(state.checks.length, 1)
})

test('without the guard plugin an idle session is archivable; a session that starts running loses the flag', async () => {
  const store = createStore()
  const run = { v: false }
  const controller = { list: async () => ({ items: [{ sessionId: 's', running: run.v, updatedAt: 1, blank: false }] }) }
  const sessions = createSessionCounter({ controllerOf: () => controller, ttlMs: 0 })
  const queue = createReviewQueue({ store, capture: {}, log: () => {}, sessions, registryOf: () => ({}) })
  const it = store.add({ type: 'completed', sessionId: 's' })
  queue.snapshot({ watch: true }); await sessions.refresh(); await tick(); await tick()
  assert.equal(flagOf(queue.snapshot({ watch: true }), it.id), true)
  await tick(); run.v = true; await sessions.refresh()
  assert.equal(flagOf(queue.snapshot({ watch: true }), it.id), false)
})

test('the counter lists the running ids without changing its numbers', async () => {
  const { sessions, snap, store } = setup({ running: ['run'] })
  store.add({ type: 'completed', sessionId: 'idle' })
  await snap()
  assert.deepEqual([...sessions.runningIds()], ['run'])
  assert.deepEqual(sessions.current(), { working: 1, open: 3 })
})

// ---- the desktop overlay card
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')
const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) })
function load() {
  let registered
  const calls = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    fetch: async (url, init) => { calls.push([url, init && init.body ? JSON.parse(init.body) : undefined]); return { ok: true, status: 200, json: async () => ({ ok: true }) } },
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: el, Fragment: Symbol('Fragment'), useState: (v) => [v, () => {}], useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  return { T: registered.factory(() => stubReact).__test, calls }
}
const findAll = (node, pred) => (node && typeof node === 'object' ? [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))] : [])
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''))
const archiveButtons = (tree) => findAll(tree, (n) => n.type === 'button' && /^(Archive session|Archiving…)$/.test(text(n)))
const item = (over = {}) => ({ id: 'i1', type: 'completed', status: 'open', position: 1, sessionId: 's1', sessionTitle: 'Work', createdAt: 1, archivable: true, ...over })

test('card: an archivable item shows one Archive session button that posts /v1/archive-session at once and advances', async () => {
  const { T, calls } = load()
  T.state.snap = { snapshotId: 'e:1', open: [item()], resolved: [] }
  const buttons = archiveButtons(T.Card({ item: item(), forceFull: true }))
  assert.equal(buttons.length, 1)
  buttons[0].props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls, [['/review-queue/v1/archive-session', { id: 'i1' }]])
})

test('card: hidden when not archivable, for todos, and no duplicate on archive / pr-merged cards', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  assert.equal(archiveButtons(T.Card({ item: item({ archivable: undefined }), forceFull: true })).length, 0)
  assert.equal(archiveButtons(T.Card({ item: item({ type: 'todo' }), forceFull: true })).length, 0)
  for (const type of ['archive', 'pr-merged']) {
    const tree = T.Card({ item: item({ type }), forceFull: true })
    assert.equal(archiveButtons(tree).length, 0, type + ' has its own button inside its body component')
  }
  assert.equal(archiveButtons(T.Card({ item: item({ type: 'question' }), forceFull: true })).length, 1)
})

// ---- the phone
test('phone: the conversation Archive button honours item.archivable for open items and keeps its confirm sheet', () => {
  const views = readFileSync(new URL('../lib/mobile/views.js', import.meta.url), 'utf8')
  const fn = views.slice(views.indexOf('function ArchiveSessionButton'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.match(body, /archivable/)
  assert.match(body, /<\$\{Sheet\}/)
})

// ---- hub mode: the hub's items have no flag; the agent adds it to its own items only
test('hub mode: the flag is added to this apps own idle items and never to another apps, a stale flag from the hub is dropped', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, hubSnap('E:5', [hubItem(1, { owner: OWN, sessionId: 'idle' }), hubItem(2, { owner: OWN, sessionId: 'run' }), hubItem(3, { owner: 'bbbb2222', sessionId: 'idle', archivable: true })])]
  const { queue, sessions } = setup()
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:5', []) })
  queue.watchSessions() // the hub tells the app that somebody looks (sessionsWatch)
  const ask = async () => (await p.get('/v1/snapshot?watch=1')).json
  await ask(); await sessions.refresh(); await tick(); await tick()
  const snap = await ask()
  const flags = snap.open.map((i) => [i.sessionId + '/' + i.owner, i.archivable === true])
  assert.deepEqual(flags, [['idle/' + OWN, true], ['run/' + OWN, false], ['idle/bbbb2222', false]])
})
