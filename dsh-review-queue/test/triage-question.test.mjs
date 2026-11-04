// AI triage, observe mode, for QUESTION items (rule "straightforward-question"): the AI may only PROPOSE an answer when the user already asked for exactly
// that earlier in the session (a verbatim quote from a user-authored source). Nothing is ever answered in this phase; the proposal is logged, shown on the card
// and compared with what the user then answers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createTriageMemory } from '../triage-memory.js'
import { createTriageRunner, factsOf, feedbackOf, userDidWhatAiWould, wouldText, DEFAULT_RULES } from '../triage-runner.js'

const RULE_ID = 'straightforward-question'
const QRULE = { id: RULE_ID, name: 'Straightforward questions', class: 'question', enabled: true, mode: 'observe', instruction: 'Answer only with a quote from a user-authored source.' }
const ASK = 'Post both replies and resolve the threads?'
const YES = 'Yes, post and resolve'
const QUOTE = 'post both replies and resolve the threads'
const SOURCES = [
  { id: 'user-9', text: 'Please post both replies and resolve the threads once the tests pass.', userAuthored: true },
  { id: 'item-body', text: 'I propose we post both replies and resolve the threads. (assistant text)', userAuthored: false },
]
const question = (over = {}) => ({ type: 'question', sessionId: 's1', workspace: 'D:/w', payload: { questions: [{ id: 'q1', question: ASK, options: [{ label: YES }, { label: 'No, let me review first' }] }] }, ...over })
const GOOD = { needs_decision: false, answer_basis: 'quoted-source', answer: YES, evidence_quote: QUOTE, evidence_source: 'user-9', matched_rule: RULE_ID, attention: 8 }

function setup({ judgment = GOOD, rules = [QRULE], sourcesOf = () => SOURCES, ...deps } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const calls = []
  const entries = []
  const judge = { judge: async (arg) => { calls.push(arg); return { judgment, raw: '' } } }
  const runner = createTriageRunner({ store, judge, rules, sourcesOf, triageLog: { append: (e) => entries.push(e) }, log: () => {}, ...deps })
  assert.equal(runner.start(), true)
  return { store, runner, calls, entries }
}

// --- A. the default rule ---
test('DEFAULT_RULES holds exactly one question rule, straightforward-question, observe mode, quote-only, no closed set', () => {
  const qs = DEFAULT_RULES.filter((r) => r.class === 'question')
  assert.equal(qs.length, 1)
  const [r] = qs
  assert.equal(r.id, RULE_ID)
  assert.equal(r.enabled, true)
  assert.equal(r.mode, 'observe')
  assert.ok(!('closedSet' in r), 'no closedSet')
  assert.ok(typeof r.instruction === 'string' && r.instruction.trim().length > 0)
  assert.match(r.instruction, /user-authored/i)
  assert.match(r.instruction, /quote/i)
})

test('the two existing default rules are unchanged', () => {
  const ro = DEFAULT_RULES.find((r) => r.id === 'ro-permission')
  const gd = DEFAULT_RULES.find((r) => r.id === 'green-done')
  assert.deepEqual([ro.class, ro.mode, ro.enabled], ['permission', 'observe', true])
  assert.equal(ro.instruction, 'A read-only command that passes the strict parser, inside the workspace: approve.')
  assert.deepEqual([gd.class, gd.mode, gd.enabled], ['done', 'observe', true])
  assert.match(gd.instruction, /^A done message that only reports passing tests/)
})

// --- B. facts ---
test('factsOf: a question is safe for judging only when it holds exactly one question', () => {
  const one = factsOf(question())
  assert.equal(one.safe, true)
  assert.deepEqual(one.riskFlags, [])
  const two = question({ payload: { questions: [{ id: 'a', question: 'A?' }, { id: 'b', question: 'B?' }] } })
  assert.equal(factsOf(two).safe, false)
  assert.equal(factsOf(question({ payload: { questions: [] } })).safe, false)
  assert.equal(factsOf(question({ payload: {} })).safe, false)
})

// --- C. runner ---
test('a single-question item reaches the judge (answer_basis none is no pre-check veto) and a quoted user request makes a "would answer" proposal', async () => {
  const { store, runner, calls, entries } = setup()
  const item = store.add(question())
  await runner.idle()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].sources, SOURCES)
  const t = store.get(item.id).triage
  assert.equal(t.mode, 'observe')
  assert.equal(t.verdict, 'handle')
  assert.equal(t.ruleId, RULE_ID)
  assert.equal(t.answer, YES)
  assert.equal(typeof t.would, 'string')
  assert.ok(t.would.includes(YES))
  assert.equal(store.get(item.id).status, 'open', 'nothing is answered or resolved')
  assert.equal(store.get(item.id).resolution, undefined)
  const e = entries.at(-1)
  assert.deepEqual([e.stage, e.verdict, e.ruleId], ['judge', 'handle', RULE_ID])
  assert.deepEqual(e.judgment, GOOD)
})

test('a multi-question item is a code veto: the judge is never called', async () => {
  const { store, runner, calls, entries } = setup()
  store.add(question({ payload: { questions: [{ id: 'a', question: 'A?' }, { id: 'b', question: 'B?' }] } }))
  await runner.idle()
  assert.equal(calls.length, 0)
  assert.equal(entries.at(-1).stage, 'code-veto')
})

test('sourcesOf may return a promise; it is awaited once and the same result serves the judge and the verdict', async () => {
  let asked = 0
  const { store, runner, calls } = setup({ sourcesOf: async () => { asked++; return SOURCES } })
  const item = store.add(question())
  await runner.idle()
  assert.equal(asked, 1)
  assert.deepEqual(calls[0].sources, SOURCES)
  assert.equal(store.get(item.id).triage?.verdict, 'handle')
})

test('a sourcesOf that throws or rejects means no sources: no crash, and the quote is inadmissible', async () => {
  const bad = { sync: () => { throw new Error('boom') }, rejects: async () => { throw new Error('boom') } }
  for (const [name, sourcesOf] of Object.entries(bad)) {
    const { store, runner, calls, entries } = setup({ sourcesOf })
    const item = store.add(question())
    await runner.idle()
    assert.equal(calls.length, 1, name)
    assert.deepEqual(calls[0].sources, [], name)
    assert.equal(store.get(item.id).triage, undefined, name)
    assert.deepEqual([entries.at(-1).stage, entries.at(-1).verdict], ['judge', 'ask'], name)
    assert.ok(entries.at(-1).reasons.includes('inadmissible-evidence'), name)
  }
})

test('the code vetoes a question proposal with the right reason (table)', async () => {
  const cases = [
    ['quote not in any source', { ...GOOD, evidence_quote: 'never ask me anything again please' }, 'inadmissible-evidence'],
    ['quote only in a source the user did not write', { ...GOOD, evidence_quote: 'I propose we post both replies', evidence_source: 'item-body' }, 'inadmissible-evidence'],
    ['needs_decision', { ...GOOD, needs_decision: true }, 'needs-decision'],
    ['no answer basis', { ...GOOD, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null }, 'no-basis'],
    ['answer is not an offered option', { ...GOOD, answer: 'Post only the first reply' }, 'answer-not-an-option'],
  ]
  for (const [name, judgment, reason] of cases) {
    const { store, runner, calls, entries } = setup({ judgment })
    const item = store.add(question())
    await runner.idle()
    assert.equal(calls.length, 1, name)
    assert.equal(store.get(item.id).triage, undefined, name)
    assert.deepEqual([entries.at(-1).stage, entries.at(-1).verdict], ['judge', 'ask'], name)
    assert.ok(entries.at(-1).reasons.includes(reason), name + ': ' + entries.at(-1).reasons)
  }
})

test('a free-text question (no options) may be answered with the quoted text', async () => {
  const { store, runner } = setup({ judgment: { ...GOOD, answer: 'Post both and resolve' } })
  const item = store.add(question({ payload: { questions: [{ id: 'q1', question: ASK }] } }))
  await runner.idle()
  assert.equal(store.get(item.id).triage?.answer, 'Post both and resolve')
})

test('a question rule in auto mode still only observes: the item stays open and nothing is answered', async () => {
  const { store, runner } = setup({ rules: [{ ...QRULE, mode: 'auto' }], judgment: { ...GOOD, answer: YES + ' (Recommended)' } })
  const q = question()
  const item = store.add({ ...q, payload: { ...q.payload, callId: 'c1', questions: [{ ...q.payload.questions[0], options: [{ label: YES + ' (Recommended)' }, { label: 'No' }] }] } }) // a simple card with a recommended option (auto needs a call id); no actor is registered here, so it only observes
  await runner.idle()
  assert.equal(store.get(item.id).status, 'open')
  assert.equal(store.get(item.id).triage.mode, 'observe')
  assert.equal(store.get(item.id).triage.verdict, 'handle')
})

// --- D. wouldText ---
test('wouldText: a question proposal reads answer "<answer>", capped at 120 characters; the other texts are unchanged', () => {
  const q = question()
  assert.equal(wouldText(q, { answer: YES }), 'answer "' + YES + '"')
  const long = wouldText(q, { answer: 'x'.repeat(300) })
  assert.match(long, /^answer "x+/)
  assert.ok(long.includes('x'.repeat(120)))
  assert.ok(!long.includes('x'.repeat(121)))
  assert.equal(wouldText({ type: 'permission' }), 'approve this read-only command')
  assert.equal(wouldText({ type: 'completed' }), 'clear this done card as handled')
})

// --- E. feedback ---
const answered = (kind, answers, answer = YES) => ({ id: 'q1', type: 'question', status: 'resolved', payload: question().payload, resolution: { kind, by: 'card', answers }, triage: { verdict: 'handle', ruleId: RULE_ID, ruleVersion: 'abcd1234', answer, would: 'answer "' + answer + '"', score: 8 } })
const pick = (label) => [{ id: 'q1', selected: [label] }]

test('userDidWhatAiWould for questions: the same answer (trimmed, any case) is true, another one false', () => {
  for (const kind of ['answered', 'confirmed']) {
    assert.equal(userDidWhatAiWould(answered(kind, pick(YES))), true, kind)
    assert.equal(userDidWhatAiWould(answered(kind, pick('  yes, POST and resolve '))), true, kind)
    assert.equal(userDidWhatAiWould(answered(kind, pick('No, let me review first'))), false, kind)
  }
  assert.equal(userDidWhatAiWould(answered('answered', [{ id: 'q1', selected: [], custom: YES }])), true, 'a typed answer counts')
  assert.equal(userDidWhatAiWould(answered('answered', [{ id: 'q1', selected: [], custom: 'Something else' }])), false)
})

test('userDidWhatAiWould for questions: other resolution kinds cannot be compared', () => {
  for (const kind of ['expired', 'cancelled', 'dismissed']) assert.equal(userDidWhatAiWould(answered(kind, undefined)), undefined, kind)
})

test('feedbackOf for a question: matched-user when the user chose the proposed answer, overruled otherwise', () => {
  assert.equal(feedbackOf(answered('answered', pick(YES))), 'matched-user')
  assert.equal(feedbackOf(answered('answered', pick('No, let me review first'))), 'overruled')
  assert.equal(feedbackOf(answered('expired', undefined)), undefined)
})

test('end to end: the user answers differently, the runner records overruled and learns a lesson for question items', async () => {
  const memory = createTriageMemory()
  const { store, runner, entries } = setup({ memory })
  const item = store.add(question())
  await runner.idle()
  assert.equal(store.get(item.id).triage?.verdict, 'handle')
  store.resolve(item.id, { kind: 'answered', by: 'card', answers: pick('No, let me review first') })
  assert.equal(store.get(item.id).triage.review, 'overruled')
  assert.equal(entries.at(-1).stage, 'feedback')
  assert.equal(memory.lessons().length, 1)
  assert.equal(memory.lessons()[0].ruleId, RULE_ID)
})


test('the stored proposed answer is whitespace-collapsed and clipped to 200 characters with an ellipsis; the log keeps the judgment as is', async () => {
	const long = 'Yes,   post\nboth\treplies ' + 'and resolve '.repeat(40)
	const free = question({ payload: { questions: [{ id: 'q1', question: ASK }] } })
	const { store, runner, entries } = setup({ judgment: { ...GOOD, answer: long } })
	const item = store.add(free)
	await runner.idle()
	const a = store.get(item.id).triage?.answer
	assert.equal(typeof a, 'string')
	assert.equal(a.length, 200)
	assert.ok(a.endsWith('\u2026'))
	assert.ok(!/\s{2}|[\n\t]/.test(a))
	assert.ok(a.startsWith('Yes, post both replies and resolve'))
	assert.ok(JSON.stringify(entries).includes('and resolve'), 'log entry still written')
	// a short answer is only collapsed, never given an ellipsis
	const s = setup({ judgment: { ...GOOD, answer: ' Yes,\n  go ' } })
	const it2 = s.store.add(free)
	await s.runner.idle()
	assert.equal(s.store.get(it2.id).triage?.answer, 'Yes, go')
})
