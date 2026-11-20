import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeLlm, systemOf } from './todo-tune-helpers.mjs'

// Tune prompt: the questions the prompt-tune rules call for (open choices with a suggested default) are not put in the prompt box.
// tune() returns them apart: { ok: true, text, questions: [{ question, default? }] }, and the client asks them (an ask-user-question style panel).
// No questions: the result has no questions key at all. The questions come from a "QUESTIONS:" block after the prompt, or, when the model ignored
// that instruction, from a Decide list of "<question>? Suggested default: <X>." items that follow a prompt that has text of its own.
const RULES = 'RULES-MARKER-7: tighten the wording'
const tune = async (answer, opts = {}) => {
  const { createTuner } = await import('../todo-tune.js')
  return createTuner({ rulesText: RULES, llm: fakeLlm({ answer, ...opts }) }).tune('rough text')
}

test('a QUESTIONS block after the prompt becomes questions with their defaults; the reason after a default is dropped', async () => {
  const r = await tune('Add X in Y.\n\nQUESTIONS:\n1. Which db? Suggested default: SQLite, because it needs no server.\n2. Retry on failure? Suggested default: yes.')
  assert.deepEqual(r, { ok: true, text: 'Add X in Y.', questions: [{ question: 'Which db?', default: 'SQLite' }, { question: 'Retry on failure?', default: 'yes' }] })
})

test('a question without a default has no default key; bullets and numbering are not part of the question', async () => {
  const r = await tune('Add X in Y.\nQUESTIONS\n- Which db?\n* Retry? Suggested default: yes.\n3) Which port?')
  assert.deepEqual(r, { ok: true, text: 'Add X in Y.', questions: [{ question: 'Which db?' }, { question: 'Retry?', default: 'yes' }, { question: 'Which port?' }] })
})

test('a Decide list that the model left inside the prompt is moved out, with its heading', async () => {
  const r = await tune('Add X.\n\nDecide (state your choice in the response):\n1. Which db? Suggested default: SQLite.\n2. Retry? Suggested default: yes.')
  assert.deepEqual(r, { ok: true, text: 'Add X.', questions: [{ question: 'Which db?', default: 'SQLite' }, { question: 'Retry?', default: 'yes' }] })
})

test('a trailing rationale after the questions is dropped too', async () => {
  const r = await tune('Add X in Y.\n\nQUESTIONS:\n1. Which db? Suggested default: SQLite.\n\nRationale: foo')
  assert.deepEqual(r, { ok: true, text: 'Add X in Y.', questions: [{ question: 'Which db?', default: 'SQLite' }] })
})

test('at most 5 questions, each cut at 300 characters', async () => {
  const many = Array.from({ length: 8 }, (_v, i) => i + 1 + '. Question ' + (i + 1) + '? Suggested default: A.').join('\n')
  const r = await tune('Do X.\n\nQUESTIONS:\n' + many)
  assert.equal(r.questions.length, 5)
  const long = await tune('Do X.\n\nQUESTIONS:\n1. ' + 'w'.repeat(500) + '?')
  assert.ok(long.questions[0].question.length <= 300)
})

test('no questions: the result has no questions key; a QUESTIONS block with nothing in it adds none', async () => {
  assert.deepEqual(await tune('Do X in Y.'), { ok: true, text: 'Do X in Y.' })
  assert.deepEqual(await tune('Do X in Y.\n\nQUESTIONS:\n'), { ok: true, text: 'Do X in Y.' })
})

// Never lose the typed prompt: when the model answers with questions only (the rules' "ask 1-2 questions if ambiguous" step), the box keeps what the user typed
// and the questions are asked apart. The questions never land in the prompt box.
test('an answer that is only Decide items leaves the typed prompt as it is and asks the questions apart', async () => {
  const r = await tune('1. Which db? Suggested default: SQLite.')
  assert.deepEqual(r, { ok: true, text: 'rough text', questions: [{ question: 'Which db?', default: 'SQLite' }] })
})

test('a QUESTIONS block with no prompt before it leaves the typed prompt as it is', async () => {
  const r = await tune('QUESTIONS:\n1. Which db? Suggested default: SQLite.\n2. Which port?')
  assert.deepEqual(r, { ok: true, text: 'rough text', questions: [{ question: 'Which db?', default: 'SQLite' }, { question: 'Which port?' }] })
})

test('an answer of plain clarifying questions (no marker, no default) is asked apart when the typed prompt had no question mark', async () => {
  const r = await tune('Which file do you mean?\nShould it also cover the phone app?')
  assert.deepEqual(r, { ok: true, text: 'rough text', questions: [{ question: 'Which file do you mean?' }, { question: 'Should it also cover the phone app?' }] })
})

test('the typed prompt keeps its profile flag when only questions came back', async () => {
  const { createTuner } = await import('../todo-tune.js')
  const r = await createTuner({ rulesText: RULES, llm: fakeLlm({ answer: 'Which db?' }) }).tune('add storage --thorough')
  assert.deepEqual(r, { ok: true, text: 'add storage --thorough', questions: [{ question: 'Which db?' }] })
})

test('a typed prompt that is itself a question may be rewritten as a question (not treated as clarifying questions)', async () => {
  const { createTuner } = await import('../todo-tune.js')
  const r = await createTuner({ rulesText: RULES, llm: fakeLlm({ answer: 'Why does the build fail in CI?' }) }).tune('why does build fail?')
  assert.deepEqual(r, { ok: true, text: 'Why does the build fail in CI?' })
})

test('the system prompt tells the model to put questions after a QUESTIONS: line and never inside the prompt', async () => {
  const seen = {}
  await tune('x', { seen })
  const system = systemOf(seen)
  const after = system.slice(system.indexOf(RULES) + RULES.length)
  assert.match(after, /QUESTIONS:/)
  assert.match(after, /never (put|write|place) (any )?questions? (in|inside) the (rewritten )?prompt/i)
  assert.match(after, /<question>\? Suggested default: <X>\./)
})
