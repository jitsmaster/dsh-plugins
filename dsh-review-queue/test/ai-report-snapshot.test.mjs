// RED: the queue snapshot carries the last AI report so the desktop header can show a chip: service.js takes aiReportOf (() => last report with its text | undefined)
// and adds aiReport: { total, overruled, text, to } (nothing else of the report) to snapshot(); absent when there is no report yet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

const make = (extra = {}) => createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}), ...extra })
const report = { from: 1, to: 5000, aiResolved: 3, autoCleared: 2, wouldHandle: 1, overruled: 1, handled: 5, total: 6, byClass: { aiResolved: { done: 3 } }, text: 'AI handled 5 in the last hour: 5 done cards.' }

test('snapshot() includes aiReport with total, handled, overruled, text and to only', () => {
  const snap = make({ aiReportOf: () => report }).snapshot()
  assert.deepEqual(snap.aiReport, { total: 6, handled: 5, overruled: 1, text: report.text, to: 5000 })
})

test('snapshot() has no aiReport key before a first report exists', () => {
  assert.ok(!('aiReport' in make({ aiReportOf: () => undefined }).snapshot()))
})

test('snapshot() has no aiReport key without an aiReportOf dependency (feature off)', () => {
  assert.ok(!('aiReport' in make().snapshot()))
})

test('a throwing aiReportOf never breaks the snapshot', () => {
  const snap = make({ aiReportOf: () => { throw new Error('x') } }).snapshot()
  assert.ok(!('aiReport' in snap))
  assert.deepEqual(snap.open, [])
})
