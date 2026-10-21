import { test } from 'node:test'
import assert from 'node:assert/strict'
import { source, loadClient, savedDraft, formOf, need, okJson, FORM } from './client-todo-helpers.mjs'

// Tune prompt questions: the answer of /v1/todo-tune may carry questions [{ question, default? }]. They are NOT put in the box: the form keeps
// them as todoForm.questions [{ question, default?, answer }] (the answer starts as the default), shows them as a panel, and "Add answers"
// appends the non-blank answers to the prompt as a Decisions list; "Skip" drops them. They are never saved in the draft.
const QS = [{ question: 'Which db?', default: 'SQLite' }, { question: 'Retry?', default: 'yes' }, { question: 'Which port?' }]

test('nextFormAfterTune keeps the questions apart from the text, each answer starting as its default', () => {
  const { T } = loadClient()
  need(T, 'nextFormAfterTune')
  const next = T.nextFormAfterTune(FORM({ text: 'rough', tuning: true }), { ok: true, text: 'Add X.', questions: QS })
  assert.equal(next.text, 'Add X.')
  assert.equal(next.original, 'rough')
  assert.deepEqual(JSON.parse(JSON.stringify(next.questions)), [
    { question: 'Which db?', default: 'SQLite', answer: 'SQLite' }, { question: 'Retry?', default: 'yes', answer: 'yes' }, { question: 'Which port?', answer: '' }])
})

test('no questions in the answer: the form has none, and an older list is dropped', () => {
  const { T } = loadClient()
  const next = T.nextFormAfterTune(FORM({ text: 'x', questions: [{ question: 'Old?', answer: '' }] }), { ok: true, text: 'Add X.' })
  assert.equal(next.questions, undefined)
  const failed = T.nextFormAfterTune(FORM({ text: 'x', questions: [{ question: 'Old?', answer: '' }] }), { ok: false, error: 'LLM error' })
  assert.equal(failed.questions.length, 1, 'a failed tune leaves the open questions alone')
})

test('tuneTodo reads questions from the server answer and does not touch the box with them', async () => {
  const { T } = loadClient({ fetchImpl: async () => okJson({ ok: true, text: 'Add X.', questions: QS }) })
  need(T, 'tuneTodo')
  T.set({ todoForm: FORM({ text: 'rough' }) })
  assert.equal(await T.tuneTodo(), true)
  const f = formOf(T)
  assert.equal(f.text, 'Add X.')
  assert.equal(f.questions.length, 3)
})

test('questions that are not objects with a text are ignored, at most 5 are kept', async () => {
  const bad = [null, 7, { question: '' }, { nope: 1 }, ...Array.from({ length: 8 }, (_v, i) => ({ question: 'Q' + i + '?' }))]
  const { T } = loadClient({ fetchImpl: async () => okJson({ ok: true, text: 'T', questions: bad }) })
  T.set({ todoForm: FORM({ text: 'rough' }) })
  await T.tuneTodo()
  assert.deepEqual(formOf(T).questions.map((q) => q.question), ['Q0?', 'Q1?', 'Q2?', 'Q3?', 'Q4?'])
})

test('setTuneAnswer edits one answer; applyTuneAnswers appends the non-blank answers as Decisions and closes the panel', () => {
  const { T, store } = loadClient()
  need(T, 'setTuneAnswer'); need(T, 'applyTuneAnswers')
  T.set({ todoForm: FORM({ text: 'Add X.', original: 'rough', questions: [{ question: 'Which db?', default: 'SQLite', answer: 'SQLite' }, { question: 'Retry?', default: 'yes', answer: 'yes' }, { question: 'Which port?', answer: '' }] }) })
  T.setTuneAnswer(1, 'no')
  T.setTuneAnswer(2, '  8080 ')
  T.setTuneAnswer(0, '   ')
  T.applyTuneAnswers()
  const f = formOf(T)
  assert.equal(f.text, 'Add X.\n\nDecisions:\n- Retry? no\n- Which port? 8080')
  assert.equal(f.original, 'rough')
  assert.equal(f.questions, undefined)
  assert.equal(savedDraft(store).text, f.text)
})

test('applyTuneAnswers with every answer blank leaves the text as it is; Skip drops the questions', () => {
  const { T } = loadClient()
  need(T, 'skipTuneQuestions')
  T.set({ todoForm: FORM({ text: 'Add X.', questions: [{ question: 'A?', answer: '' }] }) })
  T.applyTuneAnswers()
  assert.deepEqual([T.state.todoForm.text, T.state.todoForm.questions], ['Add X.', undefined])
  T.set({ todoForm: FORM({ text: 'Add X.', questions: [{ question: 'A?', answer: 'yes' }] }) })
  T.skipTuneQuestions()
  assert.deepEqual([T.state.todoForm.text, T.state.todoForm.questions], ['Add X.', undefined])
})

test('questions are not saved in the draft, and closing or undoing drops them', () => {
  const { T, store } = loadClient()
  T.set({ todoForm: FORM({ text: 'tuned', original: 'typed', questions: [{ question: 'A?', answer: 'x' }] }) })
  T.closeTodoForm()
  assert.equal(T.state.todoForm.questions, undefined)
  assert.ok(!JSON.stringify(savedDraft(store)).includes('questions'))
  T.set({ todoForm: FORM({ text: 'tuned', original: 'typed', questions: [{ question: 'A?', answer: 'x' }] }) })
  T.undoTune()
  assert.equal(T.state.todoForm.questions, undefined)
})

test('source: TodoForm shows the questions panel with an input per question, Add answers and Skip', () => {
  const form = source.slice(source.indexOf('function TodoForm'), source.indexOf('function Head('))
  assert.match(form, /rq-tunequestions/)
  assert.match(form, /setTuneAnswer/)
  assert.match(form, /applyTuneAnswers/)
  assert.match(form, /skipTuneQuestions/)
})
