import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, findAll, textOf, okJson, tick, savedDraft, KEY, FORM } from './client-todo-helpers.mjs'

// The effort dropdown of the + New todo form: the efforts of the default model (GET /v1/model-efforts), "Default" first, sent as effort only when
// another one is picked, kept in the saved draft, off for a follow-up and for a model without efforts, and back to Default after an add.
const EFFORTS = { ok: true, model: { provider: 'p', id: 'm', name: 'Model' }, efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium', description: 'balanced' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' }

function render({ answer = () => okJson(EFFORTS), stored } = {}) {
  const calls = []
  const c = loadClient({
    stored,
    react: { createElement: el, useEffect() {}, useState: () => [0, () => {}] },
    fetchImpl: async (url, opts) => { calls.push([url.replace(/^.*\/review-queue/, ''), opts?.body ? JSON.parse(opts.body) : undefined, opts?.method ?? 'GET']); return answer(url) },
  })
  return { ...c, calls }
}
const selectOf = (tree) => findAll(tree, (n) => n.type === 'select' && n.props['aria-label'] === 'Effort')[0]
const optionsOf = (sel) => findAll(sel, (n) => n.type === 'option').map((o) => ({ value: o.props.value, label: textOf(o) }))

test('loadEfforts reads GET /v1/model-efforts into the state; a failure keeps the form without a dropdown', async () => {
  const { T, calls } = render()
  await T.loadEfforts()
  assert.deepEqual(calls[0].slice(0, 1), ['/v1/model-efforts'])
  assert.equal(T.state.efforts.defaultEffort, 'medium')
  assert.equal(T.state.efforts.efforts.length, 3)
  const bad = render({ answer: () => okJson({}, 500) })
  await bad.T.loadEfforts()
  assert.equal(bad.T.state.efforts, null)
})

test('the form shows the Effort dropdown: Default (the current default effort) first, then every effort of the model', async () => {
  const { T } = render()
  await T.loadEfforts()
  T.set({ todoForm: FORM() })
  const sel = selectOf(T.TodoForm())
  assert.ok(sel, 'an Effort select')
  assert.deepEqual(optionsOf(sel), [{ value: '', label: 'Default (Medium)' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }])
  assert.equal(sel.props.value, '')
})

test('no dropdown for a follow-up, for a model without efforts, or before the list is known', async () => {
  const { T } = render()
  T.set({ todoForm: FORM() })
  assert.equal(selectOf(T.TodoForm()), undefined, 'not loaded yet')
  await T.loadEfforts()
  T.set({ todoForm: FORM({ mode: 'followup' }) })
  assert.equal(selectOf(T.TodoForm()), undefined, 'a follow-up has no effort')
  const none = render({ answer: () => okJson({ ok: true, efforts: [] }) })
  await none.T.loadEfforts()
  none.T.set({ todoForm: FORM() })
  assert.equal(selectOf(none.T.TodoForm()), undefined)
})

test('picking an effort patches the form and is saved in the draft; Default is not saved', async () => {
  const { T, store } = render()
  await T.loadEfforts()
  T.set({ todoForm: FORM({ text: 'x' }) })
  selectOf(T.TodoForm()).props.onChange({ target: { value: 'high' } })
  assert.equal(T.state.todoForm.effort, 'high')
  assert.equal(savedDraft(store).effort, 'high')
  selectOf(T.TodoForm()).props.onChange({ target: { value: '' } })
  assert.equal('effort' in savedDraft(store), false)
})

test('a restored draft brings the effort back; one the model no longer has is dropped once the list is known', async () => {
  const { T } = render({ stored: { [KEY]: JSON.stringify({ text: 'x', open: true, effort: 'turbo' }) } })
  assert.equal(T.state.todoForm.effort, 'turbo')
  await T.loadEfforts()
  assert.equal(T.state.todoForm.effort, '')
  const ok = render({ stored: { [KEY]: JSON.stringify({ text: 'x', open: true, effort: 'high' }) } })
  await ok.T.loadEfforts()
  assert.equal(ok.T.state.todoForm.effort, 'high')
})

test('submitTodo sends the effort only when another than Default is picked, and the form goes back to Default', async () => {
  const { T, calls } = render()
  T.set({ todoForm: FORM({ text: 'Fix it', workspaceId: 'w1', effort: 'high' }) })
  assert.equal(await T.submitTodo(), true)
  assert.deepEqual(calls.at(-1), ['/v1/todo', { text: 'Fix it', workspaceId: 'w1', sparc: false, effort: 'high' }, 'POST'])
  assert.equal(T.state.todoForm.effort ?? '', '')
  T.set({ todoForm: FORM({ text: 'Again', workspaceId: 'w1' }) })
  await T.submitTodo()
  assert.equal('effort' in calls.at(-1)[1], false)
})

test('a follow-up never sends an effort, even when one was left in the draft', async () => {
  const { T, calls } = render()
  T.set({ todoForm: FORM({ text: 'Hello', mode: 'followup', followUp: 's1', effort: 'high' }) })
  await T.submitTodo()
  assert.equal('effort' in calls.at(-1)[1], false)
})

test('the todo card says which effort it asked for; the error of a bad effort has words', async () => {
  const { T } = render()
  await T.loadEfforts()
  T.set({ snap: null })
  const card = T.TodoBody({ item: { id: 't1', type: 'todo', text: 'x', state: 'awaiting-confirm', effort: 'high' }, full: true })
  assert.match(textOf(card), /Effort: High/)
  assert.match(T.errorText(400, { error: 'bad-effort' }), /effort/i)
})
