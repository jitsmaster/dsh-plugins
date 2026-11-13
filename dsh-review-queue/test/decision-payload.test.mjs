// Slice 4: a done card the judge says needs a decision keeps its type and gets decision { text, options[2-4], free: true }.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { parseJudgment } from '../triage-judge.js'
import { createTriageRunner, DEFAULT_RULES } from '../triage-runner.js'

const BASE = { needs_decision: true, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null, matched_rule: 'green-done', attention: 60 }
const parse = (over) => parseJudgment(JSON.stringify({ ...BASE, ...over }))

test('parseJudgment: valid decision text and 2-4 options are kept', () => {
  const j = parse({ decision_text: 'Which way?', decision_options: ['A', 'B', 'C'] }).judgment
  assert.deepEqual(j.decision, { text: 'Which way?', options: ['A', 'B', 'C'] })
})

test('parseJudgment: more than 4 options are cut to 4; one option or non-strings mean free text', () => {
  assert.equal(parse({ decision_text: 'Q', decision_options: ['A', 'B', 'C', 'D', 'E'] }).judgment.decision.options.length, 4)
  assert.deepEqual(parse({ decision_text: 'Q', decision_options: ['A'] }).judgment.decision.options, [])
  assert.deepEqual(parse({ decision_text: 'Q', decision_options: [1, { x: 1 }] }).judgment.decision.options, [])
})

test('parseJudgment: an option is cut by code points, never inside a surrogate pair', () => {
  const head = 'option '.repeat(17) // 119 code points (a long run of one letter would be redacted as a secret)
  const [o] = parse({ decision_text: 'Q', decision_options: [head + '😀tail', 'B'] }).judgment.decision.options
  assert.equal(o, head + '😀')
  assert.ok(!/[\ud800-\udbff]$/.test(o))
})

test('parseJudgment: no decision text means no decision; duplicates and blanks are dropped', () => {
  assert.equal(parse({ decision_options: ['A', 'B'] }).judgment.decision, undefined)
  assert.deepEqual(parse({ decision_text: 'Q', decision_options: ['A', 'A', ' ', 'B'] }).judgment.decision.options, ['A', 'B'])
})

const done = (over = {}) => ({ type: 'completed', sessionId: 's1', workspace: 'D:/w', summary: 'Built it.', summarySource: 'auto', payload: { reply: 'Built it. Two ways to ship.' }, ...over })
function setup(judgment, mode = 'auto') {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const entries = []
  const rules = DEFAULT_RULES.map((r) => ({ ...r, mode }))
  const runner = createTriageRunner({ store, judge: { judge: async () => ({ judgment, raw: '' }) }, triageLog: { append: (e) => entries.push(e) }, rules, sessionContinuesOf: () => true })
  runner.start()
  return { store, runner, entries }
}

test('runner: needs_decision on a done card adds decision, keeps type, stays open, logs the conversion', async () => {
  const { store, runner, entries } = setup({ ...BASE, decision: { text: 'Ship A or B?', options: ['A', 'B'] } })
  const item = store.add(done())
  const before = JSON.stringify(item.payload)
  await runner.idle()
  const s = store.get(item.id)
  assert.equal(s.type, 'completed')
  assert.equal(s.status, 'open')
  assert.deepEqual(s.decision, { text: 'Ship A or B?', options: ['A', 'B'], free: true })
  assert.equal(JSON.stringify(s.payload), before)
  assert.ok(entries.some((e) => e.stage === 'decision' && e.itemId === item.id))
  assert.equal(entries.some((e) => e.stage === 'act'), false, 'never AI-handled')
})

test('runner: no decision when the judge gave none, nor when needs_decision is false', async () => {
  const a = setup({ ...BASE })
  const i1 = a.store.add(done())
  await a.runner.idle()
  assert.equal(a.store.get(i1.id).decision, undefined)
  const b = setup({ ...BASE, needs_decision: false, decision: { text: 'Q', options: [] } })
  const i2 = b.store.add(done())
  await b.runner.idle()
  assert.equal(b.store.get(i2.id).decision, undefined, 'needs_decision false')
})

test('runner: a question card with needs_decision gets no decision; an existing decision is not overwritten', async () => {
  const a = setup({ ...BASE, matched_rule: 'straightforward-question', decision: { text: 'Q', options: ['A', 'B'] } })
  const q = a.store.add({ type: 'question', sessionId: 's1', workspace: 'D:/w', payload: { questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } })
  await a.runner.idle()
  assert.equal(a.store.get(q.id).decision, undefined)
  const b = setup({ ...BASE, decision: { text: 'New?', options: ['X', 'Y'] } })
  const d = b.store.add(done({ decision: { text: 'Old?', options: [], free: true } }))
  await b.runner.idle()
  assert.equal(b.store.get(d.id).decision.text, 'Old?')
})

test('parseJudgment: control and bidi characters are stripped from decision text and options', () => {
  const j = parse({ decision_text: 'Which\u0000\u202E way?', decision_options: ['A\u0007', 'B\u2066'] }).judgment
  assert.deepEqual(j.decision, { text: 'Which way?', options: ['A', 'B'] })
})

test('done actor: a card that carries a decision is never cleared', async () => {
  const { createDoneActor } = await import('../triage-act-done.js')
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const item = store.add(done({ decision: { text: 'Q?', options: [], free: true } }))
  const r = await createDoneActor({ store })({ item: store.get(item.id), resolutionBase: {} })
  assert.equal(r.ok, false)
  assert.equal(store.get(item.id).status, 'open')
})

test('auto-clear sweep: a done card carrying a decision is never cleared as no-action', async () => {
  const { createAutoClear } = await import('../auto-clear.js')
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const item = store.add(done({ summary: 'Built it.', decision: { text: 'Q?', options: [], free: true } }))
  const out = createAutoClear({ store, now: () => 1000 + 60_000 }).sweep()
  assert.equal(out.done, 0)
  assert.equal(store.get(item.id).status, 'open')
})

test('parseJudgment: a newline or tab becomes a space (words stay apart); zero-width characters are removed', () => {
  const j = parse({ decision_text: 'Ship A\nor\tB?', decision_options: ['A\u200bA', 'B\u2060\ufeff'] }).judgment
  assert.deepEqual(j.decision, { text: 'Ship A or B?', options: ['AA', 'B'] })
})

test('parseJudgment: tag characters, soft hyphen and Hangul fillers are stripped from decision text and options', () => {
  const tags = String.fromCodePoint(0xe0041, 0xe0042, 0xe0043, 0xe007f)
  const j = parse({ decision_text: `Ship${tags} A­?ᅟᅠㅤﾠ`, decision_options: [`A${tags}­`, 'Bㅤﾠ'] }).judgment
  assert.deepEqual(j.decision, { text: 'Ship A?', options: ['A', 'B'] })
})

test('parseJudgment: a secret in the decision text or options is redacted', () => {
  const j = parse({ decision_text: 'Use token=abc123secretvalue to deploy?', decision_options: ['Use Bearer abcdefghijklmnop1234', 'No'] }).judgment
  assert.equal(j.decision.text.includes('abc123secretvalue'), false)
  assert.ok(j.decision.text.includes('[redacted]'))
  assert.equal(j.decision.options[0].includes('abcdefghijklmnop1234'), false)
  assert.ok(j.decision.options[0].includes('[redacted]'))
})

test('runner: a store failure on the decision write is logged as update-failed and triage continues', async () => {
  const { store, runner, entries } = setup({ ...BASE, decision: { text: 'Q?', options: ['A', 'B'] } })
  const realUpdate = store.update.bind(store)
  store.update = (id, patch) => { if (patch && patch.decision) throw new Error('boom'); return realUpdate(id, patch) }
  const item = store.add(done())
  await runner.idle()
  assert.ok(entries.some((e) => e.stage === 'decision' && e.reasons.includes('update-failed')))
  assert.equal(store.get(item.id).status, 'open')
  assert.ok(entries.some((e) => e.stage === 'judge'), 'the verdict was still recorded')
})

test('parseJudgment: default-ignorable, Cf, bidi marks, variation selectors and blank fillers are stripped', () => {
  const junk = '\u061c\u034f\u180e\u17b4\u17b5\u2800\ufe0f\u{e0100}\u200e\u2066\u00ad'
  const j = parse({ decision_text: `Ship${junk} A?`, decision_options: [`A${junk}`, `B\u2800\ufe00`] }).judgment
  assert.deepEqual(j.decision, { text: 'Ship A?', options: ['A', 'B'] })
})

test('parseJudgment: unicode spaces become one space', () => {
  const j = parse({ decision_text: 'Ship\u1680A\u2003\u3000or\u2009B?', decision_options: ['X\u2000Y', 'Z'] }).judgment
  assert.deepEqual(j.decision, { text: 'Ship A or B?', options: ['X Y', 'Z'] })
})

test('parseJudgment: options that differ only by NFKC form or case are deduped', () => {
  const j = parse({ decision_text: 'Q', decision_options: ['Yes', 'YES', '\uff39es', 'No'] }).judgment
  assert.deepEqual(j.decision.options, ['Yes', 'No'])
})

test('parseJudgment: a trailing (Recommended) suffix is stripped before dedupe; too few distinct options degrade to free text', () => {
  assert.deepEqual(parse({ decision_text: 'Q', decision_options: ['Ship now (Recommended)', 'Wait', 'ship NOW (recommended)'] }).judgment.decision.options, ['Ship now', 'Wait'])
  assert.deepEqual(parse({ decision_text: 'Q', decision_options: ['A (Recommended)', 'a'] }).judgment.decision.options, [])
})
test('parseJudgment: decision text and options are stored NFKC-normalised (full-width, ligatures)', () => {
  const j = parse({ decision_text: '\uff33hip \ufb01x?', decision_options: ['\uff39\uff45\uff53', '\ufb01x it'] }).judgment
  assert.deepEqual(j.decision, { text: 'Ship fix?', options: ['Yes', 'fix it'] })
})
