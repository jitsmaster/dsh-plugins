// Slice 7: where is the item an alert is about in the task list? Only the reviewQueue service's snapshot() is used (open items,
// in the order the cards show and "read item N" counts), so dsh-hooks-tts imports nothing from dsh-review-queue.
import assert from 'node:assert/strict'
import test from 'node:test'
import { queuePositionOf, refreshHeldAlert } from '../voice/alert-position.js'

const item = (over) => ({ id: 'i' + Math.random(), type: 'completed', sessionId: 's1', ...over })
const queueOf = (open) => ({ snapshot: () => ({ open }) })

// Test list: position = 1-based index of the open item; per type; question by call id; permission by tool; newest wins;
// not found; no queue; empty; hidden/foreign items; throwing / malformed service; refreshHeldAlert.

test('AP1 a done item: its 1-based place among the open items', () => {
  const q = queueOf([item({ sessionId: 'a' }), item({ sessionId: 'b' }), item({ sessionId: 's1' })])
  assert.equal(queuePositionOf(q, { type: 'completed', sessionId: 's1' }), 3)
  assert.equal(queuePositionOf(q, { type: 'completed', sessionId: 'a' }), 1)
})

test('AP2 the place is the index in the list, not the item.position field (the list order is what read item N uses)', () => {
  const q = queueOf([item({ sessionId: 'a', position: 9 }), item({ sessionId: 's1', position: 1 })])
  assert.equal(queuePositionOf(q, { type: 'completed', sessionId: 's1' }), 2)
})

test('AP3 only an item of the alert type counts (a question alert is not the done item of the same session)', () => {
  const q = queueOf([item({ type: 'completed', sessionId: 's1' }), item({ type: 'question', sessionId: 's1', key: 'c9' }), item({ type: 'permission', sessionId: 's1', payload: { toolName: 'write' } })])
  assert.equal(queuePositionOf(q, { type: 'question', sessionId: 's1', callId: 'c9' }), 2)
  assert.equal(queuePositionOf(q, { type: 'permission', sessionId: 's1', toolName: 'write' }), 3)
  assert.equal(queuePositionOf(q, { type: 'completed', sessionId: 's1' }), 1)
})

test('AP4 a question is found by its call id; another open question of the session is not it', () => {
  const q = queueOf([item({ type: 'question', sessionId: 's1', key: 'old' })])
  assert.equal(queuePositionOf(q, { type: 'question', sessionId: 's1', callId: 'new' }), undefined, 'the new question is not captured yet: fall back, never the old position')
  assert.equal(queuePositionOf(q, { type: 'question', sessionId: 's1', callId: 'old' }), 1)
  assert.equal(queuePositionOf(q, { type: 'question', sessionId: 's1' }), 1, 'no call id known: the session question')
})

test('AP5 a permission request is found by its tool; with several, the newest (last) one is the alert', () => {
  const q = queueOf([
    item({ type: 'permission', sessionId: 's1', payload: { toolName: 'pwsh' } }),
    item({ type: 'permission', sessionId: 's1', payload: { toolName: 'write' } }),
    item({ type: 'permission', sessionId: 's1', payload: { toolName: 'pwsh' } }),
  ])
  assert.equal(queuePositionOf(q, { type: 'permission', sessionId: 's1', toolName: 'pwsh' }), 3)
  assert.equal(queuePositionOf(q, { type: 'permission', sessionId: 's1', toolName: 'write' }), 2)
  assert.equal(queuePositionOf(q, { type: 'permission', sessionId: 's1', toolName: 'edit' }), undefined)
  assert.equal(queuePositionOf(q, { type: 'permission', sessionId: 's1' }), 3, 'no tool known: the newest of the session')
})

test('AP6 not in the queue: undefined (queue absent, empty, item hidden by the no-action rule or not captured yet)', () => {
  const locator = { type: 'completed', sessionId: 's1' }
  assert.equal(queuePositionOf(undefined, locator), undefined)
  assert.equal(queuePositionOf(null, locator), undefined)
  assert.equal(queuePositionOf(queueOf([]), locator), undefined)
  assert.equal(queuePositionOf(queueOf([item({ sessionId: 'other' })]), locator), undefined)
  assert.equal(queuePositionOf(queueOf([item({ sessionId: 's1', status: 'resolved' })]), locator), undefined, 'a resolved item is not in the open list')
  assert.equal(queuePositionOf(queueOf([item()]), undefined), undefined)
  assert.equal(queuePositionOf(queueOf([item()]), { type: 'completed' }), undefined, 'no session to look for')
})

test('AP7 a service that throws, lacks snapshot() or answers garbage never throws here: undefined', () => {
  const locator = { type: 'completed', sessionId: 's1' }
  assert.equal(queuePositionOf({ snapshot() { throw new Error('boom') } }, locator), undefined)
  assert.equal(queuePositionOf({}, locator), undefined)
  assert.equal(queuePositionOf({ snapshot: () => undefined }, locator), undefined)
  assert.equal(queuePositionOf({ snapshot: () => ({ open: 'x' }) }, locator), undefined)
  assert.equal(queuePositionOf({ snapshot: () => ({ open: [null, 5, item({ sessionId: 's1' })] }) }, locator), 3, 'junk entries still take their place in the count')
  assert.equal(queuePositionOf({ snapshot: async () => ({ open: [] }) }, locator), undefined, 'a promise is not a snapshot')
})

test('AP8 a getter that throws is the caller\'s: queuePositionOf accepts a service or a function returning one', () => {
  const locator = { type: 'completed', sessionId: 's1' }
  assert.equal(queuePositionOf(() => queueOf([item({ sessionId: 's1' })]), locator), 1)
  assert.equal(queuePositionOf(() => { throw new Error('no service') }, locator), undefined)
  assert.equal(queuePositionOf(() => undefined, locator), undefined)
})

const held = (over) => ({ hook: { command: 'x' }, body: { headline: 'Item one, done in w.', cwd: 'c' }, sessionId: 's1', event: 'Stop', locator: { type: 'completed', sessionId: 's1' }, headlineAt: (n) => (n ? 'Item ' + n + ', done in w.' : 'Done on: Workspace: w.'), ...over })

test('AP9 refreshHeldAlert re-renders the headline for where the item is NOW', () => {
  const out = refreshHeldAlert(held(), () => 2)
  assert.equal(out.body.headline, 'Item 2, done in w.')
  assert.equal(out.body.cwd, 'c', 'the rest of the body is untouched')
  assert.equal(out.sessionId, 's1')
})

test('AP10 an item that left the queue meanwhile falls back to the old (session) headline', () => {
  assert.equal(refreshHeldAlert(held(), () => undefined).body.headline, 'Done on: Workspace: w.')
})

test('AP11 a lookup that throws falls back to the old headline; a render that throws or says nothing keeps the held one', () => {
  assert.equal(refreshHeldAlert(held(), () => { throw new Error('boom') }).body.headline, 'Done on: Workspace: w.')
  const keep = held({ headlineAt: () => { throw new Error('bad') } })
  assert.equal(refreshHeldAlert(keep, () => 1), keep)
  const none = held({ headlineAt: () => undefined })
  assert.equal(refreshHeldAlert(none, () => 1), none)
})

test('AP12 an alert without a locator or renderer (not a headline alert) is returned as it is', () => {
  const plain = { hook: {}, body: { x: 1 } }
  assert.equal(refreshHeldAlert(plain, () => 1), plain)
  const noLocator = held({ locator: undefined })
  assert.equal(refreshHeldAlert(noLocator, () => 1), noLocator)
  assert.equal(refreshHeldAlert(undefined, () => 1), undefined)
})

test('AP13 the lookup gets the alert\'s locator', () => {
  const seen = []
  refreshHeldAlert(held({ locator: { type: 'question', sessionId: 's2', callId: 'c' } }), (locator) => { seen.push(locator); return 1 })
  assert.deepEqual(seen, [{ type: 'question', sessionId: 's2', callId: 'c' }])
})
