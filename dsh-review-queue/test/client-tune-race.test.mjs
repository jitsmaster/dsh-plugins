import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FORM, loadClient, savedDraft, formOf, okJson, deferred, tick } from './client-todo-helpers.mjs'

// A tune that is still running when the form is closed (Cancel, Escape) or reopened must not write its late text into the saved draft.
const route = (tuneImpl) => async (url, opts) => (url.endsWith('/v1/workspaces') ? okJson({ workspaces: [] }) : tuneImpl(url, opts))

test('closing the form while it tunes: the late tuned text is ignored, the saved draft keeps what the user typed', async () => {
  const gate = deferred()
  const { T, store } = loadClient({ fetchImpl: route(async () => { await gate.promise; return okJson({ ok: true, text: 'Tuned late' }) }) })
  T.set({ todoForm: FORM({ text: 'typed text', workspaceId: 'w1' }) })
  const run = T.tuneTodo()
  await tick()
  assert.equal(T.state.todoForm.tuning, true)
  T.closeTodoForm()
  gate.resolve()
  assert.equal(await run, false, 'the ignored result is not a success')
  const f = formOf(T)
  assert.deepEqual([f.open, f.text, f.original, !!f.tuning, f.workspaceId], [false, 'typed text', undefined, false, 'w1'])
  assert.deepEqual([savedDraft(store).text, savedDraft(store).original, savedDraft(store).open], ['typed text', undefined, false])
})

test('closing and reopening while it tunes: the old result is ignored and the form is usable again', async () => {
  const gate = deferred()
  const { T, store } = loadClient({ fetchImpl: route(async () => { await gate.promise; return okJson({ ok: true, text: 'Tuned late' }) }) })
  T.set({ todoForm: FORM({ text: 'typed text' }) })
  const run = T.tuneTodo()
  await tick()
  T.closeTodoForm()
  T.openTodoForm()
  await tick()
  gate.resolve()
  await run
  const f = formOf(T)
  assert.deepEqual([f.open, f.text, f.original, !!f.tuning], [true, 'typed text', undefined, false])
  assert.equal(savedDraft(store).text, 'typed text')
})

test('an old result does not clear the "tuning" of a newer tune, and the newer one still lands', async () => {
  const gates = [deferred(), deferred()]
  let n = 0
  const { T } = loadClient({ fetchImpl: route(async () => { const g = gates[n++]; await g.promise; return okJson({ ok: true, text: 'Tuned ' + n }) }) })
  T.set({ todoForm: FORM({ text: 'typed text' }) })
  const old = T.tuneTodo()
  await tick()
  T.closeTodoForm()
  T.openTodoForm()
  await tick()
  const fresh = T.tuneTodo()
  await tick()
  gates[0].resolve()
  await old
  assert.equal(T.state.todoForm.tuning, true, 'the newer tune is still running')
  assert.equal(T.state.todoForm.text, 'typed text')
  gates[1].resolve()
  assert.equal(await fresh, true)
  assert.deepEqual([T.state.todoForm.text, T.state.todoForm.original, !!T.state.todoForm.tuning], ['Tuned 2', 'typed text', false])
})

test('Undo still works after a tune that landed normally', async () => {
  const { T } = loadClient({ fetchImpl: route(async () => okJson({ ok: true, text: 'Tuned' })) })
  T.set({ todoForm: FORM({ text: 'typed text' }) })
  await T.tuneTodo()
  assert.deepEqual([T.state.todoForm.text, T.state.todoForm.original], ['Tuned', 'typed text'])
  T.undoTune()
  assert.equal(T.state.todoForm.text, 'typed text')
})

test('a busy answer reads "A tune is already running"', async () => {
  const { T } = loadClient({ fetchImpl: route(async () => okJson({ ok: false, error: 'busy' }, 409)) })
  T.set({ todoForm: FORM({ text: 'typed text' }) })
  assert.equal(await T.tuneTodo(), false)
  assert.match(T.state.todoForm.error, /^A tune is already running/)
  assert.equal(T.state.todoForm.text, 'typed text')
})
