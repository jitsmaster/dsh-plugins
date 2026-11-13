// Slice 0 of review grouping and priority: after the judge answers, the runner refines the item's tier. Items the judge never sees keep the code-only tier.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createTriageRunner } from '../triage-runner.js'

const PERM_JUDGMENT = {
  needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null,
  matched_rule: 'ro-permission', attention: 10, reversible: true, touches_outside_workspace: false, read_only: true,
}
const DONE_JUDGMENT = { ...PERM_JUDGMENT, matched_rule: 'green-done' }
const perm = (detail = 'git status') => ({ type: 'permission', sessionId: 's1', workspace: 'D:/w', payload: { toolName: 'shell', detail, summary: detail } })
const done = (reply = 'Renamed the helper and ran the build.') => ({ type: 'completed', sessionId: 's1', workspace: 'D:/w', payload: { reply } })

function setup({ judgment, judge } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const calls = []
  const j = judge ?? { judge: async (arg) => { calls.push(arg); return { judgment, raw: '' } } }
  const runner = createTriageRunner({ store, judge: j, triageLog: { append: () => {} }, log: () => {} })
  assert.equal(runner.start(), true)
  return { store, runner, calls }
}

test('a safe read-only permission the judge calls low is refined from High to Low severity (tier P2)', async () => {
  const { store, runner } = setup({ judgment: { ...PERM_JUDGMENT, severity: 'low' } })
  const item = store.add(perm())
  assert.equal(store.get(item.id).tier.tier, 0) // code-only default until the judge answers
  await runner.idle()
  const t = store.get(item.id).tier
  assert.deepEqual([t.severity, t.urgency, t.tier], ['low', 'blocked', 2])
})

test('the model can raise a done card above the code floor', async () => {
  const { store, runner } = setup({ judgment: { ...DONE_JUDGMENT, severity: 'medium' } })
  const item = store.add(done())
  await runner.idle()
  const t = store.get(item.id).tier
  assert.deepEqual([t.severity, t.tier], ['medium', 2])
})

test('needs_decision from the judge on a done card makes it at least Medium', async () => {
  const { store, runner } = setup({ judgment: { ...DONE_JUDGMENT, needs_decision: true, attention: 20 } })
  const item = store.add(done())
  await runner.idle()
  assert.equal(store.get(item.id).tier.severity, 'medium')
})

test('a done card that asks the user something is vetoed by code (no judge call) and still ranks Medium', async () => {
  const { store, runner, calls } = setup({ judgment: DONE_JUDGMENT })
  const item = store.add(done('Which of the two designs do you want?'))
  await runner.idle()
  assert.equal(calls.length, 0)
  assert.deepEqual([store.get(item.id).tier.severity, store.get(item.id).tier.tier], ['medium', 2])
})

test('a model that says low never lowers a risky permission: code floor stays High', async () => {
  const { store, runner } = setup({ judgment: { ...PERM_JUDGMENT, severity: 'low' } })
  const item = store.add(perm('git push origin main')) // mutating: code veto, no judge call
  await runner.idle()
  assert.equal(store.get(item.id).tier.severity, 'high')
  assert.equal(store.get(item.id).tier.tier, 0)
})

test('a code-vetoed item makes no model call (no extra scoring call) and keeps its code-only tier', async () => {
  const { store, runner, calls } = setup({ judgment: PERM_JUDGMENT })
  const item = store.add(perm('git push origin main'))
  await runner.idle()
  assert.equal(calls.length, 0)
  assert.equal(store.get(item.id).tier.tier, 0)
})

test('a judge that fails leaves the code-only tier', async () => {
  const { store, runner } = setup({ judge: { judge: async () => ({ note: 'no model' }) } })
  const item = store.add(done())
  await runner.idle()
  assert.equal(store.get(item.id).tier.severity, 'low')
  assert.equal(store.get(item.id).tier.tier, 3)
})

test('one judge call per judged item, and housekeeping types are not judged at all', async () => {
  const { store, runner, calls } = setup({ judgment: DONE_JUDGMENT })
  store.add(done())
  store.add({ type: 'todo', payload: {} })
  await runner.idle()
  assert.equal(calls.length, 1)
})

test('an item resolved while the judge ran is not touched', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { store, runner } = setup({ judge: { judge: async () => { await gate; return { judgment: { ...DONE_JUDGMENT, severity: 'high' } } } } })
  const item = store.add(done())
  store.resolve(item.id, { kind: 'reviewed' })
  release()
  await runner.idle()
  assert.equal(store.get(item.id).tier.severity, 'low')
})
