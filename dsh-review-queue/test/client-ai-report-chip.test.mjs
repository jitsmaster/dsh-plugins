// RED: the header chip of the last hourly AI report. Shared helper (exports.shared): aiReportChip(aiReport, now) -> { label, title } | undefined.
// label "AI 1h: <total>", title = the report text; undefined without a report, with total 0, or when the report (its `to`) is older than 3 hours (3 intervals).
// Rendered in the header next to the "AI handled N" button as an element with data-ai-report; clicking opens Resolved filtered to Resolved-by AI.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, findAll, textOf } from './client-todo-helpers.mjs'

const H = 3600_000
const NOW = 50 * H
const report = (over = {}) => ({ total: 9, handled: 7, overruled: 0, text: 'AI handled 7 in the last hour: 7 done cards.', to: NOW - 1000, ...over })
const load = () => { const c = loadClient({ react: { createElement: el } }); return { S: c.mod.shared, T: c.T } }
const head = (T) => { const n = findAll(T.Panel(), (x) => typeof x.type === 'function' && x.type.name === 'Head')[0]; assert.ok(n, 'a Head component is rendered'); return n.type(n.props) }
const chips = (tree) => findAll(tree, (n) => n.props && 'data-ai-report' in n.props)

test('aiReportChip gives the label and the report text as title', () => {
  const { S } = load()
  assert.deepEqual({ ...S.aiReportChip(report(), NOW) }, { label: 'AI 1h: 7', title: report().text })
})

test('aiReportChip is undefined with no report, a zero total, or a report older than three intervals', () => {
  const { S } = load()
  assert.equal(S.aiReportChip(undefined, NOW), undefined)
  assert.equal(S.aiReportChip(report({ total: 0, handled: 0, overruled: 2 }), NOW), undefined)
  assert.equal(S.aiReportChip(report({ total: 3, handled: 0 }), NOW), undefined) // proposals only: not handled, no chip
  assert.equal(S.aiReportChip(report({ to: NOW - 3 * H - 1 }), NOW), undefined)
  assert.notEqual(S.aiReportChip(report({ to: NOW - 3 * H }), NOW), undefined)
})

test('the header shows the chip when the snapshot carries a fresh report', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [], serverNow: NOW, aiReport: report() }
  const c = chips(head(T))
  assert.equal(c.length, 1)
  assert.equal(textOf(c[0]), 'AI 1h: 7')
  assert.equal(c[0].props.title, report().text)
  assert.equal(c[0].props.type, 'button')
})

test('the header has no chip without a report, or with a stale one', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [], serverNow: NOW }
  assert.equal(chips(head(T)).length, 0)
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [], serverNow: NOW, aiReport: report({ to: NOW - 4 * H }) }
  assert.equal(chips(head(T)).length, 0)
})

test('clicking the chip opens the Resolved view filtered to Resolved-by AI', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [], serverNow: NOW, aiReport: report() }
  chips(head(T))[0].props.onClick()
  assert.equal(T.state.showResolved, true)
  assert.equal(T.state.filter.resolvedBy, 'ai')
})

