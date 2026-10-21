import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Slice D: the follow-up mode and the description are part of the phone's unsent-todo draft (rq-m.todoDraft). They are written ONLY when set, so
// a draft saved before this feature (and every New session draft) restores as New session with no description, and the saved JSON of a New session
// draft stays exactly { text, workspaceId, sparc }.
const KEY = 'rq-m.todoDraft'
const form = await import('../lib/mobile/todo-form.js')
const { emptyTodoDraft, saveTodoDraft, loadTodoDraft } = form
const fakeStorage = (initial = {}) => { const map = new Map(Object.entries(initial)); return { map, get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => { map.set(k, String(v)) } } }
const base = { text: 'Fix the login', workspaceId: 'aaaa/w1', sparc: true }

test('a follow-up draft is saved with its mode and description, and restored whole', () => {
  const s = fakeStorage()
  saveTodoDraft(s, { ...base, mode: 'followup', followUp: 'the login bug' })
  assert.deepEqual(JSON.parse(s.map.get(KEY)), { ...base, mode: 'followup', followUp: 'the login bug' })
  assert.deepEqual(loadTodoDraft(s), { ...base, mode: 'followup', followUp: 'the login bug' })
})

test('a New session draft is saved exactly as before: no mode key, and no followUp key when there are no words', () => {
  const s = fakeStorage()
  saveTodoDraft(s, { ...base, mode: 'new', followUp: '' })
  assert.deepEqual(Object.keys(JSON.parse(s.map.get(KEY))).sort(), ['sparc', 'text', 'workspaceId'])
  saveTodoDraft(s, base)
  assert.deepEqual(JSON.parse(s.map.get(KEY)), base)
})

test('the description is kept when the user switches back to New session (the desktop keeps it too), but the mode is not', () => {
  const s = fakeStorage()
  saveTodoDraft(s, { ...base, mode: 'new', followUp: 'words I typed' })
  assert.deepEqual(JSON.parse(s.map.get(KEY)), { ...base, followUp: 'words I typed' })
  assert.deepEqual(loadTodoDraft(s), { ...base, followUp: 'words I typed' })
})

test('a follow-up draft with no description yet saves the mode only', () => {
  const s = fakeStorage()
  saveTodoDraft(s, { ...base, mode: 'followup', followUp: '' })
  assert.deepEqual(JSON.parse(s.map.get(KEY)), { ...base, mode: 'followup' })
  assert.deepEqual(loadTodoDraft(s), { ...base, mode: 'followup' })
})

test('an old draft (saved before the feature) restores as New session: no mode, no description, same object shape as an empty draft', () => {
  const old = fakeStorage({ [KEY]: JSON.stringify(base) })
  const d = loadTodoDraft(old)
  assert.deepEqual(d, base)
  assert.equal(form.isFollowUpDraft(d), false)
  assert.equal('mode' in d, false)
  assert.equal('followUp' in d, false)
  assert.deepEqual(loadTodoDraft(fakeStorage()), emptyTodoDraft())
})

test('loadTodoDraft ignores a mode other than "followup" and a description that is not a string', () => {
  for (const extra of [{ mode: 'new' }, { mode: 'FOLLOWUP' }, { mode: 7 }, { mode: true }, { mode: null }, { followUp: 5 }, { followUp: null }, { followUp: ['x'] }, { followUp: '' }]) {
    assert.deepEqual(loadTodoDraft(fakeStorage({ [KEY]: JSON.stringify({ ...base, ...extra }) })), base, JSON.stringify(extra))
  }
})

test('a long description is saved whole (the 300 limit is the input\'s, not the storage\'s) and a quota error still never throws', () => {
  const s = fakeStorage()
  saveTodoDraft(s, { ...base, mode: 'followup', followUp: 'w'.repeat(500) })
  assert.equal(loadTodoDraft(s).followUp.length, 500)
  assert.doesNotThrow(() => saveTodoDraft({ get: () => null, set: () => { throw new Error('quota') } }, { ...base, mode: 'followup', followUp: 'x' }))
})

// ---- api.js: the real state with fake globals ------------------------------------------------------------------------------------------

globalThis.location = { pathname: '/review-queue/m/' }
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
const api = await import('../lib/mobile/api.js')
const saved = () => (store.has(KEY) ? JSON.parse(store.get(KEY)) : null)
let calls, replies
beforeEach(() => {
  api.set({ todoDraft: emptyTodoDraft(), busy: {}, errors: {} })
  store.clear()
  calls = []
  replies = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body === undefined ? undefined : JSON.parse(init.body), draftOnDisk: saved() })
    const r = replies.shift() ?? { status: 200, body: { ok: true } }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.body }
  }
})

test('every keystroke of the follow-up draft (text, description, mode) is on disk at once', () => {
  api.set({ todoDraft: { ...base, mode: 'followup', followUp: 'the' } })
  assert.deepEqual(saved(), { ...base, mode: 'followup', followUp: 'the' })
  api.set({ todoDraft: { ...base, mode: 'followup', followUp: 'the login bug' } })
  assert.equal(saved().followUp, 'the login bug')
})

test('the follow-up draft is restored when the page starts', async () => {
  store.set(KEY, JSON.stringify({ ...base, mode: 'followup', followUp: 'saved words' }))
  const fresh = await import('../lib/mobile/api.js?followup-restored')
  assert.deepEqual({ ...fresh.state.todoDraft }, { ...base, mode: 'followup', followUp: 'saved words' })
})

test('a draft from before the feature starts the page as New session', async () => {
  store.set(KEY, JSON.stringify(base))
  const fresh = await import('../lib/mobile/api.js?followup-old')
  assert.deepEqual({ ...fresh.state.todoDraft }, base)
  assert.equal(form.isFollowUpDraft(fresh.state.todoDraft), false)
})

test('a follow-up posts through startTodo to /v1/todo with exactly { text, followUp }, and a success clears mode and description too', async () => {
  const draft = { ...base, mode: 'followup', followUp: 'the login bug' }
  api.set({ todoDraft: draft })
  const payload = form.newTodoPayload(draft)
  replies.push({ status: 200, body: { ok: true, id: 'n1' } })
  assert.deepEqual(await api.startTodo(payload.body), { ok: true })
  assert.match(calls[0].url, /\/v1\/todo$/)
  assert.deepEqual(calls[0].body, { text: 'Fix the login', followUp: 'the login bug' })
  assert.deepEqual({ ...api.state.todoDraft }, emptyTodoDraft())
  assert.deepEqual(saved(), { text: '', workspaceId: '', sparc: false }, 'no mode and no description left on disk')
})

test('a refused follow-up keeps the whole draft, mode and description included', async () => {
  const draft = { ...base, mode: 'followup', followUp: 'the login bug' }
  api.set({ todoDraft: draft })
  replies.push({ status: 400, body: { error: 'empty-query' } })
  const r = await api.startTodo(form.newTodoPayload(draft).body)
  assert.equal(r.ok, false)
  assert.deepEqual({ ...api.state.todoDraft }, draft)
  assert.deepEqual(saved(), draft)
  assert.equal(form.todoErrorText({ errorText: () => 'CORE' }, r.status, r.body), 'Say which session this is for.')
})

test('loadWorkspaces still drops a stale workspace id and keeps the follow-up mode and description', async () => {
  api.set({ todoDraft: { ...base, workspaceId: 'gone', mode: 'followup', followUp: 'words' } })
  replies.push({ status: 200, body: { workspaces: [{ id: 'w1', title: 'A' }] } })
  await api.loadWorkspaces()
  assert.deepEqual({ ...api.state.todoDraft }, { ...base, workspaceId: '', mode: 'followup', followUp: 'words' })
  assert.deepEqual(saved(), { ...base, workspaceId: '', mode: 'followup', followUp: 'words' })
})
