import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHubQueue } from '../agent/hub-queue.js'

const METHODS = ['snapshot', 'count', 'first', 'readPosition', 'again', 'next', 'openTarget', 'read', 'stop', 'getFocus', 'setFocus', 'answer', 'lateAnswer', 'approve', 'approveSimilar', 'deny', 'markReviewed', 'reply', 'archive', 'reopen', 'addTodo', 'confirmTodo', 'cancelTodo', 'workspaces', 'notifyPrMerged', 'todoIdle', 'uiCommand']

function fakeLocal() {
  const calls = []
  const listeners = new Set()
  const local = Object.fromEntries(METHODS.map((m) => [m, (...args) => { calls.push([m, ...args]); return { ok: true, from: 'local' } }]))
  local.onChange = (l) => { listeners.add(l); return () => listeners.delete(l) }
  return Object.assign(local, { calls, fire: () => listeners.forEach((l) => l()) })
}
function fakeClient() {
  const listeners = new Set()
  const stateListeners = new Set()
  const c = {
    state: 'connected', calls: [], replies: {},
    mirror: { ready: true, snap: undefined, ws: [], snapshot: () => c.mirror.snap, workspaces: () => c.mirror.ws, onChange: (l) => { listeners.add(l); return () => listeners.delete(l) } },
    onState: (l) => { stateListeners.add(l); return () => stateListeners.delete(l) },
    call: async (kind, body) => { c.calls.push([kind, body]); return c.replies[kind] ?? { ok: true, from: 'hub' } },
    setSnap(snap) { c.mirror.snap = snap; listeners.forEach((l) => l()) },
    setState(state) { c.state = state; stateListeners.forEach((l) => l(state)) },
  }
  return c
}
const item = (id, seq, over = {}) => ({ id, seq, type: 'completed', status: 'open', createdAt: 100 + seq, sessionId: 's' + seq, sessionTitle: 'Session ' + seq, summary: 'Did ' + seq, payload: { reply: 'reply ' + seq }, owner: 'bbbb2222', ownerLabel: 'DSH :2', ownerState: 'online', ...over })
const snap = (id, open, resolved = []) => ({ snapshotId: id, open: open.map((i, n) => ({ ...i, position: n + 1 })), resolved })
function make() {
  const local = fakeLocal()
  const client = fakeClient()
  const spoken = []
  const speaker = { speak: (chunks) => { spoken.push(chunks); return { ok: true } }, stop: () => {} }
  const queue = createHubQueue({ local, client, speaker, controllerOf: () => ({}), now: () => 5000 })
  client.setSnap(snap('e:1', [item('a', 1, { owner: 'aaaa1111', ownerLabel: 'DSH :1' }), item('b', 2)]))
  return { local, client, queue, spoken }
}

test('connected: reads come from the mirror, in hub order with global positions, and carry the owner', () => {
  const { queue, local } = make()
  const s = queue.snapshot()
  assert.equal(s.snapshotId, 'e:1')
  assert.deepEqual(s.open.map((i) => [i.id, i.position, i.ownerLabel, typeof i.title, typeof i.spoken.headline]), [['a', 1, 'DSH :1', 'string', 'string'], ['b', 2, 'DSH :2', 'string', 'string']])
  assert.deepEqual(queue.count(), { total: 2, byType: { question: 0, permission: 0, completed: 2, 'pr-merged': 0, todo: 0, paused: 0 } })
  assert.equal(queue.first().id, 'a')
  assert.equal(queue.openTarget().sessionId, 's1')
  assert.deepEqual(local.calls, [])
})

test('reading and focus work on any item of the mirror, because the speakers and the screen are here', () => {
  const { queue, spoken, client } = make()
  assert.deepEqual(queue.readPosition(2), { ok: true, id: 'b' })
  assert.equal(spoken.length, 1)
  assert.equal(queue.getFocus(), 'b')
  assert.equal(queue.snapshot().focusId, 'b')
  assert.deepEqual(queue.next(), { ok: false, error: 'no-item', n: 3 })
  client.setSnap(snap('e:2', [item('a', 1)]))
  assert.equal(queue.getFocus(), undefined, 'the focused item left the queue')
})

test('actions go through the hub and the answer of the hub is returned', async () => {
  const { queue, client, local } = make()
  const answers = [{ id: 'q', selected: ['x'] }]
  const table = [
    [() => queue.answer('a', answers), 'answer', { id: 'a', answers }],
    [() => queue.lateAnswer('a', answers), 'late-answer', { id: 'a', answers }],
    [() => queue.approve('a'), 'approve', { id: 'a' }],
    [() => queue.approve('a', { via: 'phone', confirmed: true, held: true }), 'approve', { id: 'a', confirmed: true, held: true }],
    [() => queue.approveSimilar('a'), 'approve-similar', { id: 'a' }],
    [() => queue.deny('a'), 'deny', { id: 'a' }],
    [() => queue.markReviewed('a'), 'reviewed', { id: 'a' }],
    [() => queue.reopen('a'), 'reopen', { id: 'a' }],
    [() => queue.reply('a', 'hi'), 'reply', { id: 'a', text: 'hi' }],
    [() => queue.archive('a'), 'archive', { id: 'a' }],
    [() => queue.addTodo('do it', { workspaceId: 'aaaa/w1', sparc: true }), 'todo', { text: 'do it', workspaceId: 'aaaa/w1', sparc: true }],
    [() => queue.confirmTodo('t1', { workspaceId: 'bbbb/w1' }), 'todo-confirm', { id: 't1', workspaceId: 'bbbb/w1' }],
    [() => queue.cancelTodo('t1'), 'todo-cancel', { id: 't1' }],
  ]
  for (const [run, kind, body] of table) {
    const result = await run()
    assert.deepEqual(result, { ok: true, from: 'hub' }, kind)
    assert.deepEqual(client.calls.at(-1), [kind, body], kind)
  }
  assert.deepEqual(local.calls, [])
  client.replies.deny = { ok: false, error: 'owner-away' }
  assert.deepEqual(await queue.deny('a'), { ok: false, error: 'owner-away' })
})

test('what only this app can do stays local: a merged PR, the todo background work, the show/hide command', () => {
  const { queue, local } = make()
  queue.notifyPrMerged({ prId: '1' }); queue.todoIdle(); queue.uiCommand('show')
  assert.deepEqual(local.calls.map((c) => c[0]), ['notifyPrMerged', 'todoIdle', 'uiCommand'])
})

test('show/hide commands given to the local service show in the mirror view, which shares its state', () => {
  const { queue, local } = make()
  const ui = { seq: 0, cmd: undefined }
  local.uiState = () => ui
  const shared = createHubQueue({ local, client: { state: 'connected', mirror: { ready: true, snapshot: () => snap('e:1', [item('a', 1)]), workspaces: () => [] }, call: async () => ({}) }, now: () => 5000 })
  assert.deepEqual(shared.snapshot().ui, { seq: 0, cmd: undefined })
  ui.seq = 3; ui.cmd = 'show'
  assert.deepEqual(shared.snapshot().ui, { seq: 3, cmd: 'show' })
  assert.deepEqual(queue.snapshot().ui, { seq: 0, cmd: undefined }, 'a local without a shared state keeps the default')
})

test('the workspaces are the union the hub reports', () => {
  const { queue, client } = make()
  client.mirror.ws = [{ id: 'aaaa/w1', title: 'alpha' }]
  assert.deepEqual(queue.workspaces(), [{ id: 'aaaa/w1', title: 'alpha' }])
})

test('degraded (hub unreachable, upgrade needed, mirror not ready): the local service answers everything', async () => {
  const { queue, client, local } = make()
  for (const mode of ['degraded', 'upgrade-required', 'connecting']) {
    local.calls.length = 0
    client.state = mode
    assert.deepEqual(queue.snapshot(), { ok: true, from: 'local' }, mode)
    assert.deepEqual(await queue.approve('a', { via: 'desktop' }), { ok: true, from: 'local' }, mode)
    assert.deepEqual(queue.workspaces(), { ok: true, from: 'local' }, mode)
    assert.deepEqual(local.calls.map((c) => c[0]), ['snapshot', 'approve', 'workspaces'], mode)
  }
  client.state = 'connected'
  client.mirror.ready = false
  assert.deepEqual(queue.count(), { ok: true, from: 'local' })
  assert.equal(client.calls.length, 0)
})

test('listeners hear a new mirror snapshot, a local change and a change of mode, until they unsubscribe', () => {
  const { queue, client, local } = make()
  let heard = 0
  const off = queue.onChange(() => heard++)
  client.setSnap(snap('e:2', [item('a', 1)]))
  local.fire()
  client.setState('degraded')
  assert.equal(heard, 3)
  off()
  client.setSnap(snap('e:3', []))
  assert.equal(heard, 3)
})

test('a result the hub could not deliver is a refusal the caller can show, never a thrown error', async () => {
  const { queue, client } = make()
  client.call = async () => { throw new Error('socket hang up') }
  assert.deepEqual(await queue.deny('a'), { ok: false, error: 'hub-unreachable' })
})

test('runningSessions is this app\'s own question: asked of the local service in every mode, never of the hub', async () => {
  const { queue, local, client } = make()
  local.runningSessions = async () => ({ ok: true, ids: ['s1'], from: 'local' })
  assert.deepEqual(await queue.runningSessions(), { ok: true, ids: ['s1'], from: 'local' })
  client.setState('degraded')
  assert.deepEqual(await queue.runningSessions(), { ok: true, ids: ['s1'], from: 'local' })
  assert.deepEqual(client.calls, [])
})
