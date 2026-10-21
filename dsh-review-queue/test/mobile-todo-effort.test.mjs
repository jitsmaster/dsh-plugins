import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The Effort field of the phone's New todo form (same behaviour as the desktop form): Default (the model's current default effort) first, then the efforts of the default
// model (GET /v1/model-efforts, answered by the hub); sent only when another one is picked, only for a new session; kept in the saved draft only when set.
const load = async () => import('../lib/mobile/todo-form.js')
const EFFORTS = { ok: true, efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' }
const mem = (init = {}) => { const m = { ...init }; return { get: (k) => m[k] ?? null, set: (k, v) => { m[k] = v }, m } }

test('effortChoices: Default (<the default effort>) first, then every effort; nothing when the model has none or the list is not known', async () => {
  const { effortChoices } = await load()
  assert.deepEqual(effortChoices(EFFORTS), [{ value: '', label: 'Default (Medium)' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }])
  assert.deepEqual(effortChoices({ ok: true, efforts: [{ id: 'a', name: 'A' }] }), [{ value: '', label: 'Default' }, { value: 'a', label: 'A' }])
  assert.deepEqual(effortChoices({ ok: true, efforts: [] }), [])
  assert.deepEqual(effortChoices(null), [])
  assert.deepEqual(effortChoices(undefined), [])
})

test('effortName: the name of an effort, else its id', async () => {
  const { effortName } = await load()
  assert.equal(effortName(EFFORTS, 'high'), 'High')
  assert.equal(effortName(EFFORTS, 'turbo'), 'turbo')
  assert.equal(effortName(null, 'high'), 'high')
})

test('the empty draft has no effort key; the payload sends one only for a new session and only when picked', async () => {
  const { emptyTodoDraft, newTodoPayload } = await load()
  assert.equal('effort' in emptyTodoDraft(), false)
  assert.deepEqual(newTodoPayload({ text: 'x', sparc: false, effort: 'high' }).body, { text: 'x', sparc: false, effort: 'high' })
  assert.equal('effort' in newTodoPayload({ text: 'x', sparc: false, effort: '' }).body, false)
  assert.equal('effort' in newTodoPayload({ text: 'x', sparc: false }).body, false)
  assert.equal('effort' in newTodoPayload({ text: 'x', mode: 'followup', followUp: 'the session', effort: 'high' }).body, false)
})

test('the saved draft keeps the effort only when set, and a restored one is read back', async () => {
  const { saveTodoDraft, loadTodoDraft, TODO_DRAFT_KEY } = await load()
  const s = mem()
  saveTodoDraft(s, { text: 'x', workspaceId: '', sparc: false, effort: 'high' })
  assert.equal(JSON.parse(s.m[TODO_DRAFT_KEY]).effort, 'high')
  assert.equal(loadTodoDraft(s).effort, 'high')
  saveTodoDraft(s, { text: 'x', workspaceId: '', sparc: false, effort: '' })
  assert.equal('effort' in JSON.parse(s.m[TODO_DRAFT_KEY]), false)
  assert.equal('effort' in loadTodoDraft(s), false)
  assert.equal('effort' in loadTodoDraft(mem({ [TODO_DRAFT_KEY]: JSON.stringify({ text: 'x', effort: 5 }) })), false)
})

test('dropStaleEffort: an effort the model no longer has is dropped once the list is known; an unknown list changes nothing', async () => {
  const { dropStaleEffort } = await load()
  const draft = { text: 'x', workspaceId: '', sparc: false, effort: 'turbo' }
  assert.deepEqual(dropStaleEffort(draft, EFFORTS), { text: 'x', workspaceId: '', sparc: false })
  const ok = { ...draft, effort: 'high' }
  assert.equal(dropStaleEffort(ok, EFFORTS), ok)
  assert.equal(dropStaleEffort(draft, null), draft)
  assert.equal(dropStaleEffort(draft, { ok: true, efforts: [] }), draft)
})

test('the todo card model names the effort the todo asked for', async () => {
  const { todoCardModel } = await import('../lib/mobile/model.js')
  const core = { todoSelect: () => ({ value: 'w', options: [], placeholder: '' }), todoCardState: () => 'confirm', todoLine: () => '' }
  assert.equal(todoCardModel(core, { id: 't', type: 'todo', text: 'x', state: 'awaiting-confirm', effort: 'high' }, [], undefined).effort, 'high')
  assert.equal(todoCardModel(core, { id: 't', type: 'todo', text: 'x', state: 'awaiting-confirm' }, [], undefined).effort, '')
})

// ---- wiring: source-text checks like mobile-todo-wiring (the views have no DOM harness) --------------------------------------------------
const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'mobile')
const views = readFileSync(join(MOBILE, 'views.js'), 'utf8')
const api = readFileSync(join(MOBILE, 'api.js'), 'utf8')

test('api.js loads GET /v1/model-efforts into state.efforts and drops a stale draft effort', () => {
  assert.match(api, /efforts: null/)
  assert.match(api, /export async function loadEfforts/)
  assert.match(api, /\/v1\/model-efforts/)
  assert.match(api, /dropStaleEffort/)
})

test('the New todo view loads the efforts and shows an Effort dropdown for a new session only; the card says the effort', () => {
  assert.match(views, /loadEfforts/)
  assert.match(views, /effortChoices\(st\.efforts\)/)
  assert.match(views, /Effort/)
  assert.match(views, /effortName\(st\.efforts, m\.effort\)/)
  assert.match(views, /Only this session uses it/)
})
