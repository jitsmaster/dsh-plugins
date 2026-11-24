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

// The kept text has the trailing flag stripped: "Add answers" appends a Decisions list after it, which would leave the flag mid-text where it no longer counts as a flag.
test('the typed prompt comes back without its profile flag when only questions came back', async () => {
  const { createTuner } = await import('../todo-tune.js')
  const r = await createTuner({ rulesText: RULES, llm: fakeLlm({ answer: 'Which db?' }) }).tune('add storage --thorough')
  assert.deepEqual(r, { ok: true, text: 'add storage', questions: [{ question: 'Which db?' }] })
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


// ---- shapes of model answers that used to leave the questions in the prompt box ----
const tuneTyped = async (typed, answer) => {
  const { createTuner } = await import('../todo-tune.js')
  return createTuner({ rulesText: RULES, llm: fakeLlm({ answer }) }).tune(typed)
}

test('an inline "QUESTIONS: <q>? Suggested default: <x>. <q>?" line is split into questions and leaves the prompt', async () => {
  const r = await tune('Fix login in the web app.\n\nQUESTIONS: Which file? Suggested default: login.js. Which error?')
  assert.deepEqual(r, { ok: true, text: 'Fix login in the web app.', questions: [{ question: 'Which file?', default: 'login.js' }, { question: 'Which error?' }] })
})

test('a "Clarifying questions:" or "Open questions" heading counts like QUESTIONS', async () => {
  const a = await tune('Fix login in web app.\n\nClarifying questions:\n- Which file?\n- Which error?')
  assert.deepEqual(a, { ok: true, text: 'Fix login in web app.', questions: [{ question: 'Which file?' }, { question: 'Which error?' }] })
  const b = await tune('Fix login in the web app.\n\nOpen questions\nWhich file?\nWhich error?')
  assert.deepEqual(b, { ok: true, text: 'Fix login in the web app.', questions: [{ question: 'Which file?' }, { question: 'Which error?' }] })
})

test('numbered question lines without a default inside the prompt are moved out', async () => {
  const r = await tune('Fix login in the web app.\n1. Which file is it in?\n2. What error appears?')
  assert.deepEqual(r, { ok: true, text: 'Fix login in the web app.', questions: [{ question: 'Which file is it in?' }, { question: 'What error appears?' }] })
})

test('a lead-in line ("I need to know:") with only questions under it keeps the typed prompt and asks them apart', async () => {
  const r = await tune('Before I rewrite this I need to know:\n- Which file?\n- Which error?')
  assert.deepEqual(r, { ok: true, text: 'rough text', questions: [{ question: 'Which file?' }, { question: 'Which error?' }] })
})

test('questions in front of the prompt are moved out and the prompt stays', async () => {
  const r = await tune('Which file should the fix go in? And what error do you see?\n\nFix login in the web app.')
  assert.deepEqual(r, { ok: true, text: 'Fix login in the web app.', questions: [{ question: 'Which file should the fix go in?' }, { question: 'And what error do you see?' }] })
})

test('a typed prompt that has a question mark is never split into questions by the loose shapes', async () => {
  const r = await tuneTyped('Why does login fail?', 'Find why login fails.\n1. Which file is it in?\n2. What error appears?')
  assert.deepEqual(r, { ok: true, text: 'Find why login fails.\n1. Which file is it in?\n2. What error appears?' })
})

test('a numbered task list that is not questions, and a sentence that only ends in a question, stay in the prompt', async () => {
  const a = await tune('Fix login.\n1. Open the form.\n2. Check the error.')
  assert.deepEqual(a, { ok: true, text: 'Fix login.\n1. Open the form.\n2. Check the error.' })
  const b = await tune('Fix login in web app. Is it the form? Make it work.')
  assert.deepEqual(b, { ok: true, text: 'Fix login in web app. Is it the form? Make it work.' })
})


// ---- structured reply: the model answers with { prompt, questions } so no text shape has to be guessed ----
const json = (o) => JSON.stringify(o)

test('a JSON reply is read by its fields: prompt goes to the box, questions (with defaults) are asked apart', async () => {
  const r = await tune(json({ prompt: 'Fix login in the web app.', questions: [{ question: 'Which file?', default: 'login.js' }, { question: 'Which error?' }] }))
  assert.deepEqual(r, { ok: true, text: 'Fix login in the web app.', questions: [{ question: 'Which file?', default: 'login.js' }, { question: 'Which error?' }] })
})

test('a JSON reply inside a code fence, or with plain strings as questions, is read the same way', async () => {
  const r = await tune('```json\n' + json({ prompt: 'Fix login.', questions: ['Which file?', 'Which error?'] }) + '\n```')
  assert.deepEqual(r, { ok: true, text: 'Fix login.', questions: [{ question: 'Which file?' }, { question: 'Which error?' }] })
})

test('a JSON reply with no questions has no questions key', async () => {
  assert.deepEqual(await tune(json({ prompt: 'Fix login.', questions: [] })), { ok: true, text: 'Fix login.' })
  assert.deepEqual(await tune(json({ prompt: 'Fix login.' })), { ok: true, text: 'Fix login.' })
})

test('a JSON reply with an empty prompt and questions keeps the typed text and asks apart', async () => {
  const r = await tune(json({ prompt: '', questions: [{ question: 'Which file?' }] }))
  assert.deepEqual(r, { ok: true, text: 'rough text', questions: [{ question: 'Which file?' }] })
})

test('a JSON prompt that is itself a question stays in the box (nothing is guessed from its shape)', async () => {
  const r = await tuneTyped('why does login fail', json({ prompt: 'Find why login fails. Is it the form? Report the cause.', questions: [] }))
  assert.deepEqual(r, { ok: true, text: 'Find why login fails. Is it the form? Report the cause.' })
})

test('a JSON prompt that still carries a Decide list is split, the questions merged after the JSON ones, at most 5', async () => {
  const r = await tune(json({ prompt: 'Add X.\n\nDecide:\n1. Which db? Suggested default: SQLite.', questions: [{ question: 'Retry?', default: 'yes' }] }))
  assert.deepEqual(r, { ok: true, text: 'Add X.', questions: [{ question: 'Retry?', default: 'yes' }, { question: 'Which db?', default: 'SQLite' }] })
  const many = await tune(json({ prompt: 'Do X.', questions: Array.from({ length: 8 }, (_v, i) => 'Q' + i + '?') }))
  assert.equal(many.questions.length, 5)
})

test('JSON entries that are not questions are skipped; question and default are cut at 300 characters', async () => {
  const r = await tune(json({ prompt: 'Do X.', questions: [42, null, { question: '   ' }, { default: 'x' }, { question: 'q'.repeat(500), default: 'd'.repeat(500) }] }))
  assert.equal(r.questions.length, 1)
  assert.ok(r.questions[0].question.length <= 300 && r.questions[0].default.length <= 300)
})

test('text that is not a JSON reply (no string prompt, broken JSON, prose first) still goes through the shape rules', async () => {
  assert.deepEqual(await tune('{"note": "x"}'), { ok: true, text: '{"note": "x"}' })
  assert.deepEqual(await tune('{"prompt": "Fix login.", "questions": ['), { ok: true, text: '{"prompt": "Fix login.", "questions": [' })
  const plain = await tune('Fix login.\n\nQUESTIONS:\n- Which file?')
  assert.deepEqual(plain, { ok: true, text: 'Fix login.', questions: [{ question: 'Which file?' }] })
})

test('the system prompt asks for one JSON object with prompt and questions fields', async () => {
  const seen = {}
  await tune('x', { seen })
  const after = systemOf(seen).slice(systemOf(seen).indexOf(RULES) + RULES.length)
  assert.match(after, /JSON object/)
  assert.match(after, /"prompt"/)
  assert.match(after, /"questions"/)
})
