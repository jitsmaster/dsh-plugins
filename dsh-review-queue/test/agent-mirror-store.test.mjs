import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMirrorStore } from '../agent/mirror-store.js'

const item = (id, seq, over = {}) => ({ id, seq, type: 'completed', status: 'open', createdAt: 100 + seq, sessionId: 's' + seq, payload: {}, owner: 'bbbb2222', ownerLabel: 'DSH :2', ownerState: 'online', ...over })
const snap = (snapshotId, open, resolved = []) => ({ snapshotId, open: open.map((i, n) => ({ ...i, position: n + 1, title: 'T', spoken: { headline: 'h' }, risks: [] })), resolved })

test('the mirror shows the hub snapshot in the hub order, with its snapshot id', () => {
  const store = createMirrorStore()
  store.update(snap('e:7', [item('b', 2, { createdAt: 50 }), item('a', 1)], [item('r', 3, { status: 'resolved', resolvedAt: 9, resolution: { kind: 'reviewed' } })]))
  const s = store.snapshot()
  assert.equal(s.snapshotId, 'e:7')
  assert.deepEqual(s.open.map((i) => [i.id, i.position, i.ownerLabel]), [['b', 1, 'DSH :2'], ['a', 2, 'DSH :2']])
  assert.deepEqual(s.resolved.map((i) => i.id), ['r'])
  assert.equal(store.get('a').status, 'open')
  assert.equal(store.isCurrent('e:7'), true)
  assert.equal(store.isCurrent('e:6'), false)
})

test('what the hub computed for display is not stored as item data', () => {
  const store = createMirrorStore()
  store.update(snap('e:1', [item('a', 1)]))
  const got = store.get('a')
  assert.deepEqual([got.position, got.spoken, got.risks], [undefined, undefined, undefined])
})

test('listeners hear a new snapshot, not a repeat of the same one; the second update replaces the first completely', () => {
  const store = createMirrorStore()
  let heard = 0
  store.onChange(() => heard++)
  store.update(snap('e:1', [item('a', 1)]))
  store.update(snap('e:1', [item('a', 1)]))
  assert.equal(heard, 1)
  store.update(snap('e:2', [item('c', 2)]))
  assert.equal(heard, 2)
  assert.deepEqual(store.list().map((i) => i.id), ['c'])
})
