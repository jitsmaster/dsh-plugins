import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KEY, FORM, loadClient, savedDraft, isCleared, formOf, okJson } from './client-todo-helpers.mjs'

// The "+ New todo" draft with the Follow up fields: mode ('followup', saved only then) and followUp (the description, saved when there is one).
// A draft of before (no mode, no followUp) must still restore as a New session todo, and a New session draft must still be written
// with exactly the keys it had (client-todo-draft.test.mjs).

test('a Follow up draft is written at once with its mode and its description', () => {
  const { T, store } = loadClient()
  T.set({ todoForm: FORM({ text: 'Reply to it', mode: 'followup', followUp: 'the PR 6563 session' }) })
  assert.deepEqual(savedDraft(store), { text: 'Reply to it', workspaceId: '', sparc: false, open: true, mode: 'followup', followUp: 'the PR 6563 session' })
})

test('every keystroke of the description is saved at once, the last one wins; so is a switch of the mode', () => {
  const { T, store } = loadClient()
  for (const followUp of ['t', 'th', 'the PR']) { T.patchForm({ followUp }); assert.equal(savedDraft(store).followUp, followUp) }
  T.patchForm({ mode: 'followup' })
  assert.equal(savedDraft(store).mode, 'followup')
  T.patchForm({ mode: 'new' })
  assert.equal('mode' in savedDraft(store), false, 'New session is the default: nothing is written for it, as in the drafts of before')
})

test('a New session draft with no description is written exactly as before (same keys)', () => {
  const { T, store } = loadClient()
  T.set({ todoForm: FORM({ text: 'x', mode: 'new', followUp: '' }) })
  assert.deepEqual(Object.keys(savedDraft(store)).sort(), ['open', 'sparc', 'text', 'workspaceId'])
})

test('a description typed in Follow up mode survives a switch to New session (it is saved, the mode is not Follow up)', () => {
  const { T, store } = loadClient()
  T.set({ todoForm: FORM({ text: 'x', mode: 'new', followUp: 'words I typed' }) })
  assert.deepEqual(savedDraft(store), { text: 'x', workspaceId: '', sparc: false, open: true, followUp: 'words I typed' })
})

test('the description is saved whole: the saver does not cut it at the 300 of the input', () => {
  const { T, store } = loadClient()
  const long = 'w'.repeat(500)
  T.set({ todoForm: FORM({ text: 'x', mode: 'followup', followUp: long }) })
  assert.equal(savedDraft(store).followUp, long)
})

test('the draft is restored with the mode, the description, the text and the open state; busy and error are not', () => {
  const draft = { text: 'Reply to it', workspaceId: '', sparc: false, open: true, mode: 'followup', followUp: 'the PR 6563 session' }
  const { T } = loadClient({ stored: { [KEY]: JSON.stringify(draft) } })
  const f = formOf(T)
  assert.equal(f.mode, 'followup')
  assert.equal(f.followUp, 'the PR 6563 session')
  assert.equal(f.text, 'Reply to it')
  assert.equal(f.open, true)
  assert.equal(f.busy, false)
  assert.equal(f.error, undefined)
})

test('a draft of before (no mode, no description) restores as New session with an empty description and everything else as it was', () => {
  const old = { text: 'Old draft', workspaceId: 'w2', sparc: true, open: true, original: 'typed' }
  const { T } = loadClient({ stored: { [KEY]: JSON.stringify(old) } })
  const f = formOf(T)
  assert.equal(f.mode, 'new')
  assert.equal(f.followUp, '')
  assert.deepEqual([f.text, f.workspaceId, f.sparc, f.open, f.original], ['Old draft', 'w2', true, true, 'typed'])
})

test('nothing saved, or garbage, gives a New session form with an empty description', () => {
  for (const raw of [undefined, '', '{not json', 'null', '[1]', '5']) {
    const { T } = loadClient({ stored: raw === undefined ? {} : { [KEY]: raw } })
    const f = formOf(T)
    assert.equal(f.mode, 'new', String(raw))
    assert.equal(f.followUp, '', String(raw))
  }
})

test('wrong types in the new fields fall back: an unknown mode is New session, a description that is not text is empty', () => {
  for (const mode of ['weird', 5, true, null, {}, 'FOLLOWUP', 'follow-up']) {
    const { T } = loadClient({ stored: { [KEY]: JSON.stringify({ text: 'x', open: true, mode, followUp: 7 }) } })
    const f = formOf(T)
    assert.equal(f.mode, 'new', JSON.stringify(mode))
    assert.equal(f.followUp, '')
  }
})

test('the page being hidden flushes the description too', () => {
  const { T, store } = loadClient()
  const handlers = {}
  const win = { addEventListener: (t, f) => { handlers[t] = f }, removeEventListener() {} }
  const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  T.installDraftFlush(win, doc)
  T.state.todoForm.mode = 'followup'
  T.state.todoForm.followUp = 'typed behind the saver'
  handlers.pagehide()
  assert.equal(savedDraft(store).followUp, 'typed behind the saver')
  assert.equal(savedDraft(store).mode, 'followup')
})

test('a successful follow-up submit clears the draft and the next start is a New session form', async () => {
  const { T, store } = loadClient({ fetchImpl: async () => okJson({ ok: true, id: 'n1', state: 'awaiting-confirm' }) })
  T.set({ todoForm: FORM({ text: 'Reply to it', mode: 'followup', followUp: 'that session' }) })
  assert.equal(savedDraft(store).followUp, 'that session', 'saved while typing')
  assert.equal(await T.submitTodo(), true)
  assert.ok(isCleared(store), JSON.stringify(store[KEY]))
  const d = savedDraft(store)
  assert.ok(!d.followUp && !d.mode, 'the description and the mode are gone from the draft')
  const next = loadClient({ stored: { [KEY]: store[KEY] } })
  assert.equal(next.T.state.todoForm.mode, 'new')
  assert.equal(next.T.state.todoForm.followUp, '')
})

test('a refused follow-up submit keeps the text, the description and the saved draft', async () => {
  const { T, store } = loadClient({ fetchImpl: async () => okJson({ ok: false, error: 'empty-query' }, 400) })
  T.set({ todoForm: FORM({ text: 'Twenty minutes of work', mode: 'followup', followUp: 'that one' }) })
  assert.equal(await T.submitTodo(), false)
  assert.deepEqual([savedDraft(store).text, savedDraft(store).followUp, savedDraft(store).mode], ['Twenty minutes of work', 'that one', 'followup'])
  assert.ok(!('error' in savedDraft(store)))
})

test('a network failure of a follow-up submit keeps the draft', async () => {
  const { T, store } = loadClient({ fetchImpl: async () => { throw new Error('offline') } })
  T.set({ todoForm: FORM({ text: 'Do not lose me', mode: 'followup', followUp: 'nor me' }) })
  assert.equal(await T.submitTodo(), false)
  assert.equal(savedDraft(store).followUp, 'nor me')
  assert.match(T.state.todoForm.error, /Request failed/)
})

test('Cancel only hides the form: mode, text and description stay in the draft and come back on reopening', () => {
  const { T, store } = loadClient()
  T.set({ todoForm: FORM({ text: 'Draft to keep', mode: 'followup', followUp: 'that one' }) })
  T.closeTodoForm()
  assert.deepEqual(savedDraft(store), { text: 'Draft to keep', workspaceId: '', sparc: false, open: false, mode: 'followup', followUp: 'that one' })
  T.openTodoForm()
  assert.equal(T.state.todoForm.mode, 'followup')
  assert.equal(T.state.todoForm.followUp, 'that one')
  assert.equal(T.state.todoForm.text, 'Draft to keep')
})
