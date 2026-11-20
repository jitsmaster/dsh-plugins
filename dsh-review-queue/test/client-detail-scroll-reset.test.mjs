// Desktop overlay: selecting another card shows its details from the top. The .rq-detail pane is the scroll container and stays mounted
// when the selection changes, so its scrollTop used to carry over from the previous card. The pane is keyed by the selected card id,
// so a new selection remounts it (scrollTop 0) while a re-render of the same card (a snapshot) keeps the reading position.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, okJson, findAll } from './client-todo-helpers.mjs'

const mk = (id, n) => ({ id, type: 'completed', status: 'open', sessionId: 's' + id, createdAt: n, seq: n, position: n, payload: {} })
const snap = (ids) => ({ snapshotId: 'e:1', open: ids.map((id, n) => mk(id, n + 1)), resolved: [] })
function setup() {
  const { T } = loadClient({ fetchImpl: async () => okJson({ ok: true }), react: { createElement: el } })
  return T
}
const detail = (T) => {
  const n = findAll(T.Panel(), (x) => x.props && x.props.className === 'rq-detail')[0]
  assert.ok(n, 'the detail pane is rendered')
  return n
}

test('the detail pane has a different key for each selected card, so it remounts at the top', () => {
  const T = setup()
  T.applySnapshot(snap(['a', 'b']))
  T.selectItem('a')
  const a = detail(T).props.key
  T.selectItem('b')
  const b = detail(T).props.key
  assert.ok(a !== undefined && b !== undefined, 'the pane is keyed')
  assert.notEqual(a, b)
})

test('the same card keeps the same key across snapshots, so the reading position stays', () => {
  const T = setup()
  T.applySnapshot(snap(['a', 'b']))
  T.selectItem('a')
  const before = detail(T).props.key
  T.applySnapshot(snap(['a', 'b', 'c']))
  assert.equal(detail(T).props.key, before)
})
