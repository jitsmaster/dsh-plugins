// Slice 5 of Auto triage: the question actor (rule straightforward-question) and its auto-only vetoes. Observe is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { installCapture } from '../capture.js'
import { triageOutcome } from '../triage.js'
import { createTriageRunner, factsOf, DEFAULT_RULES } from '../triage-runner.js'
import { createQuestionActor } from '../triage-act-question.js'
import { loadClient } from './client-todo-helpers.mjs'

const RULE_ID = 'straightforward-question'
const ASK = 'Post both replies and resolve the threads?'
const YES = 'Yes, post and resolve (Recommended)'
const NO = 'No, let me review first'
const QUOTE = 'post both replies and resolve the threads'
const SOURCES = [
  { id: 'user-9', text: 'Please post both replies and resolve the threads once the tests pass.', userAuthored: true },
  { id: 'item-body', text: 'I propose we post both replies and resolve the threads. (assistant text)', userAuthored: false },
]
const GOOD = { needs_decision: false, answer_basis: 'quoted-source', answer: YES, evidence_quote: QUOTE, evidence_source: 'user-9', matched_rule: RULE_ID, attention: 8 }
const q1 = (over = {}) => ({ id: 'q1', question: ASK, options: [{ label: YES }, { label: NO }], ...over })
const question = (qs = [q1()], over = {}, payload = {}) => ({ id: 'i1', type: 'question', sessionId: 's1', workspace: 'D:/w', payload: { questions: qs, callId: 'c1', ...payload }, ...over })
const rule = (mode) => ({ id: RULE_ID, name: 'q', class: 'question', enabled: true, mode })
const verdict = (mode, { item = question(), judgment = GOOD, sources = SOURCES } = {}) => triageOutcome({ item, judgment, rule: rule(mode), facts: factsOf(item), sources })
const modeRules = (mode) => DEFAULT_RULES.map((r) => ({ ...r, mode }))

// --- the pure verdict ---------------------------------------------------------------------------------------------------------------
test('auto: a simple option question with the exact label and a user quote is handled and acted on', () => {
  const v = verdict('auto')
  assert.deepEqual([v.verdict, v.act, v.reasons], ['handle', true, []])
})

const NOT_SIMPLE = [
  ['free-text question (no options)', question([q1({ options: [] })]), ['question-not-simple', 'answer-not-an-option']],
  ['options missing', question([q1({ options: undefined })]), ['question-not-simple', 'answer-not-an-option']],
  ['multiple questions', question([q1(), q1({ id: 'q2' })]), ['unsafe', 'question-not-simple']],
  ['multiSelect', question([q1({ multiSelect: true })]), ['question-not-simple']],
  ['intent (plan review)', question([q1({ intent: 'plan-review' })]), ['question-not-simple']],
  ['detached', question([q1()], { detached: true }), ['question-not-simple']],
  ['missing callId', question([q1()], {}, { callId: undefined }), ['question-not-simple']],
]
for (const [name, item, reasons] of NOT_SIMPLE) {
  test('auto: ' + name + ' is asked with its reason', () => {
    const v = verdict('auto', { item })
    assert.equal(v.verdict, 'ask')
    assert.equal(v.act, false)
    assert.deepEqual(v.reasons, reasons)
  })
}

const BAD_ANSWER = [
  ['answer not an option', { ...GOOD, answer: 'Maybe' }, ['answer-not-an-option']],
  ['answer differs in case', { ...GOOD, answer: YES.toLowerCase() }, ['answer-not-an-option']],
  ['answer with extra whitespace', { ...GOOD, answer: YES + ' ' }, ['answer-not-an-option']],
  ['answer is not a string', { ...GOOD, answer: null }, ['answer-not-an-option']],
  ['quote from the item text (not user authored)', { ...GOOD, evidence_source: 'item-body', evidence_quote: 'post both replies and resolve the threads. (assistant' }, ['inadmissible-evidence']],
  ['quote not verbatim', { ...GOOD, evidence_quote: 'post only one reply and resolve' }, ['inadmissible-evidence']],
  ['missing evidence_source', { ...GOOD, evidence_source: undefined }, ['inadmissible-evidence']],
  ['closed-set basis', { ...GOOD, answer_basis: 'closed-set' }, ['answer-not-in-set', 'inadmissible-evidence']],
]
for (const [name, judgment, reasons] of BAD_ANSWER) {
  test('auto: ' + name + ' is asked', () => {
    const v = verdict('auto', { judgment })
    assert.equal(v.verdict, 'ask')
    assert.equal(v.act, false)
    assert.deepEqual(v.reasons, reasons)
  })
}

test('auto: the answer must be exactly the recommended option, and a card that marks none is never answered', () => {
  assert.deepEqual(verdict('auto', { judgment: { ...GOOD, answer: YES } }).reasons, [])
  assert.deepEqual(verdict('auto', { judgment: { ...GOOD, answer: NO } }).reasons, ['answer-not-recommended'])
  const plain = question([q1({ options: [{ label: 'Yes' }, { label: NO }] })])
  assert.deepEqual(verdict('auto', { item: plain, judgment: { ...GOOD, answer: 'Yes' } }).reasons, ['no-recommended-option'])
  assert.deepEqual(verdict('auto', { item: plain, judgment: { ...GOOD, answer: NO } }).reasons, ['no-recommended-option'])
})

test('missing facts fail closed in auto', () => {
  const v = triageOutcome({ item: question(), judgment: GOOD, rule: rule('auto'), facts: { riskFlags: [], safe: true }, sources: SOURCES })
  assert.deepEqual([v.verdict, v.reasons], ['ask', ['question-not-simple']])
})

test('observe: the same inputs keep their verdicts and reasons (no new reason codes)', () => {
  for (const [, item] of NOT_SIMPLE) {
    const v = verdict('observe', { item })
    assert.ok(!v.reasons.includes('question-not-simple'))
  }
  assert.deepEqual(verdict('observe', { item: question([q1({ options: [] })]) }).reasons, [])
  assert.deepEqual(verdict('observe', { item: question([q1({ multiSelect: true })], { detached: true }, { callId: undefined }) }).reasons, [])
  assert.deepEqual(verdict('observe', { judgment: { ...GOOD, answer: YES.toLowerCase() + ' ' } }).reasons, [], 'observe still accepts a case/space variant')
  assert.deepEqual(verdict('observe', { judgment: { ...GOOD, answer: NO } }).reasons, [])
  assert.deepEqual(verdict('observe', { item: question([q1({ options: [{ label: 'Yes' }, { label: NO }] })]), judgment: { ...GOOD, answer: 'Yes' } }).reasons, [], 'observe needs no recommended option')
  const v = verdict('observe')
  assert.deepEqual([v.verdict, v.act, v.reasons], ['handle', false, []])
})

// --- the actor ----------------------------------------------------------------------------------------------------------------------
const rbase = { kind: 'ai-resolved', by: 'ai', ruleId: RULE_ID, ruleVersion: 'abcd1234', threshold: 25, score: 8, decidedAt: 5000, basis: 'quoted-source', evidenceSource: 'user-9', quote: QUOTE }
const fakeStore = () => { let n = 0; return createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n }) }
const add = (store, qs = [q1()], payload = {}) => store.add({ type: 'question', sessionId: 's1', workspace: 'D:/w', payload: { questions: qs, callId: 'c1', ...payload } })
const run = (store, item, answer, judgment = GOOD, rb = rbase) => createQuestionActor({ store, answer })({ item, judgment, resolutionBase: rb })

test('actor: answers with the exact card label and an ai-resolved resolution carrying answers, answer and quote', async () => {
  const store = fakeStore()
  const item = add(store)
  const calls = []
  const res = await run(store, item, (...a) => { calls.push(a); return { ok: true } })
  assert.deepEqual(res, { ok: true, action: 'answered', answer: YES, quote: QUOTE, evidenceSource: 'user-9', basis: 'quoted-source' })
  const answers = [{ id: 'q1', selected: [YES] }]
  assert.deepEqual(calls, [[item.id, answers, { ...rbase, action: 'answered', answer: YES, answers, quote: QUOTE }]])
})

test('actor: a true result is a success; false / { ok:false } is not-pending', async () => {
  const store = fakeStore()
  const item = add(store)
  assert.equal((await run(store, item, () => true)).ok, true)
  assert.deepEqual(await run(store, item, () => false), { ok: false, reason: 'not-pending' })
  assert.deepEqual(await run(store, item, () => ({ ok: false, error: 'not-pending' })), { ok: false, reason: 'not-pending' })
  assert.deepEqual(await run(store, item, async () => ({ ok: false, error: 'bad-answer' })), { ok: false, reason: 'not-pending' })
})

test('actor: caps the answer at 200 and the quote at 300', async () => {
  const long = 'L'.repeat(240) + ' (Recommended)'
  const store = fakeStore()
  const item = add(store, [q1({ options: [{ label: long }, { label: NO }] })])
  const calls = []
  const res = await run(store, item, (...a) => { calls.push(a); return true }, { ...GOOD, answer: long, evidence_quote: 'quote words '.repeat(50) }, { ...rbase, quote: 'quote words '.repeat(50).slice(0, 300) })
  assert.equal(res.ok, true)
  const r = calls[0][2]
  assert.equal(r.answer.length, 200)
  assert.equal(r.answers[0].selected[0], long, 'the real label is sent whole, only the display copy is capped')
  assert.equal(r.quote.length, 300)
})

test('actor: refuses (and never answers) when the question, an option label or the call id changed since it was judged', async () => {
  const changes = [
    [[q1({ question: 'Something else?' })], {}],
    [[q1({ options: [{ label: YES }, { label: 'Other' }] })], {}],
    [[q1({ options: [{ label: YES }] })], {}],
    [[q1()], { callId: 'c2' }],
    [[q1(), q1({ id: 'q2' })], {}],
  ]
  for (const [qs, payload] of changes) {
    const store = fakeStore()
    const item = add(store)
    store.update(item.id, { payload: { ...item.payload, questions: qs, ...payload } })
    let called = 0
    const res = await run(store, item, () => { called++; return true })
    assert.deepEqual(res, { ok: false, reason: 'changed' }, JSON.stringify(payload))
    assert.equal(called, 0)
  }
})

test('actor: refuses a judged answer that is not exactly one of the current labels; refuses non-question, resolved and missing items', async () => {
  let called = 0
  const answer = () => { called++; return true }
  const store = fakeStore()
  const item = add(store)
  for (const bad of ['Maybe', YES.toLowerCase(), YES + ' ', undefined, 42]) assert.deepEqual(await run(store, item, answer, { ...GOOD, answer: bad }), { ok: false, reason: 'refused' })
  const done = store.add({ type: 'completed', sessionId: 's1', payload: { reply: 'x' } })
  assert.equal((await run(store, done, answer)).ok, false)
  const resolved = add(store)
  store.resolve(resolved.id, { kind: 'answered', by: 'card' })
  assert.deepEqual(await run(store, resolved, answer), { ok: false, reason: 'not-pending' })
  assert.equal((await run(store, { ...item, id: 'ghost' }, answer)).ok, false)
  assert.deepEqual(await createQuestionActor({ store, answer })({}), { ok: false, reason: 'refused' })
  assert.equal(called, 0)
})

test('actor: an answer that throws is an error result, never a throw', async () => {
  const store = fakeStore()
  const item = add(store)
  assert.deepEqual(await run(store, item, () => { throw new Error('boom') }), { ok: false, reason: 'error' })
  assert.deepEqual(await run(store, item, async () => { throw new Error('boom') }), { ok: false, reason: 'error' })
})

// --- end to end through the runner --------------------------------------------------------------------------------------------------
function setup({ rules = modeRules('auto'), hook, answerResult = true, judgment = GOOD, sources = SOURCES, ...deps } = {}) {
  const store = fakeStore()
  const entries = []
  const answered = []
  const judge = { judge: async () => { await hook?.(store); return { judgment, raw: '' } } }
  const answer = (id, answers, resolution) => { answered.push([id, answers, resolution]); return typeof answerResult === 'function' ? answerResult(id, answers, resolution) : answerResult }
  const runner = createTriageRunner({ store, judge, triageLog: { append: (e) => entries.push(e) }, rules, sourcesOf: () => sources, actors: { question: createQuestionActor({ store, answer }) }, ...deps })
  assert.equal(runner.start(), true)
  return { store, runner, entries, answered }
}
const stage = (entries, s) => entries.filter((e) => e.stage === s)
const raise = (store) => add(store)

test('e2e auto: answered once with the exact label and an ai-resolved resolution; act done logged, no would-handle note', async () => {
  const { store, runner, entries, answered } = setup()
  const item = raise(store)
  await runner.idle()
  assert.equal(answered.length, 1)
  assert.equal(answered[0][0], item.id)
  assert.deepEqual(answered[0][1], [{ id: 'q1', selected: [YES] }])
  const r = answered[0][2]
  assert.deepEqual([r.kind, r.by, r.action, r.answer, r.quote, r.ruleId, r.evidenceSource], ['ai-resolved', 'ai', 'answered', YES, QUOTE, RULE_ID, 'user-9'])
  const [a] = stage(entries, 'act')
  assert.deepEqual([a.result, a.action, a.basis, a.preState.answer], ['done', 'answered', 'quoted-source', YES])
  assert.equal(store.get(item.id).triage, undefined)
})

test('e2e observe, same inputs: note only, answer never called, no act entry', async () => {
  const { store, runner, entries, answered } = setup({ rules: modeRules('observe') })
  const item = raise(store)
  await runner.idle()
  assert.equal(answered.length, 0)
  assert.equal(store.get(item.id).status, 'open')
  assert.equal(store.get(item.id).triage.verdict, 'handle')
  assert.equal(store.get(item.id).triage.answer, YES)
  assert.equal(stage(entries, 'act').length, 0)
})

test('e2e auto: a card that is not a simple option question never reaches the model or the answer', async () => {
  for (const qs of [[q1({ options: [] })], [q1({ multiSelect: true })], [q1({ intent: 'plan-review' })]]) {
    const { store, runner, entries, answered } = setup()
    const item = add(store, qs)
    await runner.idle()
    assert.equal(answered.length, 0)
    assert.equal(store.get(item.id).status, 'open')
    assert.equal(stage(entries, 'judge').length, 0)
    assert.ok(stage(entries, 'code-veto')[0].reasons.includes('question-not-simple'))
  }
  const { store, runner, answered } = setup()
  add(store, [q1()], { callId: undefined })
  await runner.idle()
  assert.equal(answered.length, 0)
})

test('e2e auto: a model answer that is not an option or a quote that is not the user\'s is logged and the card stays open', async () => {
  for (const judgment of [{ ...GOOD, answer: YES.toUpperCase() }, { ...GOOD, evidence_source: 'item-body' }]) {
    const { store, runner, entries, answered } = setup({ judgment })
    const item = raise(store)
    await runner.idle()
    assert.equal(answered.length, 0)
    assert.equal(store.get(item.id).status, 'open')
    assert.equal(store.get(item.id).triage, undefined)
    assert.equal(stage(entries, 'judge')[0].verdict, 'ask')
  }
})

test('e2e auto: switch off, hold mark, payload changed between judge and act, answer not pending: not acted, item stays open', async () => {
  let on = true
  let held = false
  const cases = {
    'switch off': { deps: { enabled: () => on }, hook: () => { on = false } },
    'hold mark': { deps: { marksOf: () => ({ onHold: held }) }, hook: () => { held = true } },
    'payload changed': { hook: (store) => store.update(store.list()[0].id, { payload: { questions: [q1({ options: [{ label: YES }, { label: 'Changed' }] })], callId: 'c1' } }) },
    'answer not pending': { answerResult: { ok: false, error: 'not-pending' } },
  }
  for (const [name, c] of Object.entries(cases)) {
    on = true
    held = false
    const { store, runner, entries, answered } = setup({ ...c.deps, hook: c.hook, ...(c.answerResult ? { answerResult: c.answerResult } : {}) })
    const item = raise(store)
    await runner.idle()
    assert.equal(store.get(item.id).status, 'open', name)
    assert.equal(stage(entries, 'act').filter((e) => e.result === 'done').length, 0, name)
    if (name === 'payload changed' || name === 'answer not pending') {
      assert.equal(answered.length, name === 'answer not pending' ? 1 : 0, name)
      assert.equal(stage(entries, 'act')[0].result, name === 'answer not pending' ? 'lost-race' : 'refused', name)
    } else assert.equal(answered.length, 0, name)
  }
})

// --- real capture: the item really closes, once -------------------------------------------------------------------------------------
test('capture.answerQuestion with the actor resolution closes the item as ai-resolved with answers (a second call is not-pending)', async () => {
  const handlers = {}
  const ctx = { on: (name, fn) => { (handlers[name] ??= []).push(fn) }, get: () => undefined, logger: { warn() {}, info() {} } }
  const store = fakeStore()
  const capture = installCapture(ctx, { store, summarizer: { summarize: async () => ({ text: 'x', source: 'llm' }) } })
  const agent = { id: 'a1', session: { id: 'a1', header: { cwd: 'D:/proj' }, deriveMessages: () => [] } }
  const p = handlers['user-questions/request'][0]({ agent, questions: [q1()], wait: { callId: 'c1' } }, () => new Promise(() => {}))
  const [item] = store.snapshot().open
  const actor = createQuestionActor({ store, answer: (id, answers, resolution) => capture.answerQuestion(id, answers, { resolution }) })
  const res = await actor({ item, judgment: GOOD, resolutionBase: rbase })
  assert.equal(res.ok, true)
  assert.deepEqual(await p, { answers: [{ id: 'q1', selected: [YES] }] })
  const r = store.get(item.id)
  assert.equal(r.status, 'resolved')
  assert.deepEqual([r.resolution.kind, r.resolution.answer, r.resolution.answers[0].selected[0]], ['ai-resolved', YES, YES])
  assert.deepEqual(await actor({ item, judgment: GOOD, resolutionBase: rbase }), { ok: false, reason: 'not-pending' })
})
// --- shared rendering ---------------------------------------------------------------------------------------------------------------
test('an AI-answered question card renders with the answer and the quote through the shared helpers, no undefined', () => {
  const { mod } = loadClient()
  const S = mod.shared
  const answers = [{ id: 'q1', selected: [YES] }]
  const item = { id: 'x', type: 'question', status: 'resolved', title: ASK, resolution: { ...rbase, action: 'answered', answer: YES, answers, quote: QUOTE }, triage: { ruleName: 'Straightforward questions' } }
  const text = S.resolutionText(item)
  assert.equal(text, 'AI answered: ' + YES)
  assert.ok(!/undefined|\[object/.test(text))
  const d = S.aiDetail(item)
  assert.equal(d.quote, QUOTE)
  assert.equal(d.ruleName, 'Straightforward questions')
  assert.equal(S.answerText(answers), YES)
})
