// Phase 3 slice 1: createTriageRunner({ rules }) accepts an array or a function returning the array, read at each use,
// so a mode change made through triage-rules takes effect without a restart.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createTriageRunner, DEFAULT_RULES } from '../triage-runner.js'

const GOOD = {
  needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null,
  matched_rule: 'ro-permission', attention: 10, reversible: true, touches_outside_workspace: false, read_only: true,
}
const perm = () => ({ type: 'permission', sessionId: 's1', workspace: 'D:/w', payload: { toolName: 'shell', detail: 'git status', summary: 'git status' } })

function setup(rules) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const calls = []
  const entries = []
  const judge = { judge: async (arg) => { calls.push(arg); return { judgment: GOOD, raw: '' } } }
  const runner = createTriageRunner({ store, judge, triageLog: { append: (e) => entries.push(e) }, rules })
  assert.equal(runner.start(), true)
  return { store, runner, calls, entries }
}

test('rules given as a function are used: an observe rule gets the judge call and the note', async () => {
  const live = DEFAULT_RULES.map((r) => ({ ...r }))
  const { store, runner, calls } = setup(() => live)
  const item = store.add(perm())
  await runner.idle()
  assert.equal(calls.length, 1)
  assert.equal(store.get(item.id).triage?.verdict, 'handle')
})

test('switching a rule to off through the rules function before an item is added: no judge call and no note', async () => {
  const live = DEFAULT_RULES.map((r) => ({ ...r }))
  const { store, runner, calls } = setup(() => live)
  live.find((r) => r.id === 'ro-permission').mode = 'off'
  const item = store.add(perm())
  await runner.idle()
  assert.equal(calls.length, 0)
  assert.equal(store.get(item.id).triage, undefined)
})

test('the function is evaluated at each use: off for the first item, observe again for the second', async () => {
  let live = DEFAULT_RULES.map((r) => ({ ...r, mode: 'off' }))
  const { store, runner, calls } = setup(() => live)
  const first = store.add(perm())
  await runner.idle()
  live = DEFAULT_RULES.map((r) => ({ ...r }))
  const second = store.add(perm())
  await runner.idle()
  assert.equal(calls.length, 1)
  assert.equal(store.get(first.id).triage, undefined)
  assert.equal(store.get(second.id).triage?.verdict, 'handle')
})

test('rules given as an array still work (today)', async () => {
  const { store, runner, calls } = setup(DEFAULT_RULES.map((r) => ({ ...r })))
  const item = store.add(perm())
  await runner.idle()
  assert.equal(calls.length, 1)
  assert.equal(store.get(item.id).triage?.verdict, 'handle')
})
