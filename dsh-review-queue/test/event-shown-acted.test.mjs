// Slice 2: `shown` (first time in view) and `acted` (user acted, with the rank at that moment) events. Ids, types and ranks only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReviewQueue } from '../service.js'
import { createStore } from '../store.js'

function make() {
  const rows = []
  let n = 0
  const store = createStore({ uuid: () => 'id' + ++n, events: { record: (e) => { rows.push(e); return true } } })
  const q = createReviewQueue({ store, capture: {}, controllerOf: () => ({}) })
  const a = store.add({ type: 'completed', sessionId: 's1', payload: { reply: 'secret text' } })
  const b = store.add({ type: 'question', sessionId: 's2', payload: { questions: [] } })
  return { q, rows, a, b }
}

test('shown: recorded once per item with its rank, never card text; unknown id is refused', () => {
  const { q, rows, a } = make()
  assert.deepEqual(q.shown(a.id), { ok: true })
  assert.deepEqual(q.shown(a.id), { ok: true })
  assert.deepEqual(q.shown('nope'), { ok: false, error: 'not-open' })
  const shown = rows.filter((r) => r.kind === 'shown')
  assert.equal(shown.length, 1)
  assert.equal(shown[0].itemId, a.id)
  assert.equal(shown[0].type, 'completed')
  assert.equal(shown[0].rank, 1)
  assert.equal(JSON.stringify(shown[0]).includes('secret'), false)
})

test('acted: a user resolve emits acted with the rank held at that moment; a non-user resolve does not', () => {
  const { q, rows, a, b } = make()
  q.setQueueOrder('tier')
  assert.equal(q.markReviewed(a.id).ok, true)
  const acted = rows.filter((r) => r.kind === 'acted')
  assert.equal(acted.length, 1)
  assert.equal(acted[0].itemId, a.id)
  assert.equal(acted[0].rank, 2) // tier order puts the question first
  assert.equal(rows.filter((r) => r.kind === 'resolved').length, 1)
  assert.equal(b.id !== undefined, true)
})

test('a resolve by the system (not a card action) emits no acted row', () => {
  const { q, rows, b } = make()
  q.setQueueOrder('tier')
  q.archiveSession?.(b.id)
  assert.equal(rows.filter((r) => r.kind === 'acted').length, 0)
})

test('a resolved item is forgotten by shown: reopened, it is reported again', () => {
  const { q, rows, a } = make()
  q.shown(a.id)
  q.markReviewed(a.id)
  q.reopen?.(a.id)
  q.shown(a.id)
  assert.equal(rows.filter((r) => r.kind === 'shown').length, 2)
})

test('shown forgets items closed by resolveSession and reconcile (no unbounded set)', () => {
  let n = 0
  const store = createStore({ uuid: () => 'k' + ++n, events: { record: () => true } })
  const a = store.add({ type: 'completed', sessionId: 's1', payload: {} })
  const b = store.add({ type: 'completed', sessionId: 's2', payload: {} })
  store.shown(a.id); store.shown(b.id)
  store.resolveSession('s1', { kind: 'session-closed' })
  store.reconcile(new Set())
  assert.equal(store.shownCount(), 0)
})
