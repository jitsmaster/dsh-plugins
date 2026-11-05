// Robustness of the triage runner and its neighbours: no slot leak from a throwing switch, the actionable pre-check, honest sessionContinues in the log,
// the candidate cap, the review service guard and the store adapter's resolveIf.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../store.js'
import { createTriageRunner, DEFAULT_RULES } from '../triage-runner.js'
import { containedInWorkspace } from '../triage-paths.js'
import { createTriageReview } from '../triage-review.js'
import { createStoreAdapter } from '../agent/store-adapter.js'

const GOOD = {
  needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null,
  matched_rule: 'ro-permission', attention: 10, reversible: true, touches_outside_workspace: false, read_only: true,
}
const perm = (detail = 'git status') => ({ type: 'permission', sessionId: 's1', workspace: tmpdir(), payload: { toolName: 'shell', detail, summary: detail, callId: 'c1' } })
const done = (over = {}) => ({ type: 'completed', sessionId: 's1', workspace: 'D:/w', payload: { reply: 'Renamed the helper and ran the build.' }, ...over })

function setup({ judge, rules = DEFAULT_RULES, ...deps } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const entries = []
  const calls = []
  const j = judge ?? { judge: async (arg) => { calls.push(arg); return { judgment: GOOD, raw: '' } } }
  const runner = createTriageRunner({ store, judge: j, triageLog: { append: (e) => entries.push(e) }, log: () => {}, rules, ...deps })
  assert.equal(runner.start(), true)
  return { store, runner, entries, calls }
}

// --- R1 ------------------------------------------------------------------------------------------------------------------------------
test('R1: a missing or throwing enabled check at the very point of the model call never leaves the runner busy', async () => {
  let throwNext = false
  let first = true
  const enabled = () => { if (throwNext) { throwNext = false; throw new Error('boom') } return true }
  const { store, runner, entries, calls } = setup({ enabled, maxInFlight: 1, sourcesOf: async () => { if (first) { first = false; throwNext = true } return [] } })
  store.add(perm('git status a'))
  await runner.idle()
  store.add(perm('git status b'))
  await runner.idle()
  assert.ok(!entries.some((e) => (e.reasons ?? []).includes('busy')))
  assert.equal(calls.length, 1, 'the first item is skipped as off (the check threw), the second reached the judge')
})

// --- R2 ------------------------------------------------------------------------------------------------------------------------------
test('R2: triageEnabled tolerates a rules stub without setEnabled', () => {
  const rules = { list: () => [], get: () => undefined, setMode: () => true }
  const svc = createTriageReview({ store: createStore(), triageApi: { rules, memory: undefined }, promptSession: async () => undefined })
  assert.deepEqual(svc.triageEnabled(true), { ok: false, error: 'bad-input' })
  assert.deepEqual(svc.triageEnabled('yes'), { ok: false, error: 'bad-input' })
})

// --- R3 ------------------------------------------------------------------------------------------------------------------------------
test('R3: a done card that is itself actionable never wastes a model call under an auto rule; summary-pending still waits for the model', async () => {
  const rules = DEFAULT_RULES.map((r) => ({ ...r, mode: 'auto' }))
  const judgment = { ...GOOD, matched_rule: 'green-done' }
  const calls = []
  const mk = () => setup({ rules, sessionContinuesOf: () => true, judge: { judge: async (arg) => { calls.push(arg); return { judgment, raw: '' } } } })
  const a = mk()
  a.store.add(done({ actionable: true }))
  await a.runner.idle()
  assert.equal(calls.length, 0, 'no model call')
  const veto = a.entries.find((e) => e.stage === 'code-veto')
  assert.ok(veto?.reasons.includes('action-item'), JSON.stringify(a.entries))
  const b = mk()
  b.store.add(done())
  await b.runner.idle()
  assert.equal(calls.length, 1,'a card whose summary has not settled is still judged')
})

// --- R4 ------------------------------------------------------------------------------------------------------------------------------
test('R4: the judge log entry of an auto done card carries sessionContinues from the facts the verdict used', async () => {
  const rules = DEFAULT_RULES.map((r) => ({ ...r, mode: 'auto' }))
  let continues = true
  const judge = { judge: async () => { continues = false; return { judgment: { ...GOOD, matched_rule: 'green-done' }, raw: '' } } }
  const { store, runner, entries } = setup({ rules, judge, sessionContinuesOf: () => continues })
  store.add(done())
  await runner.idle()
  const e = entries.find((x) => x.stage === 'judge')
  assert.ok(e.reasons.includes('session-finished'), JSON.stringify(e))
  assert.equal(e.sessionContinues, false)
})

// --- R5 ------------------------------------------------------------------------------------------------------------------------------
test('R5: duplicate path candidates count once and more than 64 distinct ones fail closed', async () => {
  const base = mkdtempSync(join(tmpdir(), 'rq-cap-'))
  try {
    const ws = join(base, 'ws')
    mkdirSync(ws)
    writeFileSync(join(ws, 'top.txt'), 't')
    let calls = 0
    const io = { real: async (p) => { calls++; return p } }
    assert.equal(await containedInWorkspace('cat ' + Array(200).fill('top.txt').join(' '), ws, io), true)
    assert.equal(calls, 2, 'the root and the one distinct candidate')
    const many = (k) => 'cat ' + Array.from({ length: k }, (_, i) => 'src/f' + i + '.txt').join(' ')
    assert.equal(await containedInWorkspace(many(64), ws, io), true)
    calls = 0
    assert.equal(await containedInWorkspace(many(65), ws, io), false)
    assert.equal(calls, 0, 'over the cap: no file-system call')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// --- R6 ------------------------------------------------------------------------------------------------------------------------------
test('R6: the adapter resolveIf works detached and still records the resolve op', () => {
  let n = 0
  const a = createStoreAdapter({ instanceId: 'abcd1234', now: () => 1000, randomHex: () => 'x' + ++n })
  const item = a.add({ type: 'completed', sessionId: 's1', payload: { reply: 'x' } })
  const { resolveIf } = a // detached: no `this`
  assert.equal(resolveIf(item.id, (i) => i.id === 'nope', { kind: 'reviewed' }), false, 'a failing test resolves nothing')
  const before = a.n
  assert.equal(resolveIf(item.id, (i) => i.status === 'open', { kind: 'reviewed' }), true)
  assert.equal(a.get(item.id).status, 'resolved')
  assert.equal(a.n, before + 1)
  assert.equal(a.outbox().at(-1).op, 'resolve')
  assert.equal(resolveIf(item.id, () => true, { kind: 'reviewed' }), false, 'already resolved')
  assert.equal(a.n, before + 1)
  assert.equal(resolveIf('ghost', () => true, {}), false)
})
