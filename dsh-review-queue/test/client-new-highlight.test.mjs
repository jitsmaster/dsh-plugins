// New items are highlighted in the left list until they are selected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, okJson } from './client-todo-helpers.mjs'

const mk = (id, n) => ({ id, type: 'completed', status: 'open', sessionId: 's' + id, createdAt: n, seq: n, position: n, payload: {} })
const snap = (ids) => ({ snapshotId: 'e:1', open: ids.map((id, n) => mk(id, n + 1)), resolved: [] })
function setup() {
  const { T } = loadClient({ fetchImpl: async () => okJson({ ok: true }), react: { createElement: el } })
  return T
}

test('items present at the first snapshot are not new', () => {
  const T = setup()
  T.applySnapshot(snap(['a', 'b']))
  assert.deepEqual(Object.keys(T.state.fresh), [])
})

test('an item arriving later is new until it is selected', () => {
  const T = setup()
  T.applySnapshot(snap(['a', 'b']))
  T.applySnapshot(snap(['a', 'b', 'c']))
  assert.deepEqual(Object.keys(T.state.fresh), ['c'])
  T.applySnapshot(snap(['a', 'b', 'c']))
  assert.deepEqual(Object.keys(T.state.fresh), ['c'], 'stays new across snapshots')
  T.selectItem('c')
  assert.deepEqual(Object.keys(T.state.fresh), [])
  assert.equal(T.state.selected, 'c')
})

test('an item that leaves the queue is forgotten', () => {
  const T = setup()
  T.applySnapshot(snap(['a']))
  T.applySnapshot(snap(['a', 'b']))
  T.applySnapshot(snap(['a']))
  assert.deepEqual(Object.keys(T.state.fresh), [])
})

test('selectItem(null) and an unmarked id leave the marks alone', () => {
  const T = setup()
  T.applySnapshot(snap(['a']))
  T.applySnapshot(snap(['a', 'b']))
  T.selectItem(null)
  assert.deepEqual(Object.keys(T.state.fresh), ['b'])
  assert.equal(T.state.selected, null)
})

test('the new-row background is a valid color-mix, not a hex suffix', () => {
  const T = setup()
  assert.match(T.CSS, /\.rq-row-i\.new\{background:color-mix\(/)
})

test('the implicitly selected item (nothing chosen) is never left marked new', () => {
  const T = setup()
  T.applySnapshot(snap([]))
  T.applySnapshot(snap(['x']))
  assert.deepEqual(Object.keys(T.state.fresh), [])
})

test('clearFresh(id) clears one mark, and does nothing (no store write) when the id is not marked', () => {
  const T = setup()
  T.applySnapshot(snap(['a']))
  T.applySnapshot(snap(['a', 'b', 'c']))
  const before = T.state.fresh
  T.clearFresh('zzz')
  T.clearFresh(null)
  assert.equal(T.state.fresh, before, 'untouched object: set() was not called')
  T.clearFresh('b')
  assert.deepEqual(Object.keys(T.state.fresh), ['c'])
})
test("an item that briefly leaves the open list and returns is not new again", () => {
  const T = setup()
  let v = 0
  const next = (ids) => T.applySnapshot({ ...snap(ids), snapshotId: "e:" + ++v })
  next(["a"])
  next(["a", "b"])
  assert.deepEqual(Object.keys(T.state.fresh), ["b"])
  next(["a"])
  next(["a", "b"])
  assert.deepEqual(Object.keys(T.state.fresh), [])
})

test('the selected row uses the sidebar selected fill (hover token, no accent), and new rows use a different color (success green)', () => {
  const T = setup()
  const sel = /\.rq-row-i\.sel,\.rq-row-i\[aria-selected=true\]\{([^}]*)\}/.exec(T.CSS)[1]
  const neu = /\.rq-row-i\.new\{([^}]*)\}/.exec(T.CSS)[1]
  assert.match(sel, /background:var\(--rq-hover\)/)
  assert.doesNotMatch(sel, /accent/)
  assert.match(neu, /--rq-ok/)
  assert.doesNotMatch(neu, /--rq-accent/)
})