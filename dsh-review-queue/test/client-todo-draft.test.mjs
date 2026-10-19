import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KEY, FORM, source, loadClient, savedDraft, isCleared, formOf, need, okJson } from './client-todo-helpers.mjs'

// RED tests: the "+ New todo" form of the Task list (lib/client.js) must never lose the typed text by itself.
// The draft {text, workspaceId, sparc, open, original?} is written to localStorage under LS.todoDraft SYNCHRONOUSLY on every change
// (no debounce, so a DSH crash loses nothing), flushed once more on pagehide / beforeunload / visibilitychange hidden, restored at start
// (busy and error never), and cleared only by a successful submit.
// Assumed names: LS.todoDraft = 'dsh-review-queue.todoDraft'; exports.__test: patchForm, openTodoForm, closeTodoForm, installDraftFlush(win, doc).
// Tests that go through the existing entry points (set, submitTodo, applySnapshot, setOverlay, state) fail on an assertion today; the ones
// that need a not yet exported helper first assert that the export exists.
const draftWrites = (writes) => writes.filter(([k]) => k === KEY)

test('the draft has its own localStorage key, next to the other review-queue keys', () => {
  const { T } = loadClient()
  assert.equal(T.LS.todoDraft, KEY)
  assert.equal(new Set(Object.values(T.LS)).size, Object.values(T.LS).length, 'no key is shared')
})

test('a change of the form is in localStorage at once: no timer has to fire first', () => {
  const { T, store, writes } = loadClient()
  const text = 'Line one\n\n  indented line \n'
  T.set({ todoForm: FORM({ text, workspaceId: 'w1', sparc: true }) })
  assert.ok(draftWrites(writes).length >= 1, 'the draft was written during set()')
  assert.deepEqual(savedDraft(store), { text, workspaceId: 'w1', sparc: true, open: true })
})

test('every keystroke is written at once (patchForm), the last text wins', () => {
  const { T, store } = loadClient()
  need(T, 'patchForm')
  for (const text of ['a', 'ab', 'abc d']) {
    T.patchForm({ text })
    assert.equal(savedDraft(store)?.text, text)
  }
  T.patchForm({ workspaceId: 'w2' })
  assert.equal(savedDraft(store).workspaceId, 'w2')
  T.patchForm({ sparc: true })
  assert.equal(savedDraft(store).sparc, true)
})

test('the saved draft holds only text, workspaceId, sparc, open and original: never busy, error or tuning', () => {
  const { T, store } = loadClient()
  T.set({ todoForm: FORM({ text: 'x', busy: true, error: 'boom', tuning: true, original: 'orig' }) })
  const d = savedDraft(store)
  assert.ok(d, 'something was saved')
  assert.deepEqual(Object.keys(d).sort(), ['open', 'original', 'sparc', 'text', 'workspaceId'])
  assert.equal(d.original, 'orig')
})

test('a text of the 4000 limit is saved whole, and so is one above it (the saver never truncates)', () => {
  const { T, store } = loadClient()
  const a = 'a'.repeat(3999) + '\n'
  T.set({ todoForm: FORM({ text: a }) })
  assert.equal(savedDraft(store)?.text, a)
  const b = 'b'.repeat(5000)
  T.set({ todoForm: FORM({ text: b }) })
  assert.equal(savedDraft(store)?.text, b)
})

test('the draft is restored when the client starts: text, workspace, SPARC, original and the open state; busy and error are not', () => {
  const draft = { text: 'A long prompt\nsecond line', workspaceId: 'w2', sparc: true, open: true, original: 'what I typed' }
  const { T } = loadClient({ stored: { [KEY]: JSON.stringify(draft) } })
  const f = formOf(T)
  assert.equal(f.text, draft.text)
  assert.equal(f.workspaceId, 'w2')
  assert.equal(f.sparc, true)
  assert.equal(f.open, true)
  assert.equal(f.original, 'what I typed')
  assert.equal(f.busy, false)
  assert.equal(f.error, undefined)
  assert.ok(!f.tuning)
})

test('a form that was closed (Cancel / Esc) is restored closed, with its text', () => {
  const { T } = loadClient({ stored: { [KEY]: JSON.stringify({ text: 'kept', workspaceId: '', sparc: false, open: false }) } })
  assert.equal(T.state.todoForm.open, false)
  assert.equal(T.state.todoForm.text, 'kept')
})

test('busy, error and tuning in a saved draft are ignored at start', () => {
  const { T } = loadClient({ stored: { [KEY]: JSON.stringify({ text: 'x', open: true, busy: true, error: 'boom', tuning: true }) } })
  const f = formOf(T)
  assert.equal(f.text, 'x')
  assert.equal(f.busy, false)
  assert.equal(f.error, undefined)
  assert.ok(!f.tuning)
})

test('corrupt or non-object saved JSON does not throw and starts empty; wrong field types fall back to the empty values', () => {
  const nothing = ['{not json', 'null', '5', '"some text"', '[1,2]', '', 'true']
  for (const raw of nothing) {
    const { T } = loadClient({ stored: { [KEY]: raw } })
    const f = formOf(T)
    assert.equal(f.text, '', raw)
    assert.equal(f.open, false, raw)
    assert.equal(f.busy, false, raw)
  }
  const { T } = loadClient({ stored: { [KEY]: JSON.stringify({ text: 5, workspaceId: 7, sparc: 'yes', open: 'y', original: {} }) } })
  const f = formOf(T)
  assert.deepEqual([f.text, f.workspaceId, f.sparc, f.open], ['', '', false, false])
  assert.ok(!f.original)
})

test('a successful submit clears the saved draft and the next start is empty', async () => {
  const { T, store } = loadClient({ fetchImpl: async () => okJson({ ok: true, id: 'n1', state: 'starting' }) })
  T.set({ todoForm: FORM({ text: 'Fix it', workspaceId: 'w1' }) })
  assert.equal(savedDraft(store)?.text, 'Fix it', 'saved while typing')
  assert.equal(await T.submitTodo(), true)
  assert.ok(isCleared(store), JSON.stringify(store[KEY]))
  const next = loadClient({ stored: { [KEY]: store[KEY] } })
  assert.equal(next.T.state.todoForm.text, '')
  assert.equal(next.T.state.todoForm.open, false)
})

test('while the request is on its way the draft is still saved (a crash then loses nothing)', async () => {
  let atRequest
  const holder = {}
  const { T, store } = loadClient({ fetchImpl: async () => { atRequest = savedDraft(holder.store); return okJson({ ok: true }) } })
  holder.store = store
  T.set({ todoForm: FORM({ text: 'Keep me until the server said ok' }) })
  await T.submitTodo()
  assert.equal(atRequest?.text, 'Keep me until the server said ok')
  assert.equal(atRequest?.busy, undefined)
})

test('a refused submit keeps the text and the saved draft', async () => {
  const { T, store } = loadClient({ fetchImpl: async () => okJson({ ok: false, error: 'unknown-workspace' }, 400) })
  T.set({ todoForm: FORM({ text: 'Twenty minutes of work', workspaceId: 'gone' }) })
  assert.equal(await T.submitTodo(), false)
  assert.equal(T.state.todoForm.text, 'Twenty minutes of work')
  assert.equal(T.state.todoForm.open, true)
  assert.equal(savedDraft(store)?.text, 'Twenty minutes of work')
  assert.ok(!('error' in savedDraft(store)), 'the error text is not saved')
})

test('a network failure keeps the text and the saved draft', async () => {
  const { T, store } = loadClient({ fetchImpl: async () => { throw new Error('offline') } })
  T.set({ todoForm: FORM({ text: 'Do not lose me' }) })
  assert.equal(await T.submitTodo(), false)
  assert.match(T.state.todoForm.error, /Request failed/)
  assert.equal(T.state.todoForm.text, 'Do not lose me')
  assert.equal(savedDraft(store)?.text, 'Do not lose me')
})

test('Cancel only hides the form: the text stays, the draft stays, reopening shows it again', () => {
  const { T, store } = loadClient()
  need(T, 'closeTodoForm'); need(T, 'openTodoForm')
  T.set({ todoForm: FORM({ text: 'Draft to keep', workspaceId: 'w1', sparc: true }) })
  T.closeTodoForm()
  assert.equal(T.state.todoForm.open, false)
  assert.equal(T.state.todoForm.text, 'Draft to keep')
  assert.deepEqual(savedDraft(store), { text: 'Draft to keep', workspaceId: 'w1', sparc: true, open: false })
  T.openTodoForm()
  assert.equal(T.state.todoForm.open, true)
  assert.equal(T.state.todoForm.text, 'Draft to keep')
  assert.equal(T.state.todoForm.workspaceId, 'w1')
  assert.equal(savedDraft(store).open, true)
})

test('Esc goes through closeTodoForm (hide, never reset)', () => {
  const overlay = source.slice(source.indexOf('function Overlay('))
  assert.match(overlay, /if \(state\.todoForm\.open\) closeTodoForm\(\)/)
})

test('closing and reopening the whole overlay keeps the text and the saved draft', () => {
  const { T, store } = loadClient()
  T.set({ todoForm: FORM({ text: 'Survives the overlay' }) })
  T.setOverlay(false)
  T.setOverlay(true)
  assert.equal(T.state.todoForm.text, 'Survives the overlay')
  assert.equal(savedDraft(store)?.text, 'Survives the overlay')
})

test('a snapshot refresh never touches the form or the saved draft', () => {
  const { T, store } = loadClient()
  T.set({ todoForm: FORM({ text: 'Typed while the list refreshes', sparc: true }) })
  const before = formOf(T)
  T.applySnapshot({ snapshotId: 's1', open: [{ id: 'a' }], resolved: [] })
  T.applySnapshot({ snapshotId: 's2', open: [], resolved: [] })
  assert.deepEqual(formOf(T), before)
  assert.equal(savedDraft(store)?.text, 'Typed while the list refreshes')
})

test('audit: the success reset of submitTodo comes after the failure return, so only a successful submit empties the form', () => {
  const submit = source.slice(source.indexOf('async function submitTodo'), source.indexOf('/** Start (or Retry) a todo'))
  assert.ok(submit.includes('if (error)'), 'submitTodo returns on an error')
  assert.ok(submit.indexOf('if (error)') < submit.indexOf('set({ todoForm: {'), 'the reset comes after the failure return')
  assert.equal([...submit.matchAll(/text: ""/g)].length, 1, 'one reset in submitTodo')
})

test('the page being hidden or closed flushes the latest draft once more (pagehide, beforeunload, visibilitychange hidden)', () => {
  const { T, store } = loadClient()
  need(T, 'installDraftFlush')
  const events = () => ({ handlers: {}, addEventListener(t, f) { (this.handlers[t] ??= []).push(f) }, removeEventListener(t, f) { this.handlers[t] = (this.handlers[t] ?? []).filter((x) => x !== f) }, fire(t) { for (const f of [...(this.handlers[t] ?? [])]) f({ type: t }) } })
  const win = events()
  const doc = Object.assign(events(), { visibilityState: 'visible' })
  const off = T.installDraftFlush(win, doc)
  assert.equal(win.handlers.pagehide?.length, 1)
  assert.equal(win.handlers.beforeunload?.length, 1)
  assert.equal(doc.handlers.visibilitychange?.length, 1)
  T.state.todoForm.text = 'changed behind the saver'  // not through set(): only the flush can save it
  win.fire('pagehide')
  assert.equal(savedDraft(store)?.text, 'changed behind the saver')
  T.state.todoForm.text = 'second'
  win.fire('beforeunload')
  assert.equal(savedDraft(store)?.text, 'second')
  T.state.todoForm.text = 'third'
  doc.fire('visibilitychange')
  assert.equal(savedDraft(store)?.text, 'second', 'visible again: nothing to flush')
  doc.visibilityState = 'hidden'
  doc.fire('visibilitychange')
  assert.equal(savedDraft(store)?.text, 'third')
  off()
  T.state.todoForm.text = 'after off'
  win.fire('pagehide'); doc.fire('visibilitychange')
  assert.equal(savedDraft(store)?.text, 'third', 'the remover detaches every listener')
})

test('source: apply() installs the flush on the window and the document', () => {
  const apply = source.slice(source.indexOf('function apply('), source.indexOf('exports.apply'))
  assert.match(apply, /installDraftFlush\(/)
})
