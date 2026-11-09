// Tests for the mode guard rails: the weaker needs-user check (PR/handoff/ticket mentions ignored) applies to an observe rule AND an auto rule;
// any other mode (off, unknown, missing) fails closed on the strict check. Also the reworded green-done rule text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { triageOutcome } from '../triage.js'
import { createTriageRunner, factsOf, ruleVersion, DEFAULT_RULES } from '../triage-runner.js'

const PR_ONLY = 'Merged the change.\n\nPR #123 is open.'
const doneItem = (reply = PR_ONLY) => ({ id: 'i1', type: 'completed', status: 'open', sessionId: 's1', workspace: 'D:/w', payload: { reply } })
const judgment = { needs_decision: false, answer_basis: 'none', attention: 0, matched_rule: 'r1' }
const rule = (over) => ({ id: 'r1', name: 'r', class: 'done', enabled: true, mode: 'observe', ...over })
// strict check says "needs the user", the weaker (observe) check says "does not"
const weakOk = { riskFlags: [], safe: true, needsUser: true, needsUserObserve: false, sessionContinues: true }
const run = (over) => triageOutcome({ item: doneItem(), judgment, rule: rule(), facts: weakOk, sources: [], marks: {}, ...over })

test('factsOf exposes the strict check as needsUser and the weaker one as needsUserObserve for a PR-only done reply', () => {
  const f = factsOf({ type: 'completed', payload: { reply: PR_ONLY } })
  assert.equal(f.needsUser, true)
  assert.equal(f.needsUserObserve, false)
})

test('factsOf: a reply that really asks needs the user under both checks', () => {
  const f = factsOf({ type: 'completed', payload: { reply: 'PR #123 is open. Should I merge it?' } })
  assert.equal(f.needsUser, true)
  assert.equal(f.needsUserObserve, true)
})

test('observe rule: the weaker check applies, so a PR-only done card has no needs-user veto', () => {
  const o = run()
  assert.equal(o.reasons.includes('needs-user'), false)
  assert.equal(o.verdict, 'handle')
})

test('auto rule: the weaker check applies too, so a PR-only done card has no needs-user veto', () => {
  const o = run({ rule: rule({ mode: 'auto' }), facts: { ...weakOk, actionItem: false, summaryPending: false } })
  assert.equal(o.reasons.includes('needs-user'), false)
  assert.equal(o.verdict, 'handle')
  assert.equal(o.act, true)
})

test('auto rule still vetoes when the weaker check says the user is needed', () => {
  const o = run({ rule: rule({ mode: 'auto' }), facts: { ...weakOk, needsUserObserve: true, actionItem: false, summaryPending: false } })
  assert.ok(o.reasons.includes('needs-user'))
  assert.equal(o.act, false)
})

test('an off rule fails closed: the strict check applies', () => {
  assert.ok(run({ rule: rule({ mode: 'off' }) }).reasons.includes('needs-user'))
})

test('a rule with no mode fails closed: the strict check applies', () => {
  assert.ok(run({ rule: rule({ mode: undefined }) }).reasons.includes('needs-user'))
})

test('a rule with an unknown mode fails closed: the strict check applies', () => {
  assert.ok(run({ rule: rule({ mode: 'Observe' }) }).reasons.includes('needs-user'))
})

test('an observe rule still vetoes when the weaker check also says the user is needed', () => {
  assert.ok(run({ facts: { ...weakOk, needsUserObserve: true } }).reasons.includes('needs-user'))
})

test('an observe rule with only the strict field set (old facts shape) falls back to it', () => {
  assert.ok(run({ facts: { riskFlags: [], safe: true, needsUser: true, sessionContinues: true } }).reasons.includes('needs-user'))
  assert.equal(run({ facts: { riskFlags: [], safe: true, needsUser: false, sessionContinues: true } }).reasons.includes('needs-user'), false)
})

test('an auto rule with only the strict field set (old facts shape) falls back to it', () => {
  const base = { riskFlags: [], safe: true, sessionContinues: true, actionItem: false, summaryPending: false }
  assert.ok(run({ rule: rule({ mode: 'auto' }), facts: { ...base, needsUser: true } }).reasons.includes('needs-user'))
  assert.equal(run({ rule: rule({ mode: 'auto' }), facts: { ...base, needsUser: false } }).reasons.includes('needs-user'), false)
})

test('a rule with neither needs-user field set is a veto in every mode', () => {
  const facts = { riskFlags: [], safe: true, sessionContinues: true, actionItem: false, summaryPending: false }
  for (const mode of ['observe', 'auto']) assert.ok(run({ rule: rule({ mode }), facts }).reasons.includes('needs-user'), mode)
})

// --- through the runner ---
const GREEN_DONE = { needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null, matched_rule: 'green-done', attention: 5 }
function setup({ rules, sessionContinuesOf = () => true } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const calls = []
  const entries = []
  const runner = createTriageRunner({ store, rules, sessionContinuesOf, judge: { judge: async (a) => { calls.push(a); return { judgment: GREEN_DONE, raw: '' } } }, triageLog: { append: (e) => entries.push(e) }, log: () => {} })
  assert.equal(runner.start(), true)
  return { store, runner, calls, entries }
}

test('runner, observe rule: a done card that only mentions a PR still reaches handle', async () => {
  const { store, runner, calls } = setup()
  const item = store.add({ type: 'completed', sessionId: 's1', workspace: 'D:/w', payload: { reply: PR_ONLY } })
  await runner.idle()
  assert.equal(calls.length, 1)
  assert.equal(store.get(item.id).triage?.verdict, 'handle')
})

test('runner, auto rule: a PR-only done card is not a needs-user code veto (other auto safeguards still apply)', async () => {
  const rules = DEFAULT_RULES.map((r) => ({ ...r, mode: 'auto' }))
  const { store, runner, entries } = setup({ rules })
  store.add({ type: 'completed', sessionId: 's1', workspace: 'D:/w', payload: { reply: PR_ONLY } })
  await runner.idle()
  for (const e of entries) assert.equal((e.reasons ?? []).includes('needs-user'), false)
})

test('runner, auto rule: a done card that really asks is a needs-user code veto with no model call', async () => {
  const rules = DEFAULT_RULES.map((r) => ({ ...r, mode: 'auto' }))
  const { store, runner, calls, entries } = setup({ rules })
  const item = store.add({ type: 'completed', sessionId: 's1', workspace: 'D:/w', payload: { reply: 'PR #123 is open. Should I merge it now?' } })
  await runner.idle()
  assert.equal(calls.length, 0)
  assert.equal(store.get(item.id).triage, undefined)
  assert.equal(entries.at(-1).stage, 'code-veto')
  assert.ok(entries.at(-1).reasons.includes('needs-user'))
})

// --- green-done wording ---
const greenDone = () => DEFAULT_RULES.find((r) => r.id === 'green-done')

test('green-done no longer claims the session must continue', () => {
  assert.equal(greenDone().instruction.includes('while the session continues'), false)
})

test('green-done still describes a mechanical step with no question or follow-up', () => {
  assert.match(greenDone().instruction, /no question or follow-up/)
  assert.match(greenDone().instruction, /mechanical/)
})

test('green-done has a new rule version, since its text changed', () => {
  assert.notEqual(ruleVersion(greenDone()), 'c32e29ce')
})

// --- done-card judge guidance ---
async function systemFor(rules) {
  const { createTriageJudge } = await import('../triage-judge.js')
  const seen = {}
  const llm = { listProviders: async () => [{ id: 'p1' }], listModels: async () => [{ id: 'claude-haiku-x' }], prepareCall: async () => ({ config: {}, stream: async function* (req) { seen.system = req.system; yield { type: 'text-delta', text: '{}' } } }) }
  await createTriageJudge({ llm }).judge({ item: doneItem(), rules })
  return seen.system
}
const doneRule = () => ({ id: 'green-done', class: 'done', instruction: 'x' })

test('judge: a done rule adds guidance that a completed-work message with no question or follow-up scores low and matches the done rule', async () => {
  const s = await systemFor([doneRule()])
  assert.match(s, /DONE items/)
  assert.match(s, /only reports finished work or passing tests/i)
  assert.match(s, /attention of 25 or less/i)
  assert.match(s, /match the done rule/i)
})

test('judge: the done guidance also covers a pure waiting status (work still running, the assistant continues by itself)', async () => {
  const s = await systemFor([doneRule()])
  assert.match(s, /still running in the background/i)
  assert.match(s, /continue(s)? by itself/i)
})

test('judge: the done guidance keeps unsure and any question or follow-up as a high score', async () => {
  const s = await systemFor([doneRule()])
  assert.match(s, /When it asks a question, offers options, says something is blocked, or leaves a step for the user, give an attention above 50/)
  assert.match(s, /If unsure, answer above 50/)
  assert.doesNotMatch(s, /green-done/) // the rule id may be renamed; the guidance says "the done rule"
})

test('judge: the score in the done and question guidance is the default threshold', async () => {
  const { DEFAULT_THRESHOLD } = await import('../triage.js')
  const s = await systemFor([doneRule(), { id: 'q', class: 'question', instruction: 'x' }])
  assert.equal(s.split('attention of ' + DEFAULT_THRESHOLD + ' or less').length - 1, 2, 'one in each guidance')
})

test('judge: no done guidance without a done rule, and no question guidance without a question rule', async () => {
  const q = await systemFor([{ id: 'q', class: 'question', instruction: 'x' }])
  assert.doesNotMatch(q, /DONE items/)
  const p = await systemFor([{ id: 'p', class: 'permission', instruction: 'x' }])
  assert.doesNotMatch(p, /DONE items/)
  assert.doesNotMatch(p, /QUESTION items/)
  const d = await systemFor([doneRule()])
  assert.doesNotMatch(d, /QUESTION items/)
})
