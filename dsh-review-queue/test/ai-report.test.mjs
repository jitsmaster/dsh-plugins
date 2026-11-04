// RED: ai-report.js, the pure part of the hourly "AI handled" report: buildReport({ items, entries, from, to }) and reportText(report).
// Real fields: item.resolvedAt (stamped by store.resolve), item.resolution.kind 'ai-resolved' | 'no-action'+by 'auto', item.resolution.review 'overruled',
// triage-log entries { at, itemId, type, stage: 'judge', verdict: 'handle' } and { at, itemId, type, stage: 'feedback', review: 'overruled' }.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, reportText } from '../ai-report.js'

const FROM = 1000
const TO = 2000
const ai = (id, type, at, over = {}) => ({ id, type, status: 'resolved', resolvedAt: at, resolution: { kind: 'ai-resolved', by: 'ai', ...over } })
const auto = (id, type, at) => ({ id, type, status: 'resolved', resolvedAt: at, resolution: { kind: 'no-action', by: 'auto' } })
const human = (id, type, at) => ({ id, type, status: 'resolved', resolvedAt: at, resolution: { kind: 'reviewed', by: 'card' } })
const would = (itemId, type, at, over = {}) => ({ at, itemId, type, stage: 'judge', verdict: 'handle', ...over })
const build = (items = [], entries = []) => buildReport({ items, entries, from: FROM, to: TO })

test('an empty period reports zeros and echoes the window', () => {
  const r = build()
  assert.equal(r.from, FROM); assert.equal(r.to, TO)
  assert.deepEqual([r.aiResolved, r.autoCleared, r.wouldHandle, r.overruled, r.total], [0, 0, 0, 0, 0])
})

test('ai-resolved items resolved inside the period are counted, by class', () => {
  const r = build([ai('a', 'completed', 1500), ai('b', 'permission', 1600), ai('c', 'question', 1700), ai('d', 'paused', 1800)])
  assert.equal(r.aiResolved, 4)
  assert.deepEqual(r.byClass.aiResolved, { done: 1, permission: 1, question: 1, idle: 1 })
})

test('auto-cleared done cards (no-action by auto) are their own bucket; a manual no-action or reviewed item is not counted', () => {
  const manual = { id: 'm', type: 'completed', status: 'resolved', resolvedAt: 1500, resolution: { kind: 'no-action', by: 'card' } }
  const r = build([auto('a', 'completed', 1500), manual, human('h', 'completed', 1500)])
  assert.equal(r.autoCleared, 1)
  assert.equal(r.aiResolved, 0)
  assert.deepEqual(r.byClass.autoCleared, { done: 1 })
})

test('window edges: from is inclusive, to is exclusive', () => {
  const r = build([ai('lo', 'completed', FROM), ai('hi', 'completed', TO), ai('before', 'completed', FROM - 1), ai('inside', 'completed', TO - 1)])
  assert.equal(r.aiResolved, 2)
})

test('items without a usable resolution time are ignored', () => {
  const r = build([{ id: 'x', type: 'completed', status: 'resolved', resolution: { kind: 'ai-resolved' } }, ai('y', 'completed', 'soon'), ai('z', 'completed', undefined)])
  assert.equal(r.aiResolved, 0)
})

test('open items are never counted', () => {
  const r = build([{ id: 'o', type: 'completed', status: 'open', resolvedAt: 1500, resolution: { kind: 'ai-resolved' } }])
  assert.equal(r.aiResolved, 0)
})

test('an item type triage does not know is counted under other', () => {
  const r = build([ai('a', 'pr-merged', 1500)])
  assert.equal(r.aiResolved, 1)
  assert.deepEqual(r.byClass.aiResolved, { other: 1 })
})

test('would-handle counts judge/handle log entries in the period, once per item, split by class', () => {
  const r = build([], [
    would('a', 'permission', 1100), would('a', 'permission', 1200), would('b', 'completed', 1300),
    would('c', 'question', 1400, { verdict: 'ask' }), would('d', 'question', 1400, { stage: 'code-veto' }), would('e', 'question', 5000), would('f', 'question', 500),
  ])
  assert.equal(r.wouldHandle, 2)
  assert.deepEqual(r.byClass.wouldHandle, { permission: 1, done: 1 })
})

test('log entries without a numeric time are ignored', () => {
  assert.equal(build([], [would('a', 'permission', undefined), would('b', 'permission', '1500')]).wouldHandle, 0)
})

test('overruled: items whose resolution.review is overruled and feedback entries count once per item', () => {
  const r = build(
    [ai('a', 'completed', 1500, { review: 'overruled' }), ai('b', 'permission', 1500, { review: 'seen' })],
    [{ at: 1600, itemId: 'a', type: 'completed', stage: 'feedback', review: 'overruled' }, { at: 1700, itemId: 'z', type: 'permission', stage: 'feedback', review: 'overruled' }, { at: 1700, itemId: 'y', type: 'permission', stage: 'feedback', review: 'agreed' }],
  )
  assert.equal(r.overruled, 2)
  assert.deepEqual(r.byClass.overruled, { done: 1, permission: 1 })
})

test('handled excludes observe-mode proposals while total keeps them', () => {
  const r = buildReport({ items: [], entries: [{ at: 5, stage: 'judge', verdict: 'handle', itemId: 'x', type: 'completed' }], from: 0, to: 10 })
  assert.equal(r.handled, 0)
  assert.equal(r.total, 1)
})

test('total is aiResolved + autoCleared + wouldHandle; overruled is reported apart', () => {
  const r = build([ai('a', 'completed', 1500, { review: 'overruled' }), auto('b', 'completed', 1500)], [would('c', 'permission', 1500)])
  assert.equal(r.total, 3)
  assert.equal(r.overruled, 1)
})

test('an item is counted once per bucket even when listed twice', () => {
  const it = ai('a', 'completed', 1500)
  assert.equal(build([it, { ...it }]).aiResolved, 1)
})

// ---- reportText ----
const rep = (over = {}) => ({ from: 0, to: 1, aiResolved: 0, autoCleared: 0, wouldHandle: 0, overruled: 0, total: 0, byClass: { aiResolved: {}, autoCleared: {}, wouldHandle: {}, overruled: {} }, ...over })

test('reportText names the handled count with the class split, the would-handle count and the overruled count', () => {
  const t = reportText(rep({ aiResolved: 3, autoCleared: 2, wouldHandle: 4, overruled: 1, total: 9, byClass: { aiResolved: { done: 3 }, autoCleared: { done: 2 }, wouldHandle: { permission: 4 }, overruled: { done: 1 } } }))
  assert.match(t, /^AI handled 5 in the last hour/)
  assert.match(t, /5 done cards/)
  assert.match(t, /would also have handled 4 more/i)
  assert.match(t, /You overruled 1\./)
  assert.ok(!t.includes('\n'))
})

test('reportText leaves out the zero parts', () => {
  const t = reportText(rep({ aiResolved: 2, total: 2, byClass: { aiResolved: { permission: 2 }, autoCleared: {}, wouldHandle: {}, overruled: {} } }))
  assert.match(t, /AI handled 2 in the last hour: 2 approvals\./)
  assert.doesNotMatch(t, /would also|overruled/i)
})

test('reportText uses the singular for one', () => {
  const t = reportText(rep({ aiResolved: 1, overruled: 1, total: 1, byClass: { aiResolved: { done: 1 }, autoCleared: {}, wouldHandle: {}, overruled: { done: 1 } } }))
  assert.match(t, /1 done card\b(?!s)/)
  assert.match(t, /You overruled 1\./)
})

test('reportText with only observe-mode proposals still says something useful', () => {
  const t = reportText(rep({ wouldHandle: 3, total: 3, byClass: { aiResolved: {}, autoCleared: {}, wouldHandle: { question: 3 }, overruled: {} } }))
  assert.match(t, /would (also )?have handled 3/i)
  assert.doesNotMatch(t, /AI handled 0/)
})

test('reportText names every class once with its own noun', () => {
  const t = reportText(rep({ aiResolved: 4, total: 4, byClass: { aiResolved: { done: 1, permission: 1, question: 1, idle: 1 }, autoCleared: {}, wouldHandle: {}, overruled: {} } }))
  assert.match(t, /1 done card/); assert.match(t, /1 approval/); assert.match(t, /1 question/); assert.match(t, /1 idle session/)
})

test('reportText is capped at 300 characters', () => {
  const big = {}
  for (const k of ['done', 'permission', 'question', 'idle', 'other']) big[k] = 123456789
  const t = reportText(rep({ aiResolved: 999, autoCleared: 999, wouldHandle: 999, overruled: 999, total: 2997, byClass: { aiResolved: big, autoCleared: big, wouldHandle: big, overruled: big } }))
  assert.ok(t.length <= 300, 'length ' + t.length)
})

test('reportText carries only counts: no ids, paths or item text even if the report object has extra fields', () => {
  const t = reportText({ ...rep({ aiResolved: 1, total: 1, byClass: { aiResolved: { done: 1 }, autoCleared: {}, wouldHandle: {}, overruled: {} } }), items: [{ id: 'SECRET-ID', title: 'D:/secret/path token=abc' }], note: 'sk-abcdefabcdefabcdef' })
  assert.doesNotMatch(t, /SECRET|secret|sk-|token|D:/)
})
