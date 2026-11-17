// Slice 5: the phone Waiting list draws a header above each multi-item session group, built from the desktop's groups-ui.js model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as ui from '../lib/groups-ui.js'
import { groupedRows } from '../lib/mobile/model.js'

const it = (id, groupId, createdAt, over = {}) => ({ id, groupId, sessionId: groupId, type: 'completed', status: 'open', sessionTitle: 'Work ' + groupId, createdAt, tier: { severity: 'low', urgency: 'free', tier: 3, at: 1 }, ...over })
const shape = (rows) => rows.map((r) => (r.head ? 'head:' + r.head.id : r.item.id))

test('a multi-item group gets a header row, then its items oldest first; single cards get none', () => {
  const open = [it('a1', 's1', 1), it('b1', 's2', 2), it('a2', 's1', 3)]
  assert.deepEqual(shape(groupedRows(ui, open, [])), ['head:s1', 'a1', 'a2', 'b1'])
})

test('the header carries the group title, count and best tier from groupCardModel', () => {
  const open = [it('a1', 's1', 1, { tier: { severity: 'high', urgency: 'blocked', tier: 0, at: 1 } }), it('a2', 's1', 3)]
  const head = groupedRows(ui, open, [])[0].head
  assert.equal(head.title, 'Work s1')
  assert.equal(head.count, 2)
  assert.equal(head.topTier, 0)
})

test('AI-handled items of the session resolved since the oldest open item are counted on the header', () => {
  const open = [it('a1', 's1', 10), it('a2', 's1', 11)]
  const resolved = [{ id: 'r1', sessionId: 's1', status: 'resolved', resolvedAt: 20, resolution: { kind: 'ai-resolved' } }, { id: 'r0', sessionId: 's1', status: 'resolved', resolvedAt: 5, resolution: { kind: 'ai-resolved' } }]
  assert.equal(groupedRows(ui, open, resolved)[0].head.aiHandled, 1)
})

test('without the module, or with no items, the list stays flat and never throws', () => {
  const open = [it('a1', 's1', 1), it('a2', 's1', 3)]
  assert.deepEqual(shape(groupedRows(undefined, open, [])), ['a1', 'a2'])
  assert.deepEqual(groupedRows(ui, [], []), [])
  assert.deepEqual(groupedRows(ui, undefined, undefined), [])
})
