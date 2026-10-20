import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHubQueue } from '../agent/hub-queue.js'

// The hub queue keeps the tip with the local service (it is this app's model and speaker), whatever the mode.
function make(connected = true) {
  const listeners = new Set()
  const local = {
    tip: () => ({ id: 't1' }), stopTip: () => { local.stopped++ ; return { ok: true } }, stopped: 0, watched: 0, watchSessions: () => { local.watched++ }, snapshotArgs: [], readTip: (id) => ({ ok: true, from: 'local', id }), readingId: () => localReading,
    snapshot: (opts) => { local.snapshotArgs.push(opts); return { snapshotId: 'L', open: [], resolved: [], reading: localReading, tip: { id: 't1' } } },
    onChange: (l) => { listeners.add(l); return () => listeners.delete(l) }, stop: () => ({ ok: true }), uiState: () => ({ seq: 0 }),
  }
  let localReading
  let mirrorSnap = connected ? { snapshotId: 'e:1', open: [], resolved: [] } : undefined
  const mirrorListeners = new Set()
  const client = {
    state: connected ? 'connected' : 'stopped',
    mirror: { ready: connected, snapshot: () => mirrorSnap, workspaces: () => [], onChange: (l) => { mirrorListeners.add(l); return () => mirrorListeners.delete(l) } },
    onState: () => () => {}, call: async () => ({ ok: true }),
  }
  const queue = createHubQueue({ local, client, speaker: { speak: () => ({ ok: true }), stop() {} }, controllerOf: () => ({}) })
  return { queue, local, setReading: (v) => { localReading = v }, setMirror: (snap) => { mirrorSnap = snap; mirrorListeners.forEach((l) => l()) } }
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
