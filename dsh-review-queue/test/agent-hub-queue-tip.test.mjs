import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHubQueue } from '../agent/hub-queue.js'

// The hub queue keeps the tip with the local service (it is this app's model and speaker), whatever the mode.
function make(connected = true) {
  const listeners = new Set()
  const local = {
    tip: () => ({ id: 't1' }), stopTip: () => { local.stopped++ ; return { ok: true } }, stopped: 0, watched: 0, watchSessions: () => { local.watched++ }, snapshotArgs: [], tipDeeper: (id) => ({ ok: true, deeper: id }), tipTodo: (id, ws, opts) => ({ ok: true, id, ws, ...(opts ? { opts } : {}) }), readTip: (id) => ({ ok: true, from: 'local', id }), readingId: () => localReading, tipSurvey: (id, ws) => { local.surveyCalls.push([id, ws]); return { ok: true, survey: { id: 's1', tipId: id, workspaceId: ws } } }, surveyCalls: [], tipSurveyState: () => ({ ok: true, surveys: [] }),
    snapshot: (opts) => { local.snapshotArgs.push(opts); return { snapshotId: 'L', open: [], resolved: [], reading: localReading, tip: { id: 't1' }, ...(localSurvey ? { tipSurvey: localSurvey } : {}) } },
    onChange: (l) => { listeners.add(l); return () => listeners.delete(l) }, stop: () => ({ ok: true }), uiState: () => ({ seq: 0 }),
  }
  let localReading
  let localSurvey
  let hubWorkspaces = []
  let mirrorSnap = connected ? { snapshotId: 'e:1', open: [], resolved: [] } : undefined
  const mirrorListeners = new Set()
  const client = {
    state: connected ? 'connected' : 'stopped',
    mirror: { ready: connected, snapshot: () => mirrorSnap, workspaces: () => hubWorkspaces, onChange: (l) => { mirrorListeners.add(l); return () => mirrorListeners.delete(l) } },
    instanceId: 'ab12', onState: () => () => {}, call: async () => ({ ok: true }),
  }
  const queue = createHubQueue({ local, client, speaker: { speak: () => ({ ok: true }), stop() {} }, controllerOf: () => ({}) })
  return { queue, local, setHubWorkspaces: (list) => { hubWorkspaces = list }, setReading: (v) => { localReading = v }, setSurvey: (v) => { localSurvey = v }, setMirror: (snap) => { mirrorSnap = snap; mirrorListeners.forEach((l) => l()) } }
}

test('tip() and readTip() go to the local service in hub mode', () => {
  const { queue } = make(true)
  assert.deepEqual(queue.tip(), { id: 't1' })
  assert.deepEqual(queue.readTip('t1'), { ok: true, from: 'local', id: 't1' })
})

test('the snapshot of the hub view shows a tip being read here as reading, and only a tip', () => {
  const { queue, setReading } = make(true)
  assert.equal(queue.snapshot().reading, undefined)
  setReading('tip:t1')
  assert.equal(queue.snapshot().reading, 'tip:t1')
  setReading('some-item-id')
  assert.equal(queue.snapshot().reading, undefined, 'an item read by the local service is not the hub view reading')
})

test('a held (On hold) item of any app does not end the reading of the tip: only a waiting item does', () => {
  const { local, setMirror } = make(true)
  const base = { seq: 1, status: 'open', createdAt: 1, sessionId: 's', summary: 'x', payload: {}, owner: 'bbbb2222' }
  setMirror({ snapshotId: 'e:2', open: [{ ...base, id: 'h', type: 'onhold' }], resolved: [] })
  assert.equal(local.stopped, 0, 'only held: keep reading')
  setMirror({ snapshotId: 'e:3', open: [{ ...base, id: 'h', type: 'onhold' }, { ...base, id: 'a', seq: 2, type: 'completed' }], resolved: [] })
  assert.equal(local.stopped, 1)
})

test('the hub view itself carries no tip and no sessions of its own (the hub and the proxy supply them)', () => {
  const { queue } = make(true)
  const snap = queue.snapshot()
  assert.ok(!('tip' in snap))
  assert.ok(!('sessions' in snap))
})

test('without a hub the local snapshot (tip included) is served', () => {
  const { queue } = make(false)
  assert.equal(queue.snapshot().tip.id, 't1')
})

test('the snapshot options reach the local service (tip, watch) when there is no hub', () => {
  const { queue, local } = make(false)
  queue.snapshot({ tip: true, watch: true })
  assert.deepEqual(local.snapshotArgs.at(-1), { tip: true, watch: true })
})

test('watchSessions goes to the local service', () => {
  const { queue, local } = make(true)
  queue.watchSessions()
  assert.equal(local.watched, 1)
})

test('a tip being read stops when the merged hub list stops being empty, even though the local store has nothing', () => {
  const { queue, local, setMirror } = make(true)
  queue.snapshot() // the hub view is active
  setMirror({ snapshotId: 'e:2', open: [], resolved: [] })
  assert.equal(local.stopped, 0, 'still empty: keep reading')
  setMirror({ snapshotId: 'e:3', open: [{ id: 'a', seq: 1, type: 'completed', status: 'open', createdAt: 1, sessionId: 's', summary: 'x', payload: {}, owner: 'bbbb2222' }], resolved: [] })
  assert.equal(local.stopped, 1)
})

test('tipDeeper() and tipTodo() go to the local service in hub mode (its own model, never the hub)', () => {
  const { queue } = make(true)
  assert.deepEqual(queue.tipDeeper('t1'), { ok: true, deeper: 't1' })
  assert.deepEqual(queue.tipTodo('t1', 'w1'), { ok: true, id: 't1', ws: 'w1' })
})

test('in hub mode a workspace of the hub list (id "<app>/<id>") is drafted from its listed title, which the local registry does not know', () => {
  const { queue, setHubWorkspaces } = make(true)
  setHubWorkspaces([{ id: 'ab12/w1', title: 'Alpha (Laptop)' }, { id: 'cd34/w2', title: 'Beta' }])
  assert.deepEqual(queue.tipTodo('t1', 'ab12/w1'), { ok: true, id: 't1', ws: 'ab12/w1', opts: { title: 'Alpha (Laptop)' } })
  assert.deepEqual(queue.tipTodo('t1', 'cd34/w2'), { ok: true, id: 't1', ws: 'cd34/w2', opts: { title: 'Beta' } })
})

test('in hub mode an id that is not in the hub list gets no title (the local service refuses it)', () => {
  const { queue, setHubWorkspaces } = make(true)
  setHubWorkspaces([{ id: 'ab12/w1', title: 'Alpha' }])
  assert.deepEqual(queue.tipTodo('t1', 'zzzz/w9'), { ok: true, id: 't1', ws: 'zzzz/w9' })
  assert.deepEqual(queue.tipTodo('t1', undefined), { ok: true, id: 't1', ws: undefined })
})

test('without a hub no title is passed: the local registry is the only source', () => {
  const { queue, setHubWorkspaces } = make(false)
  setHubWorkspaces([{ id: 'ab12/w1', title: 'Alpha' }])
  assert.deepEqual(queue.tipTodo('t1', 'ab12/w1'), { ok: true, id: 't1', ws: 'ab12/w1' })
})

test('tipSurvey() in hub mode: a bare id is passed as is, the own "<instanceId>/<id>" has the prefix stripped', () => {
  const { queue, local, setHubWorkspaces } = make(true)
  setHubWorkspaces([{ id: 'ab12/w1', title: 'Alpha (Laptop)' }])
  assert.deepEqual(queue.tipSurvey('t1', 'w1'), { ok: true, survey: { id: 's1', tipId: 't1', workspaceId: 'w1' } })
  assert.deepEqual(queue.tipSurvey('t1', 'ab12/w1'), { ok: true, survey: { id: 's1', tipId: 't1', workspaceId: 'w1' } })
  assert.deepEqual(local.surveyCalls, [['t1', 'w1'], ['t1', 'w1']])
  assert.deepEqual(queue.tipSurveyState(), { ok: true, surveys: [] })
})

test('tipSurvey() in hub mode refuses a workspace of another app with other-app, and the local service is not called', () => {
  const { queue, local, setHubWorkspaces } = make(true)
  setHubWorkspaces([{ id: 'cd34/w2', title: 'Beta' }])
  assert.deepEqual(queue.tipSurvey('t1', 'cd34/w2'), { ok: false, error: 'other-app' })
  assert.deepEqual(local.surveyCalls, [])
})

test('tipSurvey() without a hub passes the id unchanged, whatever it looks like', () => {
  const { queue, local } = make(false)
  queue.tipSurvey('t1', 'w1')
  queue.tipSurvey('t1', 'ab12/w1')
  queue.tipSurvey('t1', 'cd34/w2')
  assert.deepEqual(local.surveyCalls, [['t1', 'w1'], ['t1', 'ab12/w1'], ['t1', 'cd34/w2']])
})

test('the tipSurvey field of the local snapshot survives the hub snapshot merge (the card works in hub mode), and is absent when the local one has none', () => {
  const { queue, setSurvey } = make(true)
  queue.snapshot() // the hub view is active
  assert.ok(!('tipSurvey' in queue.snapshot()))
  setSurvey([{ id: 's1', state: 'running' }])
  assert.deepEqual(queue.snapshot().tipSurvey, [{ id: 's1', state: 'running' }])
})
test('in hub mode the survey records of the snapshot carry "<instanceId>/<workspaceId>" (a copy; an already prefixed id is kept; the local objects are not mutated)', () => {
  const { queue, setSurvey } = make(true)
  const rec = { id: 's1', workspaceId: 'w1', state: 'running' }
  const done = { id: 's2', workspaceId: 'ab12/w2', state: 'ready' }
  setSurvey([rec, done])
  const got = queue.snapshot().tipSurvey
  assert.deepEqual(got.map((r) => r.workspaceId), ['ab12/w1', 'ab12/w2'])
  assert.equal(rec.workspaceId, 'w1', 'the local record is untouched')
})

test('without a hub the survey records keep the bare workspaceId', () => {
  const { queue, setSurvey } = make(false)
  setSurvey([{ id: 's1', workspaceId: 'w1', state: 'running' }])
  assert.equal(queue.snapshot().tipSurvey[0].workspaceId, 'w1')
})

test('tipSurveyState() maps the workspaceId the same way in hub mode only', () => {
  const hub = make(true)
  hub.local.tipSurveyState = () => ({ ok: true, surveys: [{ id: 's1', workspaceId: 'w1' }] })
  assert.deepEqual(hub.queue.tipSurveyState(), { ok: true, surveys: [{ id: 's1', workspaceId: 'ab12/w1' }] })
  const plain = make(false)
  plain.local.tipSurveyState = () => ({ ok: true, surveys: [{ id: 's1', workspaceId: 'w1' }] })
  assert.deepEqual(plain.queue.tipSurveyState(), { ok: true, surveys: [{ id: 's1', workspaceId: 'w1' }] })
})
