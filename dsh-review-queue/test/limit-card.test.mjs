import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createDismissals, createPausedTracker } from '../paused.js'
import { loadClient } from './client-todo-helpers.mjs'

// The pinned "Session limit reached" card (Task 2): ONE open paused item per app, payload.kinds ['limit-signin'], sessionId '' (the store takes any
// string; '' matches no real session). It is created while a limit card is open, counts waiting (not paused), and is never resumed like a session.
const cand = (id, kinds = ['limit'], over = {}) => ({
  sessionId: id, cwd: 'D:/w/' + id, title: 'T ' + id, lastWrite: 1000, kinds, reason: 'r', turn: 1, danglingCalls: [], pending: 0,
  lastUser: '', lastAssistant: '', ...over,
})
function setup(candidates = []) {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const scans = { result: { ok: true, candidates } }
  const tracker = createPausedTracker({ store, dismissals: createDismissals(), scan: async () => scans.result })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({ prompt: async () => {} }), speaker: { speak: () => ({ ok: true }), stop() {} }, paused: tracker })
  const set = (list) => { scans.result = { ok: true, candidates: list } }
  const pinned = () => store.snapshot().open.filter((i) => i.type === 'paused' && i.payload.kinds.includes('limit-signin'))
  return { store, tracker, queue, set, pinned }
}

test('limit card: one pinned item appears with count, default state idle and empty note; a second scan does not duplicate it', async () => {
  const { tracker, pinned } = setup([cand('a'), cand('b')])
  await tracker.scan()
  await tracker.scan()
  const [p, ...rest] = pinned()
  assert.equal(rest.length, 0)
  assert.deepEqual(p.payload.kinds, ['limit-signin'])
  assert.equal(p.payload.count, 2)
  assert.equal(p.payload.state, 'idle')
  assert.equal(p.payload.note, '')
  assert.equal(p.sessionId, '')
})

test('limit card: no pinned item for restart-paused or idle cards only', async () => {
  const { tracker, pinned } = setup([cand('a', ['open-turn']), cand('b', ['idle'])])
  await tracker.scan()
  assert.equal(pinned().length, 0)
})

test('limit card: count is updated in place when the number of limit cards changes', async () => {
  const { tracker, pinned, set } = setup([cand('a'), cand('b')])
  await tracker.scan()
  const id = pinned()[0].id
  set([cand('a'), cand('b'), cand('c')])
  await tracker.scan()
  assert.equal(pinned().length, 1)
  assert.equal(pinned()[0].id, id)
  assert.equal(pinned()[0].payload.count, 3)
})

test('limit card: resolved as recovered by scan when no limit card is left', async () => {
  const { tracker, store, pinned, set } = setup([cand('a')])
  await tracker.scan()
  const id = pinned()[0].id
  set([cand('x', ['open-turn'])])
  await tracker.scan()
  assert.equal(pinned().length, 0)
  assert.deepEqual({ kind: store.get(id).resolution.kind, by: store.get(id).resolution.by }, { kind: 'recovered', by: 'scan' })
})

test('limit card: a scan does not reset a state set by the run; setPinned updates state and note', async () => {
  const { tracker, pinned, set } = setup([cand('a')])
  await tracker.scan()
  assert.equal(tracker.setPinned({ state: 'awaiting-code', note: 'Check your email' }), true)
  set([cand('a'), cand('b')])
  await tracker.scan()
  assert.equal(pinned()[0].payload.state, 'awaiting-code')
  assert.equal(pinned()[0].payload.note, 'Check your email')
  assert.equal(pinned()[0].payload.count, 2)
  assert.equal(tracker.setPinned({ state: 'bogus' }), false)
  assert.equal(pinned()[0].payload.state, 'awaiting-code')
})

test('limit card: setPinned without an open pinned item is false', async () => {
  const { tracker } = setup([])
  await tracker.scan()
  assert.equal(tracker.setPinned({ state: 'opening' }), false)
})

test('limit card: dismissed stays dismissed while limit cards remain, and returns when all are gone and a new one appears', async () => {
  const { tracker, queue, pinned, set } = setup([cand('a')])
  await tracker.scan()
  assert.deepEqual(queue.dismissPaused(pinned()[0].id), { ok: true })
  await tracker.scan()
  set([cand('a'), cand('b')])
  await tracker.scan()
  assert.equal(pinned().length, 0)
  set([])
  await tracker.scan()
  set([cand('c')])
  await tracker.scan()
  assert.equal(pinned().length, 1)
})

test('limit card: resumePaused and holdItem refuse the pinned item', async () => {
  const { tracker, queue, pinned, store } = setup([cand('a')])
  await tracker.scan()
  const id = pinned()[0].id
  assert.deepEqual(await queue.resumePaused(id), { ok: false, error: 'not-a-session' })
  assert.equal(store.get(id).status, 'open')
  assert.equal((await queue.holdItem(id)).ok, false)
  assert.equal(store.get(id).status, 'open')
})

test('limit card: service count counts it once as waiting and not as a paused session', async () => {
  const { tracker, queue } = setup([cand('a'), cand('b'), cand('c', ['open-turn'])])
  await tracker.scan()
  const c = queue.count()
  assert.equal(c.total, 1)
  assert.equal(c.byType.paused, 3) // sessions only: two limit cards and one restart card
})

test('limit card: client stage table and counts (shared with the phone)', async () => {
  const { tracker, store } = setup([cand('a'), cand('b'), cand('c', ['open-turn'])])
  await tracker.scan()
  const { mod, T } = loadClient()
  const open = store.snapshot().open
  assert.equal(open.length, 4)
  assert.equal(T.pausedCount(open), 3)
  assert.equal(mod.shared.waitingCount(open), 1)
  const pin = open.find((i) => i.payload.kinds.includes('limit-signin'))
  assert.deepEqual([mod.shared.stageOf(pin).stage, mod.shared.stageOf(pin).waitsFor, mod.shared.stageOf(pin).counts], ['limit-signin', 'user', true])
  assert.equal(T.isSessionItem(pin), false)
  assert.equal(open.filter(T.isSessionItem).length, 3)
})

// Review 4: the store is persisted, a sign-in run is not. A pinned card restored mid-run (opening / awaiting-code / verifying) has no run behind it, so its
// Cancel and Submit answer no-run forever. The first scan of a new tracker (app start) resets such a state to idle; settled states are kept.
function restored(state, note = 'Check your email') {
  let n = 0
  const store = createStore({ uuid: () => 'r' + ++n })
  const item = store.add({ type: 'paused', sessionId: '', sessionTitle: 'Session limit reached', workspace: '', payload: { kinds: ['limit-signin'], count: 1, state, note } })
  const tracker = createPausedTracker({ store, dismissals: createDismissals(), scan: async () => ({ ok: true, candidates: [cand('a')] }) })
  return { store, tracker, id: item.id }
}

for (const state of ['awaiting-email', 'opening', 'awaiting-code', 'verifying']) {
  test('limit card: a pinned card restored in state ' + state + ' is reset to idle by the first scan', async () => {
    const { store, tracker, id } = restored(state)
    await tracker.scan()
    assert.equal(store.get(id).payload.state, 'idle')
    assert.equal(store.get(id).payload.note, '')
    assert.equal(store.get(id).status, 'open')
  })
}

for (const state of ['idle', 'signed-in', 'failed']) {
  test('limit card: a pinned card restored in settled state ' + state + ' is kept by the first scan', async () => {
    const { store, tracker, id } = restored(state, 'kept note')
    await tracker.scan()
    assert.equal(store.get(id).payload.state, state)
    assert.equal(store.get(id).payload.note, 'kept note')
  })
}

test('limit card: only the FIRST scan resets; a state set by a run afterwards survives later scans', async () => {
  const { store, tracker, id } = restored('verifying')
  await tracker.scan()
  assert.equal(tracker.setPinned({ state: 'awaiting-code', note: 'now' }), true)
  await tracker.scan()
  assert.equal(store.get(id).payload.state, 'awaiting-code')
  assert.equal(store.get(id).payload.note, 'now')
})

// Final AI-pitfall review: a sign-in run is live in this process (limitRunning() true). The scan must not resolve the pinned card under it
// (the run's logout makes every limit session look recovered), and the first-scan reset must not touch a state a live run owns.
function live(state, candidates, isLive) {
  let n = 0
  const store = createStore({ uuid: () => 'l' + ++n })
  const item = store.add({ type: 'paused', sessionId: '', sessionTitle: 'Session limit reached', workspace: '', payload: { kinds: ['limit-signin'], count: 1, state, note: 'code box' } })
  const tracker = createPausedTracker({ store, dismissals: createDismissals(), limitRunning: isLive, scan: async () => ({ ok: true, candidates }) })
  return { store, tracker, id: item.id }
}

test('limit card: a scan with no limit card left keeps the pinned card open while a sign-in run is live', async () => {
  let running = true
  const { store, tracker, id } = live('awaiting-code', [], () => running)
  await tracker.scan()
  assert.equal(store.get(id).status, 'open')
  assert.equal(store.get(id).payload.state, 'awaiting-code')
  assert.equal(store.get(id).payload.note, 'code box')
  running = false
  await tracker.scan()
  assert.notEqual(store.get(id).status, 'open')
})

test('limit card: the first-scan reset skips a pinned card whose sign-in run is live', async () => {
  const { store, tracker, id } = live('verifying', [cand('a')], () => true)
  await tracker.scan()
  assert.equal(store.get(id).payload.state, 'verifying')
  assert.equal(store.get(id).payload.note, 'code box')
})

test('limit card: with no live run the scan behaves as before (resolves, resets)', async () => {
  const gone = live('awaiting-code', [], () => false)
  await gone.tracker.scan()
  assert.notEqual(gone.store.get(gone.id).status, 'open')
  const stale = live('verifying', [cand('a')], () => false)
  await stale.tracker.scan()
  assert.equal(stale.store.get(stale.id).payload.state, 'idle')
})
