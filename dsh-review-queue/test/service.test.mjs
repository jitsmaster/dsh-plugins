import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

function setup() {
  let t = 1000
  let n = 0
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const calls = []
  const capture = {
    answerQuestion: (id, answers) => { calls.push(['answer', id, answers]); return { ok: true } },
    decidePermission: (id, decision) => { calls.push(['decide', id, decision]); return { ok: true } },
  }
  // Like the real Remote method: refuses a call without a caller signal.
  const controller = { prompt: async (req, signal) => { if (!(signal instanceof AbortSignal)) throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')"); calls.push(['prompt', req]); return {} } }
  const queue = createReviewQueue({ store, capture, controllerOf: () => controller, now: () => 5000 })
  return { store, queue, calls }
}
const completed = (over = {}) => ({ type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'Did X. Then Y.', payload: { reply: 'r' }, ...over })

test('snapshot adds positions, spoken text and the server clock', () => {
  const { store, queue } = setup()
  store.add(completed({ sessionTitle: 'Old' }))
  store.add({ type: 'question', sessionId: 's2', sessionTitle: 'Two', payload: { questions: [{ id: 'q', question: 'Pick?', options: [{ label: 'A' }, { label: 'B' }] }] } })
  const snap = queue.snapshot()
  assert.equal(snap.serverNow, 5000)
  assert.deepEqual(snap.open.map((i) => i.position), [1, 2])
  assert.match(snap.open[0].spoken.headline, /^Item 1\. Done in Old/)
  assert.match(snap.open[1].spoken.headline, /^Item 2\. Question from Two: Pick\?/)
  assert.ok(snap.snapshotId)
})

test('onChange passes through and can be removed', () => {
  const { store, queue } = setup()
  let n = 0
  const off = queue.onChange(() => { n++ })
  store.add(completed())
  off()
  store.add(completed())
  assert.equal(n, 1)
})

test('answer, approve and deny delegate to capture and report its outcome', () => {
  const { store, queue, calls } = setup()
  const q = store.add({ type: 'question', sessionId: 's', payload: { questions: [] } })
  assert.deepEqual(queue.answer(q.id, [{ id: 'q', selected: ['A'] }]), { ok: true })
  const p = store.add({ type: 'permission', sessionId: 's', payload: {} })
  assert.deepEqual(queue.approve(p.id), { ok: true })
  assert.deepEqual(queue.deny(p.id), { ok: true })
  assert.deepEqual(calls.map((c) => c[0] + ':' + (c[2] === undefined ? '' : JSON.stringify(c[2]))), ['answer:[{"id":"q","selected":["A"]}]', 'decide:"approve"', 'decide:"deny"'])
})

test('markReviewed resolves a completed item, and only a completed item', () => {
  const { store, queue } = setup()
  const c = store.add(completed())
  const q = store.add({ type: 'question', sessionId: 's', payload: { questions: [] } })
  assert.deepEqual(queue.markReviewed(q.id), { ok: false, error: 'not-completed' })
  assert.deepEqual(queue.markReviewed(c.id), { ok: true })
  assert.equal(store.get(c.id).resolution.kind, 'reviewed')
  assert.deepEqual(queue.markReviewed(c.id), { ok: false, error: 'not-open' })
  assert.deepEqual(queue.markReviewed('nope'), { ok: false, error: 'not-open' })
})

test('reply sends a queued prompt to the item session and resolves the item as replied', async () => {
  const { store, queue, calls } = setup()
  const c = store.add(completed({ sessionId: 'sess-9' }))
  assert.deepEqual(await queue.reply(c.id, '  please add tests  '), { ok: true })
  const [, req] = calls.find((x) => x[0] === 'prompt')
  assert.equal(req.sessionId, 'sess-9')
  assert.equal(req.mode, 'queue')
  assert.deepEqual(req.content, [{ type: 'text', text: 'please add tests' }])
  assert.match(req.requestId, /^review-/)
  assert.equal(store.get(c.id).resolution.kind, 'replied')
})

test('reply refuses empty or oversized text, non-completed items and a missing controller', async () => {
  const { store, queue } = setup()
  const c = store.add(completed())
  assert.deepEqual(await queue.reply(c.id, '   '), { ok: false, error: 'empty' })
  assert.deepEqual(await queue.reply(c.id, 'x'.repeat(5000)), { ok: false, error: 'too-long' })
  const q = store.add({ type: 'question', sessionId: 's', payload: { questions: [] } })
  assert.deepEqual(await queue.reply(q.id, 'hi'), { ok: false, error: 'not-completed' })
  const bare = createReviewQueue({ store, capture: {}, controllerOf: () => undefined })
  assert.deepEqual(await bare.reply(c.id, 'hi'), { ok: false, error: 'no-controller' })
  assert.equal(store.get(c.id).status, 'open')
})

test('a failing prompt leaves the item open and reports the error', async () => {
  const { store } = setup()
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({ prompt: async () => { throw new Error('session closed') } }) })
  const c = store.add(completed())
  assert.deepEqual(await queue.reply(c.id, 'hi'), { ok: false, error: 'session closed' })
  assert.equal(store.get(c.id).status, 'open')
})

test('focus is shared state that voice and the screen both follow', () => {
  const { store, queue } = setup()
  const a = store.add(completed())
  let n = 0
  queue.onChange(() => { n++ })
  assert.equal(queue.getFocus(), undefined)
  queue.setFocus(a.id)
  assert.equal(queue.getFocus(), a.id)
  assert.equal(queue.snapshot().focusId, a.id)
  assert.equal(n, 1)
  store.resolve(a.id, { kind: 'reviewed' })
  assert.equal(queue.getFocus(), undefined)
})
