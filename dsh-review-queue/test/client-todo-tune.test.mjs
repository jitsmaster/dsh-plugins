import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FORM, source, loadClient, savedDraft, isCleared, formOf, need, okJson, deferred, tick } from './client-todo-helpers.mjs'

// RED tests: the "Tune prompt" button of the desktop "+ New todo" form (phone is out of scope).
// Click: todoForm.tuning = true, POST /review-queue/v1/todo-tune { text }; ok -> the old text goes to todoForm.original (only if there is none yet),
// the tuned text replaces text, an "Undo tune" link restores original; failure -> text unchanged, the reason in todoForm.error, tuning false.
// tuning is never saved as true; the draft saves original so Undo survives a reload.
// Assumed names (exports.__test): canTune(form), nextFormAfterTune(form, result), tuneTodo(), undoTune().
//   result = { ok: true, text } | { ok: false, error }.   TodoForm: a "Tune prompt" button, the "Undo tune" link, textarea disabled while tuning.
const URL = '/review-queue/v1/todo-tune'

test('canTune: not while busy or tuning, not for a blank text', () => {
  const { T } = loadClient()
  need(T, 'canTune')
  assert.equal(T.canTune(FORM({ text: 'Fix it' })), true)
  assert.equal(T.canTune(FORM({ text: 'Fix it', busy: true })), false)
  assert.equal(T.canTune(FORM({ text: 'Fix it', tuning: true })), false)
  for (const text of ['', '   ', '\n\t ', undefined]) assert.equal(T.canTune(FORM({ text })), false, JSON.stringify(text))
})

test('nextFormAfterTune: a tuned text replaces the text and keeps what the user typed as original', () => {
  const { T } = loadClient()
  need(T, 'nextFormAfterTune')
  const next = T.nextFormAfterTune(FORM({ text: 'fix login', workspaceId: 'w1', sparc: true, tuning: true, error: 'old' }), { ok: true, text: 'Fix the login form.' })
  assert.equal(next.text, 'Fix the login form.')
  assert.equal(next.original, 'fix login')
  assert.equal(next.tuning, false)
  assert.equal(next.error, undefined)
  assert.deepEqual([next.workspaceId, next.sparc, next.open, next.busy], ['w1', true, true, false])
})

test('nextFormAfterTune: a second tune keeps the FIRST original, so Undo returns to what the user typed', () => {
  const { T } = loadClient()
  need(T, 'nextFormAfterTune')
  const next = T.nextFormAfterTune(FORM({ text: 'tuned once', original: 'typed by me', tuning: true }), { ok: true, text: 'tuned twice' })
  assert.equal(next.text, 'tuned twice')
  assert.equal(next.original, 'typed by me')
})

test('nextFormAfterTune: a failure leaves the text and the original alone and shows the reason', () => {
  const { T } = loadClient()
  need(T, 'nextFormAfterTune')
  const a = T.nextFormAfterTune(FORM({ text: 'mine', tuning: true }), { ok: false, error: 'no model available' })
  assert.deepEqual([a.text, a.original, a.tuning, a.error], ['mine', undefined, false, 'no model available'])
  const b = T.nextFormAfterTune(FORM({ text: 'tuned', original: 'typed', tuning: true }), { ok: false, error: 'x' })
  assert.deepEqual([b.text, b.original], ['tuned', 'typed'])
})

test('tuneTodo posts the text to /v1/todo-tune, is tuning while it waits, then shows the tuned text with Undo available', async () => {
  const seen = []
  const gate = deferred()
  const { T } = loadClient({ fetchImpl: async (url, opts) => { seen.push([url, opts.method, JSON.parse(opts.body)]); await gate.promise; return okJson({ ok: true, text: 'Tuned text' }) } })
  need(T, 'tuneTodo')
  T.set({ todoForm: FORM({ text: 'rough idea' }) })
  const run = T.tuneTodo()
  await tick()
  assert.equal(T.state.todoForm.tuning, true)
  assert.equal(T.state.todoForm.text, 'rough idea', 'the text is not touched while waiting')
  gate.resolve()
  assert.equal(await run, true)
  assert.deepEqual(seen, [[URL, 'POST', { text: 'rough idea' }]])
  const f = formOf(T)
  assert.deepEqual([f.text, f.original, f.tuning, f.error], ['Tuned text', 'rough idea', false, undefined])
})

test('a failed tune keeps the text and says why: no model, an empty answer, too long, an old server, no network', async () => {
  const cases = [
    [() => okJson({ ok: false, error: 'no model available' }, 409), /no model available/i],
    [() => okJson({ ok: false, error: 'the model returned nothing' }, 200), /the model returned nothing/],
    [() => okJson({ ok: false, error: 'too-long' }, 400), /^That is too long\.$/],
    [() => okJson({ error: 'unknown-action' }, 404), /older than this page/],
    [() => { throw new Error('offline') }, /Request failed: offline/],
  ]
  for (const [answer, expected] of cases) {
    const { T } = loadClient({ fetchImpl: async () => answer() })
    need(T, 'tuneTodo')
    T.set({ todoForm: FORM({ text: 'untouched text' }) })
    assert.equal(await T.tuneTodo(), false)
    const f = formOf(T)
    assert.equal(f.text, 'untouched text')
    assert.equal(f.original, undefined)
    assert.equal(f.tuning, false)
    assert.match(f.error, expected)
  }
})

test('tuneTodo sends nothing for a blank text, while busy, or while it is already tuning', async () => {
  let posts = 0
  const gate = deferred()
  const { T } = loadClient({ fetchImpl: async () => { posts++; await gate.promise; return okJson({ ok: true, text: 'T' }) } })
  need(T, 'tuneTodo')
  T.set({ todoForm: FORM({ text: '   ' }) })
  assert.equal(await T.tuneTodo(), false)
  T.set({ todoForm: FORM({ text: 'x', busy: true }) })
  assert.equal(await T.tuneTodo(), false)
  assert.equal(posts, 0)
  T.set({ todoForm: FORM({ text: 'x' }) })
  const first = T.tuneTodo()
  await tick()
  assert.equal(await T.tuneTodo(), false, 'a second click while tuning does nothing')
  assert.equal(posts, 1)
  gate.resolve()
  await first
})

test('Undo tune puts the typed text back and forgets the original; without an original it does nothing', () => {
  const { T, store } = loadClient()
  need(T, 'undoTune')
  T.set({ todoForm: FORM({ text: 'tuned', original: 'typed by me', error: 'stale' }) })
  T.undoTune()
  const f = formOf(T)
  assert.deepEqual([f.text, f.original, f.error], ['typed by me', undefined, undefined])
  const d = savedDraft(store)
  assert.equal(d.text, 'typed by me')
  assert.ok(!d.original)
  T.undoTune()
  assert.equal(T.state.todoForm.text, 'typed by me')
})

test('tuning twice and undoing returns to the first text; the second request carries the tuned text', async () => {
  const bodies = []
  let n = 0
  const { T } = loadClient({ fetchImpl: async (url, opts) => { bodies.push(JSON.parse(opts.body).text); return okJson({ ok: true, text: 'tuned ' + ++n }) } })
  need(T, 'tuneTodo'); need(T, 'undoTune')
  T.set({ todoForm: FORM({ text: 'first typed' }) })
  await T.tuneTodo()
  await T.tuneTodo()
  assert.deepEqual(bodies, ['first typed', 'tuned 1'])
  assert.deepEqual([T.state.todoForm.text, T.state.todoForm.original], ['tuned 2', 'first typed'])
  T.undoTune()
  assert.equal(T.state.todoForm.text, 'first typed')
})

test('tuning is never saved as true; the tuned text and the original are saved, so Undo survives a reload', async () => {
  const gate = deferred()
  const { T, store } = loadClient({ fetchImpl: async () => { await gate.promise; return okJson({ ok: true, text: 'Tuned' }) } })
  need(T, 'tuneTodo')
  T.set({ todoForm: FORM({ text: 'typed' }) })
  const run = T.tuneTodo()
  await tick()
  assert.equal(T.state.todoForm.tuning, true)
  assert.equal(savedDraft(store)?.text, 'typed', 'while waiting the draft still holds what the user typed')
  assert.ok(!savedDraft(store)?.tuning)
  gate.resolve()
  await run
  const d = savedDraft(store)
  assert.deepEqual([d.text, d.original], ['Tuned', 'typed'])
  assert.ok(!d.tuning)
  const next = loadClient({ stored: { 'dsh-review-queue.todoDraft': store['dsh-review-queue.todoDraft'] } })
  assert.deepEqual([next.T.state.todoForm.text, next.T.state.todoForm.original, !!next.T.state.todoForm.tuning], ['Tuned', 'typed', false])
})

test('adding a tuned todo posts the tuned text, and then the form, the original and the saved draft are gone', async () => {
  const posts = []
  let answer = { ok: true, text: 'Tuned text' }
  const { T, store } = loadClient({ fetchImpl: async (url, opts) => { posts.push([url, JSON.parse(opts.body)]); return okJson(answer) } })
  need(T, 'tuneTodo')
  T.set({ todoForm: FORM({ text: 'rough', workspaceId: 'w1' }) })
  await T.tuneTodo()
  answer = { ok: true, id: 'n1', state: 'starting' }
  assert.equal(await T.submitTodo(), true)
  assert.deepEqual(posts[1], ['/review-queue/v1/todo', { text: 'Tuned text', workspaceId: 'w1', sparc: false }])
  assert.equal(T.state.todoForm.original, undefined)
  assert.ok(isCleared(store))
})

test('nothing is added while the text is being tuned: submitTodo does nothing and the Add todo button is disabled', async () => {
  let posts = 0
  const { T } = loadClient({ fetchImpl: async () => { posts++; return okJson({ ok: true }) } })
  T.set({ todoForm: FORM({ text: 'being tuned', tuning: true }) })
  assert.equal(await T.submitTodo(), false)
  assert.equal(posts, 0)
  assert.equal(T.state.todoForm.text, 'being tuned')
  const form = source.slice(source.indexOf('function TodoForm'), source.indexOf('function Head('))
  assert.match(form, /className: "rq-btn pri", disabled: f\.busy \|\| f\.tuning/, 'Add todo is disabled through tuning')
})

test('Cancel keeps the tuned text and its original', () => {
  const { T, store } = loadClient()
  need(T, 'closeTodoForm')
  T.set({ todoForm: FORM({ text: 'tuned', original: 'typed' }) })
  T.closeTodoForm()
  assert.deepEqual([T.state.todoForm.text, T.state.todoForm.original, T.state.todoForm.open], ['tuned', 'typed', false])
  assert.equal(savedDraft(store).original, 'typed')
})

test('source: TodoForm has the Tune prompt button with its hint, a textarea that is disabled while tuning, and the Undo tune link', () => {
  const form = source.slice(source.indexOf('function TodoForm'), source.indexOf('function Head('))
  assert.match(form, /"Tune prompt"/)
  assert.ok(form.includes('Rewrite the prompt with the prompt-tune rules and put the result in the box'), 'the hint text')
  assert.match(form, /onClick: tuneTodo/)
  assert.match(form, /canTune\(f\)/, 'the button is disabled through canTune')
  assert.match(form, /className: "rq-ta"[^\n]*disabled: [^,]*tuning/, 'the textarea is disabled while tuning')
  assert.match(form, /f\.original/)
  assert.match(form, /"Undo tune"/)
  assert.match(form, /onClick: undoTune/)
  assert.ok(Math.abs(form.indexOf('"Tune prompt"') - form.indexOf('"Add todo"')) < 700, 'next to Add todo')
})
