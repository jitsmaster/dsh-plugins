import { test } from 'node:test'
import assert from 'node:assert/strict'

// The phone's "+ New todo" form (route #/new): pure validation, payload and wording in lib/mobile/todo-form.js, the same rules as the
// desktop form (core.todoFormProblem: empty / more than 4000 characters) and the same API (POST /v1/todo {text, workspaceId?, sparc?}).
// Contract under test:
//   TODO_MAX = 4000
//   emptyTodoDraft()                          -> a fresh { text: '', workspaceId: '', sparc: false } (the draft kept while navigating)
//   newTodoPayload({ text, workspaceId, sparc }) -> { ok: true, body: { text, sparc, workspaceId? } } | { ok: false, message }
//   workspaceChoices(workspaces)              -> [{ value: '', label: 'Choose for me' }, ...{ value: id, label: title }]
//   workspacesNote(workspaces, error)         -> message | null: a failed load or an empty list says so; a loaded list or "not loaded yet" is silent
//   todoErrorText(core, status, body)         -> friendly text for empty / too-long / unknown-workspace / no-registry / owner-offline,
//                                                everything else is core.errorText(status, body) unchanged
// Imported per test so each case fails on its own while lib/mobile/todo-form.js does not exist yet.
const load = async () => import('../lib/mobile/todo-form.js')

test('the text limit is 4000 characters, like the server', async () => {
  const { TODO_MAX } = await load()
  assert.equal(TODO_MAX, 4000)
})

test('emptyTodoDraft is an empty text, "Choose for me" and no SPARC, and every call is a new object', async () => {
  const { emptyTodoDraft } = await load()
  assert.deepEqual(emptyTodoDraft(), { text: '', workspaceId: '', sparc: false })
  assert.notEqual(emptyTodoDraft(), emptyTodoDraft())
})

test('newTodoPayload builds the body: trimmed text, sparc, and the workspace only when one was picked', async () => {
  const { newTodoPayload } = await load()
  assert.deepEqual(newTodoPayload({ text: '  Fix the login  ', workspaceId: '', sparc: false }), { ok: true, body: { text: 'Fix the login', sparc: false } })
  assert.deepEqual(newTodoPayload({ text: 'Fix it', workspaceId: 'aaaa/w1', sparc: true }), { ok: true, body: { text: 'Fix it', sparc: true, workspaceId: 'aaaa/w1' } })
})

test('newTodoPayload keeps the line breaks inside the text', async () => {
  const { newTodoPayload } = await load()
  assert.equal(newTodoPayload({ text: 'one\n\ntwo\nthree', workspaceId: '', sparc: false }).body.text, 'one\n\ntwo\nthree')
})

test('newTodoPayload treats a missing workspace and a missing sparc as "Choose for me" and off', async () => {
  const { newTodoPayload } = await load()
  assert.deepEqual(newTodoPayload({ text: 'x' }), { ok: true, body: { text: 'x', sparc: false } })
  assert.deepEqual(newTodoPayload({ text: 'x', workspaceId: undefined, sparc: 'yes' }), { ok: true, body: { text: 'x', sparc: true } })
})

test('newTodoPayload refuses an empty or blank task with the desktop wording', async () => {
  const { newTodoPayload } = await load()
  for (const text of ['', '   ', '\n\t ', undefined, null, 42]) {
    assert.deepEqual(newTodoPayload({ text, workspaceId: 'w', sparc: true }), { ok: false, message: 'Type the task first.' }, String(text))
  }
  assert.deepEqual(newTodoPayload({}), { ok: false, message: 'Type the task first.' })
})

test('newTodoPayload accepts exactly 4000 characters and refuses 4001 (counted after trimming)', async () => {
  const { newTodoPayload } = await load()
  assert.equal(newTodoPayload({ text: 'x'.repeat(4000) }).ok, true)
  assert.deepEqual(newTodoPayload({ text: 'x'.repeat(4001) }), { ok: false, message: 'That is too long.' })
  assert.equal(newTodoPayload({ text: '  ' + 'x'.repeat(4000) + '  ' }).ok, true)
})

test('workspaceChoices starts with "Choose for me" and lists every workspace by title, in the order given', async () => {
  const { workspaceChoices } = await load()
  assert.deepEqual(workspaceChoices([{ id: 'aaaa/w1', title: 'alpha (DSH :1)' }, { id: 'bbbb/w1', title: 'beta' }]), [
    { value: '', label: 'Choose for me' },
    { value: 'aaaa/w1', label: 'alpha (DSH :1)' },
    { value: 'bbbb/w1', label: 'beta' },
  ])
})

test('workspaceChoices still offers "Choose for me" when no list is loaded', async () => {
  const { workspaceChoices } = await load()
  const only = [{ value: '', label: 'Choose for me' }]
  assert.deepEqual(workspaceChoices(null), only)
  assert.deepEqual(workspaceChoices(undefined), only)
  assert.deepEqual(workspaceChoices([]), only)
})

test('workspacesNote: a failed load names the problem and says Choose for me still works (the view offers a reload)', async () => {
  const { workspacesNote } = await load()
  const m = workspacesNote(null, 'Request failed: offline')
  assert.match(m, /Could not load/i)
  assert.match(m, /Choose for me/)
})

test('workspacesNote: a list that loaded empty says no workspace is listed, so the user knows why the dropdown is bare', async () => {
  const { workspacesNote } = await load()
  assert.match(workspacesNote([], null), /No workspace/i)
  assert.match(workspacesNote([], null), /Choose for me/)
})

test('workspacesNote is silent while loading and when there are workspaces', async () => {
  const { workspacesNote } = await load()
  assert.equal(workspacesNote(null, null), null)
  assert.equal(workspacesNote(undefined, undefined), null)
  assert.equal(workspacesNote([{ id: 'w', title: 'alpha' }], null), null)
})

test('todoErrorText: the five codes of POST /v1/todo get a friendly sentence each', async () => {
  const { todoErrorText } = await load()
  const core = { errorText: () => 'CORE' }
  assert.match(todoErrorText(core, 400, { error: 'empty' }), /Type the task/)
  assert.match(todoErrorText(core, 400, { error: 'too-long' }), /4000/)
  assert.match(todoErrorText(core, 400, { error: 'unknown-workspace' }), /workspace/i)
  assert.match(todoErrorText(core, 400, { error: 'unknown-workspace' }), /Pick another|Choose for me/)
  assert.match(todoErrorText(core, 409, { error: 'no-registry' }), /DSH/)
  assert.match(todoErrorText(core, 409, { error: 'no-registry' }), /computer/i)
  assert.match(todoErrorText(core, 409, { error: 'owner-offline' }), /not running/i)
  const all = ['empty', 'too-long', 'unknown-workspace', 'no-registry', 'owner-offline'].map((error) => todoErrorText(core, 400, { error }))
  assert.equal(new Set(all).size, 5, 'distinct sentences')
  assert.ok(!all.includes('CORE'), 'these are not the generic text')
})

test('todoErrorText hands every other failure to core.errorText unchanged (the same words as the desktop)', async () => {
  const { todoErrorText } = await load()
  const calls = []
  const core = { errorText: (status, body) => { calls.push([status, body]); return 'CORE:' + status + ':' + (body && body.error) } }
  assert.equal(todoErrorText(core, 404, {}), 'CORE:404:undefined')
  assert.equal(todoErrorText(core, 409, { error: 'owner-away' }), 'CORE:409:owner-away')
  assert.equal(todoErrorText(core, 500, null), 'CORE:500:null')
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[1], [409, { error: 'owner-away' }])
})
