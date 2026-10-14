import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// next() and openTarget() back the voice commands "read the next one" and "open the first item's session".
function setup({ speak } = {}) {
  let t = 1000
  let n = 0
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const spoken = []
  const speaker = {
    speak: speak ?? ((chunks) => { spoken.push(chunks); return { ok: true } }),
    stop: () => {},
  }
  const capture = { answerQuestion: () => ({ ok: true }), decidePermission: () => ({ ok: true }), lateAnswerQuestion: async () => ({ ok: true }) }
  const queue = createReviewQueue({ store, capture, controllerOf: () => ({}), speaker, now: () => 5000 })
  return { store, queue, spoken }
}
const completed = (title, sessionId = 's-' + title) => ({ type: 'completed', sessionId, sessionTitle: 'S ' + title, title, summary: 'Did ' + title + '.', payload: { reply: 'reply ' + title } })

test('next() with nothing read yet reads the first open item', () => {
  const { store, queue, spoken } = setup()
  const a = store.add(completed('alpha'))
  store.add(completed('beta'))
  assert.deepEqual(queue.next(), { ok: true, id: a.id })
  assert.equal(spoken.length, 1)
  assert.equal(queue.getFocus(), a.id)
})

test('next() reads the open item after the last one read, in current order', () => {
  const { store, queue } = setup()
  store.add(completed('alpha'))
  const b = store.add(completed('beta'))
  const c = store.add(completed('gamma'))
  assert.equal(queue.readPosition(1).ok, true)
  assert.deepEqual(queue.next(), { ok: true, id: b.id })
  assert.deepEqual(queue.next(), { ok: true, id: c.id })
})

test('next() after the last item is no-item and names the missing position', () => {
  const { store, queue } = setup()
  store.add(completed('alpha'))
  store.add(completed('beta'))
  queue.readPosition(2)
  assert.deepEqual(queue.next(), { ok: false, error: 'no-item', n: 3 })
})

test('next() on an empty list is empty', () => {
  const { queue } = setup()
  assert.deepEqual(queue.next(), { ok: false, error: 'empty' })
})

test('next() starts from the first item when the last one read has left the list', () => {
  const { store, queue } = setup()
  const a = store.add(completed('alpha'))
  const b = store.add(completed('beta'))
  queue.readPosition(1)
  store.resolve(a.id, { kind: 'reviewed', by: 'card' })
  assert.deepEqual(queue.next(), { ok: true, id: b.id })
})

test('next() follows the order after an item above the last-read one was resolved', () => {
  const { store, queue } = setup()
  const a = store.add(completed('alpha'))
  const b = store.add(completed('beta'))
  const c = store.add(completed('gamma'))
  queue.readPosition(2)
  store.resolve(a.id, { kind: 'reviewed', by: 'card' })
  assert.deepEqual(queue.next(), { ok: true, id: c.id })
  assert.notEqual(b.id, c.id)
})

test('next() passes a speaker failure through', () => {
  const { store, queue } = setup({ speak: () => ({ ok: false, error: 'muted' }) })
  store.add(completed('alpha'))
  assert.deepEqual(queue.next(), { ok: false, error: 'muted' })
})

test('openTarget() is the first open item session and its card title', () => {
  const { store, queue } = setup()
  store.add(completed('alpha', 'sess-1'))
  store.add(completed('beta', 'sess-2'))
  assert.deepEqual(queue.openTarget(), { sessionId: 'sess-1', title: 'alpha' })
})

test('openTarget() is undefined when nothing waits', () => {
  const { store, queue } = setup()
  assert.equal(queue.openTarget(), undefined)
  const a = store.add(completed('alpha'))
  store.resolve(a.id, { kind: 'reviewed', by: 'card' })
  assert.equal(queue.openTarget(), undefined)
})

test('openTarget() titles a question item the way the card does', () => {
  const { store, queue } = setup()
  store.add({ type: 'question', sessionId: 'q-sess', payload: { questions: [{ id: 'q', header: 'Which database', question: 'Pick one?', options: [] }] } })
  assert.deepEqual(queue.openTarget(), { sessionId: 'q-sess', title: 'Which database' })
})
