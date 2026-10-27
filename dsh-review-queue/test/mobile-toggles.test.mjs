import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The phone remembers the open/closed choice of its <details> sections (Conversation, Full reply, Answer now (late)) per item and section.
// Pure helpers in lib/mobile/toggles.js take a storage { get(key), set(key, value) } like todo-form.js:
//   TOGGLES_KEY = 'rq-m.toggles'; saved shape { details: { "<itemId>|<kind>": boolean } }; kinds 'conversation' | 'reply' | 'late'
//   loadToggles(storage) / saveToggles(storage, toggles) / pruneToggles(toggles, snap) / detailOpen(toggles, itemId, kind, fallback) / setDetail(toggles, itemId, kind, open)
// api.js: state.toggles (restored at start), saved at once by set({ toggles }), pruned against each snapshot; rememberDetail records a change only when it differs from what is shown.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KEY = 'rq-m.toggles'
const load = () => import('../lib/mobile/toggles.js')
const fakeStorage = (initial = {}) => { const map = new Map(Object.entries(initial)); return { map, get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => { map.set(k, String(v)) } } }

test('the key is rq-m.toggles, next to the other phone keys', async () => {
  const { TOGGLES_KEY } = await load()
  assert.equal(TOGGLES_KEY, KEY)
})

test('detailOpen: the last choice wins, else the fallback; each item and each section on its own', async () => {
  const { detailOpen, setDetail } = await load()
  let t = { details: {} }
  assert.equal(detailOpen(t, 'a', 'conversation', true), true)
  assert.equal(detailOpen(t, 'a', 'conversation', false), false)
  t = setDetail(t, 'a', 'conversation', false)
  assert.equal(detailOpen(t, 'a', 'conversation', true), false, 'a closed choice beats an open default')
  t = setDetail(t, 'a', 'reply', true)
  assert.equal(detailOpen(t, 'a', 'reply', false), true, 'an open choice beats a closed default')
  assert.equal(detailOpen(t, 'a', 'late', true), true, 'another section of the same item keeps its default')
  assert.equal(detailOpen(t, 'b', 'conversation', true), true, 'another item keeps its default')
  assert.equal(detailOpen(undefined, 'a', 'late', false), false)
  assert.equal(detailOpen({ details: 5 }, 'a', 'late', true), true)
})

test('setDetail returns a new toggles object and leaves the old one alone; an unknown kind is ignored', async () => {
  const { setDetail } = await load()
  const t = { details: { 'a|reply': true } }
  const next = setDetail(t, 'a', 'conversation', false)
  assert.notEqual(next, t)
  assert.deepEqual(t, { details: { 'a|reply': true } })
  assert.deepEqual(next, { details: { 'a|reply': true, 'a|conversation': false } })
  assert.equal(setDetail(t, 'a', 'nope', true), t)
})

test('saveToggles writes the JSON at once and loadToggles reads it back', async () => {
  const { saveToggles, loadToggles } = await load()
  const s = fakeStorage()
  saveToggles(s, { details: { 'a|conversation': false, 'b|late': true } })
  assert.deepEqual(JSON.parse(s.map.get(KEY)), { details: { 'a|conversation': false, 'b|late': true } })
  assert.deepEqual(loadToggles(s), { details: { 'a|conversation': false, 'b|late': true } })
})

test('loadToggles: nothing, corrupt, non-object or wrong-type data gives empty toggles, every call a new object', async () => {
  const { loadToggles } = await load()
  for (const raw of [undefined, null, '', '{not json', 'null', '5', '"x"', '[1,2]', 'true', '{}', '{"details":5}', '{"details":[true]}', '{"details":null}']) {
    const s = fakeStorage(raw === undefined ? {} : { [KEY]: raw })
    assert.deepEqual(loadToggles(s), { details: {} }, String(raw))
  }
  const s = fakeStorage()
  assert.notEqual(loadToggles(s), loadToggles(s))
})

test('loadToggles keeps only boolean choices of known sections', async () => {
  const { loadToggles } = await load()
  const raw = JSON.stringify({ details: { 'a|reply': true, 'a|late': 'yes', 'b|conversation': 1, 'c|conversation': false, 'd|bogus': true, nobar: true } })
  assert.deepEqual(loadToggles(fakeStorage({ [KEY]: raw })), { details: { 'a|reply': true, 'c|conversation': false } })
})

test('saveToggles and loadToggles never throw, even when the storage does', async () => {
  const { saveToggles, loadToggles } = await load()
  const bad = { get: () => { throw new Error('denied') }, set: () => { throw new Error('quota') } }
  assert.doesNotThrow(() => saveToggles(bad, { details: { 'a|reply': true } }))
  assert.deepEqual(loadToggles(bad), { details: {} })
})

test('pruneToggles keeps the choices of items still in the queue (open or resolved) and drops the rest', async () => {
  const { pruneToggles } = await load()
  const snap = { open: [{ id: 'a' }], resolved: [{ id: 'b' }] }
  const t = { details: { 'a|conversation': true, 'b|reply': false, 'gone|late': true, 'a|late': false } }
  assert.deepEqual(pruneToggles(t, snap), { details: { 'a|conversation': true, 'b|reply': false, 'a|late': false } })
  assert.deepEqual(pruneToggles(t, undefined), { details: {} })
  assert.deepEqual(pruneToggles(undefined, snap), { details: {} })
})

test('pruneToggles answers the same object when nothing is dropped (no needless state change)', async () => {
  const { pruneToggles } = await load()
  const t = { details: { 'a|conversation': true } }
  assert.equal(pruneToggles(t, { open: [{ id: 'a' }], resolved: [] }), t)
})

// ---- api.js: the real state object with fake globals ------------------------------------------------------------------------------------

globalThis.location = { pathname: '/review-queue/m/' }
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
const api = await import('../lib/mobile/api.js')
const saved = () => (store.has(KEY) ? JSON.parse(store.get(KEY)) : null)

beforeEach(() => { api.set({ toggles: { details: {} } }); store.clear() })

test('a change of the toggles is in localStorage at once, not after a delay', () => {
  api.set({ toggles: { details: { 'a|conversation': false } } })
  assert.deepEqual(saved(), { details: { 'a|conversation': false } })
})

test('the toggles are restored when the page starts; corrupt data starts empty', async () => {
  store.set(KEY, JSON.stringify({ details: { 'a|reply': false } }))
  const fresh = await import('../lib/mobile/api.js?toggles-restored')
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.state.toggles)), { details: { 'a|reply': false } })
  store.set(KEY, '{broken')
  const corrupt = await import('../lib/mobile/api.js?toggles-corrupt')
  assert.deepEqual(JSON.parse(JSON.stringify(corrupt.state.toggles)), { details: {} })
})

test('rememberDetail records a choice and saves it', () => {
  api.rememberDetail('a', 'conversation', false, true)
  assert.equal(api.state.toggles.details['a|conversation'], false)
  assert.deepEqual(saved(), { details: { 'a|conversation': false } })
})

test('rememberDetail records nothing when the new state is what is shown already (the echo of a controlled <details>)', () => {
  const version = api.state.version
  api.rememberDetail('a', 'reply', true, true) // the default is open: no choice yet, nothing to remember
  assert.equal(api.state.version, version, 'no state change, so no render')
  assert.equal(saved(), null, 'nothing written')
  api.rememberDetail('a', 'reply', false, true)
  const after = api.state.version
  api.rememberDetail('a', 'reply', false, true) // the same choice again
  assert.equal(api.state.version, after)
})

test('rememberDetail: a choice back to the default is still recorded when it differs from the earlier choice', () => {
  api.rememberDetail('a', 'late', true, false)
  api.rememberDetail('a', 'late', false, false)
  assert.equal(api.state.toggles.details['a|late'], false, 'the user closed it again: that is the last choice')
})

// ---- wiring (the Preact views cannot run here: source checks, as mobile-todo-draft does) -------------------------------------------------

const apiSrc = readFileSync(join(ROOT, 'lib', 'mobile', 'api.js'), 'utf8')
const views = readFileSync(join(ROOT, 'lib', 'mobile', 'views.js'), 'utf8')

test('source: api.js restores the toggles at module start, saves them in set() and prunes them against every snapshot', () => {
  assert.match(apiSrc, /toggles:\s*loadToggles\(storage\)/)
  const setFn = apiSrc.slice(apiSrc.indexOf('export function set('), apiSrc.indexOf('function save()'))
  assert.match(setFn, /'toggles' in patch/)
  assert.match(setFn, /saveToggles\(storage, state\.toggles\)/)
  const pollFn = apiSrc.slice(apiSrc.indexOf('async function pollLoop'), apiSrc.indexOf('export async function act'))
  assert.match(pollFn, /pruneToggles\(state\.toggles, body\)/)
})

test('source: the three sections of views.js read and record their state through the toggles', () => {
  for (const kind of ['conversation', 'reply', 'late']) assert.match(views, new RegExp("detailOpen\\(st\\.toggles, [^)]*'" + kind + "'"), kind + ' is read')
  assert.equal([...views.matchAll(/rememberDetail\(/g)].length, 3, 'each section records its change')
  assert.match(views, /<details open=\$\{detailOpen\(st\.toggles, item\.id, 'reply', replyDefault\)\}/, 'Full reply is controlled by the remembered state')
})

test('source: each section passes the same named default to detailOpen and to rememberDetail (the echo check needs both to agree)', () => {
  for (const [kind, name] of [['conversation', 'firstDefault'], ['reply', 'replyDefault'], ['late', 'lateDefault']]) {
    assert.match(views, new RegExp("detailOpen\\(st\\.toggles, item\\.id, '" + kind + "', " + name + "\\)"), kind + ' reads its default')
    assert.match(views, new RegExp("rememberDetail\\(item\\.id, '" + kind + "', e\\.currentTarget\\.open, " + name + "\\)"), kind + ' records against the same default')
  }
})

test('source: the Conversation default is frozen at its first mount, so an item that turns open -> resolved (or back) does not open or close the section by itself', () => {
  const c = views.slice(views.indexOf('function Conversation('), views.indexOf('function ArchiveSessionButton'))
  assert.match(c, /const \[firstDefault\] = useState\(defaultOpen\)/, 'the default seen at the first mount is kept')
  assert.match(views, /<\$\{Conversation\} key=\$\{item\.id\}/, 'the component is keyed by the item, so another item gets its own first default')
})
