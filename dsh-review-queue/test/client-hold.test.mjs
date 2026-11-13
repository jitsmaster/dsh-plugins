// Slice 2: client-only hold. With the overlay open the list keeps its order; items that arrived since are appended and counted ("N new") until the user taps.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, okJson, findAll, textOf } from './client-todo-helpers.mjs'

const mk = (id, n) => ({ id, type: 'completed', status: 'open', sessionId: 's' + id, createdAt: n, seq: n, position: n, payload: {} })
const snap = (ids) => ({ snapshotId: 'e:1', open: ids.map((id, n) => mk(id, n + 1)), resolved: [] })
function setup() {
  const { T } = loadClient({ fetchImpl: async () => okJson({ ok: true }), react: { createElement: el } })
  return T
}
const ids = (T) => T.visibleOpen().map((i) => i.id)

test('no hold: the live order is shown and nothing is new', () => {
  const T = setup()
  T.state.overlay = false
  T.applySnapshot(snap(['a', 'b']))
  T.applySnapshot(snap(['c', 'a', 'b']))
  assert.deepEqual(ids(T), ['c', 'a', 'b'])
  assert.equal(T.newCount(), 0)
})

test('hold: arrivals go last and are counted; tapping releases the hold', () => {
  const T = setup()
  T.state.overlay = true
  T.applySnapshot(snap(['a', 'b']))
  T.holdNow()
  T.applySnapshot(snap(['c', 'a', 'b']))
  assert.deepEqual(ids(T), ['a', 'b', 'c'])
  assert.equal(T.newCount(), 1)
  T.releaseHold()
  assert.deepEqual(ids(T), ['c', 'a', 'b'])
  assert.equal(T.newCount(), 0)
})

test('opening the overlay starts the hold from the list as it is; with no snapshot yet there is no hold', () => {
  const T = setup()
  T.setOverlay(true)
  assert.equal(T.state.hold, null)
  T.setOverlay(false)
  T.applySnapshot(snap(['a', 'b']))
  T.setOverlay(true)
  assert.deepEqual(JSON.parse(JSON.stringify(T.state.hold)), { ids: ['a', 'b'] })
  T.applySnapshot(snap(['c', 'a', 'b']))
  assert.equal(T.newCount(), 1)
})

test('the "N new" strip shows while arrivals are held and a tap releases the hold', () => {
  const { T } = loadClient({ fetchImpl: async () => okJson({ ok: true }), react: { createElement: el } })
  T.applySnapshot(snap(['a', 'b']))
  T.setOverlay(true)
  T.applySnapshot(snap(['c', 'a', 'b']))
  const strip = () => findAll(T.Panel(), (n) => n.props && n.props['data-new-strip'] !== undefined)[0]
  const s = strip()
  assert.ok(s, 'strip rendered')
  assert.equal(textOf(s), '1 new')
  s.props.onClick()
  assert.equal(strip(), undefined)
  assert.deepEqual(ids(T), ['c', 'a', 'b'])
})

test('a filter change is not an arrival: the hold covers every open item, filtered or not', () => {
  const T = setup()
  const s = snap(['a', 'b'])
  s.open[1].type = 'question'
  T.applySnapshot(s)
  T.set({ filter: { type: 'question', query: '', resolvedBy: 'all', resolvedType: 'all' } })
  T.setOverlay(true)
  T.set({ filter: { type: 'all', query: '', resolvedBy: 'all', resolvedType: 'all' } })
  assert.equal(T.newCount(), 0)
  assert.deepEqual(ids(T), ['a', 'b'])
})

test('hold: an item that left is dropped, closing the overlay releases', () => {
  const T = setup()
  T.state.overlay = true
  T.applySnapshot(snap(['a', 'b']))
  T.holdNow()
  T.applySnapshot(snap(['b', 'c']))
  assert.deepEqual(ids(T), ['b', 'c'])
  T.setOverlay(false)
  assert.equal(T.state.hold, null)
})

test('an overlay restored open at load starts its hold with the first snapshot', () => {
  const T = setup()
  T.state.overlay = true
  T.applySnapshot(snap(['a', 'b']))
  T.applySnapshot(snap(['c', 'a', 'b']))
  assert.deepEqual(ids(T), ['a', 'b', 'c'])
  assert.equal(T.newCount(), 1)
})

test('any close of the overlay releases the hold, not only setOverlay(false)', () => {
  const T = setup()
  T.applySnapshot(snap(['a']))
  T.setOverlay(true)
  assert.ok(T.state.hold)
  T.set({ overlay: false })
  assert.equal(T.state.hold, null)
})

test('an empty queue starts no hold: the first arrival is not an N new', () => {
  const T = setup()
  T.applySnapshot(snap([]))
  T.setOverlay(true)
  T.applySnapshot(snap(['a']))
  assert.equal(T.newCount(), 0)
})
