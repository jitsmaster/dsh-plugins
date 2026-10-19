import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyTodoDraft } from '../lib/mobile/todo-form.js'

// RED tests: the phone's "+ New todo" draft (state.todoDraft, route #/new) must never be lost by itself.
// Pure helpers in lib/mobile/todo-form.js take a storage object { get(key), set(key, value) } (the shape of the storage of api.js):
//   TODO_DRAFT_KEY = 'rq-m.todoDraft'
//   saveTodoDraft(storage, draft)      writes { text, workspaceId, sparc } as JSON, synchronously, whole (no truncation); never throws
//   loadTodoDraft(storage)             -> a draft; an empty one (emptyTodoDraft()) for nothing, corrupt or non-object data; fields coerced
//   forgetTodoDraft(storage)           -> afterwards loadTodoDraft(storage) is an empty draft
//   bindDraftFlush(win, doc, flush)    pagehide on win, visibilitychange (hidden) on doc call flush(); returns the remover
// api.js (imported here with fake globals, as mobile-api-pair does): set({ todoDraft }) saves at once (NOT debounced); the draft is restored
// when the module starts (state.todoDraft); startTodo clears the saved draft only after a successful add; a failure keeps it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEY = 'rq-m.todoDraft'
const load = () => import('../lib/mobile/todo-form.js')
const fakeStorage = (initial = {}) => { const map = new Map(Object.entries(initial)); return { map, get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => { map.set(k, String(v)) } } }
const draft = (over = {}) => ({ text: 'Fix the login', workspaceId: 'aaaa/w1', sparc: true, ...over })

// ---- the pure helpers -----------------------------------------------------------------------------------------------------------------

test('the draft key is rq-m.todoDraft, next to the other phone keys', async () => {
  const { TODO_DRAFT_KEY } = await load()
  assert.equal(TODO_DRAFT_KEY, KEY)
})

test('saveTodoDraft writes the draft synchronously and loadTodoDraft reads it back', async () => {
  const { saveTodoDraft, loadTodoDraft } = await load()
  const s = fakeStorage()
  saveTodoDraft(s, draft({ text: 'Line one\n\n  indented \n' }))
  assert.deepEqual(JSON.parse(s.map.get(KEY)), { text: 'Line one\n\n  indented \n', workspaceId: 'aaaa/w1', sparc: true })
  assert.deepEqual(loadTodoDraft(s), { text: 'Line one\n\n  indented \n', workspaceId: 'aaaa/w1', sparc: true })
})

test('saveTodoDraft keeps only text, workspaceId and sparc, and saves a long text whole', async () => {
  const { saveTodoDraft, loadTodoDraft } = await load()
  const s = fakeStorage()
  saveTodoDraft(s, { ...draft({ text: 'a'.repeat(4000) }), busy: true, error: 'boom' })
  assert.deepEqual(Object.keys(JSON.parse(s.map.get(KEY))).sort(), ['sparc', 'text', 'workspaceId'])
  assert.equal(loadTodoDraft(s).text.length, 4000)
  saveTodoDraft(s, draft({ text: 'b'.repeat(5000) }))
  assert.equal(loadTodoDraft(s).text.length, 5000)
})

test('saveTodoDraft never throws, even when the storage does (private mode, quota)', async () => {
  const { saveTodoDraft } = await load()
  assert.doesNotThrow(() => saveTodoDraft({ get: () => null, set: () => { throw new Error('quota') } }, draft()))
})

test('loadTodoDraft: nothing, corrupt or non-object data gives an empty draft, and every call is a new object', async () => {
  const { loadTodoDraft } = await load()
  for (const raw of [undefined, null, '', '{not json', 'null', '5', '"text"', '[1,2]', 'true']) {
    const s = fakeStorage(raw === undefined ? {} : { [KEY]: raw })
    assert.deepEqual(loadTodoDraft(s), emptyTodoDraft(), String(raw))
  }
  const s = fakeStorage()
  assert.notEqual(loadTodoDraft(s), loadTodoDraft(s))
})

test('loadTodoDraft coerces wrong field types to the empty values (sparc only when it is exactly true)', async () => {
  const { loadTodoDraft } = await load()
  assert.deepEqual(loadTodoDraft(fakeStorage({ [KEY]: JSON.stringify({ text: 5, workspaceId: 7, sparc: 'yes' }) })), emptyTodoDraft())
  assert.deepEqual(loadTodoDraft(fakeStorage({ [KEY]: JSON.stringify({ text: 'only text' }) })), { text: 'only text', workspaceId: '', sparc: false })
})

test('forgetTodoDraft empties the saved draft', async () => {
  const { saveTodoDraft, loadTodoDraft, forgetTodoDraft } = await load()
  const s = fakeStorage()
  saveTodoDraft(s, draft())
  forgetTodoDraft(s)
  assert.deepEqual(loadTodoDraft(s), emptyTodoDraft())
})

test('bindDraftFlush flushes on pagehide and when the page becomes hidden (not when it becomes visible), and detaches', async () => {
  const { bindDraftFlush } = await load()
  const events = () => ({ handlers: {}, addEventListener(t, f) { (this.handlers[t] ??= []).push(f) }, removeEventListener(t, f) { this.handlers[t] = (this.handlers[t] ?? []).filter((x) => x !== f) }, fire(t) { for (const f of [...(this.handlers[t] ?? [])]) f({ type: t }) } })
  const win = events()
  const doc = Object.assign(events(), { visibilityState: 'visible', hidden: false })
  let flushes = 0
  const off = bindDraftFlush(win, doc, () => { flushes++ })
  win.fire('pagehide')
  assert.equal(flushes, 1)
  doc.fire('visibilitychange')
  assert.equal(flushes, 1, 'visible: nothing to flush')
  doc.visibilityState = 'hidden'; doc.hidden = true
  doc.fire('visibilitychange')
  assert.equal(flushes, 2)
  off()
  win.fire('pagehide'); doc.fire('visibilitychange')
  assert.equal(flushes, 2)
})

// ---- api.js: the real state object with fake globals ----------------------------------------------------------------------------------

globalThis.location = { pathname: '/review-queue/m/' }
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
const api = await import('../lib/mobile/api.js')
const saved = () => (store.has(KEY) && store.get(KEY) !== '' ? JSON.parse(store.get(KEY)) : null)
const clearedOnDisk = () => { const d = saved(); return d === null || (!d.text && !d.workspaceId && !d.sparc) }

let calls, replies
beforeEach(() => {
  api.set({ todoDraft: emptyTodoDraft(), busy: {}, errors: {} })
  store.clear()
  calls = []
  replies = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body === undefined ? undefined : JSON.parse(init.body), draftOnDisk: saved() })
    const r = replies.shift() ?? { status: 200, body: { ok: true } }
    if (r.throws) throw new TypeError('Failed to fetch')
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.body }
  }
})

test('every edit of the draft is in localStorage at once, not after a delay', () => {
  api.set({ todoDraft: { text: 'a', workspaceId: '', sparc: false } })
  assert.equal(saved()?.text, 'a')
  api.set({ todoDraft: { text: 'ab', workspaceId: 'aaaa/w1', sparc: true } })
  assert.deepEqual(saved(), { text: 'ab', workspaceId: 'aaaa/w1', sparc: true })
})

test('a long prompt (4000 characters) is saved whole', () => {
  const text = 'x'.repeat(3999) + '\n'
  api.set({ todoDraft: { text, workspaceId: '', sparc: false } })
  assert.equal(saved()?.text, text)
})

test('the draft is restored when the page starts', async () => {
  store.set(KEY, JSON.stringify({ text: 'Saved before the crash', workspaceId: 'aaaa/w1', sparc: true }))
  const fresh = await import('../lib/mobile/api.js?restored')
  assert.deepEqual({ ...fresh.state.todoDraft }, { text: 'Saved before the crash', workspaceId: 'aaaa/w1', sparc: true })
})

test('a corrupt saved draft starts the page with an empty draft', async () => {
  store.set(KEY, '{broken')
  const fresh = await import('../lib/mobile/api.js?corrupt')
  assert.deepEqual({ ...fresh.state.todoDraft }, emptyTodoDraft())
})

test('startTodo keeps the draft while the request is on its way and after a refusal', async () => {
  api.set({ todoDraft: draft({ text: 'Twenty minutes of work' }) })
  replies.push({ status: 400, body: { error: 'unknown-workspace' } })
  const r = await api.startTodo({ text: 'Twenty minutes of work', sparc: true })
  assert.equal(r.ok, false)
  assert.equal(calls[0].draftOnDisk?.text, 'Twenty minutes of work', 'saved at the time of the request')
  assert.equal(api.state.todoDraft.text, 'Twenty minutes of work')
  assert.equal(saved()?.text, 'Twenty minutes of work')
})

test('startTodo keeps the draft after a network failure and after a server error', async () => {
  api.set({ todoDraft: draft({ text: 'Do not lose me' }) })
  replies.push({ throws: true })
  assert.equal((await api.startTodo({ text: 'Do not lose me' })).ok, false)
  assert.equal(saved()?.text, 'Do not lose me')
  replies.push({ status: 500, body: {} })
  assert.equal((await api.startTodo({ text: 'Do not lose me' })).ok, false)
  assert.equal(api.state.todoDraft.text, 'Do not lose me')
  assert.equal(saved()?.text, 'Do not lose me')
})

test('only a successful start clears the draft, in state and on disk', async () => {
  api.set({ todoDraft: draft({ text: 'Start this' }) })
  replies.push({ status: 200, body: { ok: true, id: 'n1' } })
  assert.deepEqual(await api.startTodo({ text: 'Start this' }), { ok: true })
  assert.deepEqual({ ...api.state.todoDraft }, emptyTodoDraft())
  assert.ok(clearedOnDisk(), String(store.get(KEY)))
})

// ---- wiring (the Preact views cannot run here: source checks, as mobile-todo-wiring does) ---------------------------------------------

const apiSrc = readFileSync(join(ROOT, 'lib', 'mobile', 'api.js'), 'utf8')
const views = readFileSync(join(ROOT, 'lib', 'mobile', 'views.js'), 'utf8')

test('source: api.js saves the draft in set() and flushes it on pagehide / hidden through bindDraftFlush', () => {
  assert.match(apiSrc, /import\s*\{[^}]*\bsaveTodoDraft\b[^}]*\}\s*from\s*['"]\.\/todo-form\.js['"]/)
  assert.match(apiSrc, /import\s*\{[^}]*\bloadTodoDraft\b[^}]*\}\s*from\s*['"]\.\/todo-form\.js['"]/)
  const setFn = apiSrc.slice(apiSrc.indexOf('export function set('), apiSrc.indexOf('function save()'))
  assert.match(setFn, /'todoDraft' in patch/)
  assert.match(setFn, /saveTodoDraft\(storage, state\.todoDraft\)/)
  assert.doesNotMatch(setFn.split('\n').filter((l) => /todoDraft/.test(l)).join('\n'), /setTimeout/, 'not debounced')
  assert.match(apiSrc, /bindDraftFlush\(/)
})

test('source: the draft is restored at module start and the only reset is the one after a successful start', () => {
  assert.match(apiSrc, /todoDraft:\s*loadTodoDraft\(storage\)/)
  const start = apiSrc.slice(apiSrc.indexOf('export async function startTodo'), apiSrc.indexOf('export async function init'))
  assert.ok(start.indexOf('if (failure) return') < start.indexOf('clearTodoDraft()'), 'cleared after the failure return only')
  // set({ todoDraft }) already saves it (one write): clearTodoDraft needs no second forgetTodoDraft
  assert.doesNotMatch(apiSrc.slice(apiSrc.indexOf('export const clearTodoDraft'), apiSrc.indexOf('export const NEW_TODO_ID')), /forgetTodoDraft\(/)
  assert.equal([...apiSrc.matchAll(/clearTodoDraft\(\)/g)].length, 1, 'one caller')
})

test('source: leaving the new-todo screen (Back, another tab) never touches the draft', () => {
  assert.doesNotMatch(views, /clearTodoDraft|emptyTodoDraft|forgetTodoDraft/)
  assert.equal([...views.matchAll(/todoDraft:/g)].length, 1, 'views only edit the draft (edit() in NewTodoView)')
})
