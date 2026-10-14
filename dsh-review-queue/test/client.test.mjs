import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

function loadClient() {
  let registered
  const store = {}
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v } } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: async () => { throw new Error('offline') } }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  const stubReact = { createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  const mod = registered.factory((name) => { assert.equal(name, 'react'); return stubReact })
  return { registered, mod, store }
}

const { registered, mod } = loadClient()
const T = Object.fromEntries(Object.entries(mod.__test).map(([k, v]) => [k, typeof v === 'function' ? (...a) => { const r = v(...a); return r === undefined ? r : structuredClone(r) } : v]))

test('the bundle registers under the plugin id and exports the DSH client contract', () => {
  assert.equal(registered.id, 'dsh-review-queue')
  assert.deepEqual(Array.from(mod.inject), ['slots', 'uiWorkspace'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.HeaderAnchor, 'function')
  assert.equal(mod.ReviewTab, undefined, 'the queue is overlay only: no sidebar tab')
})

test('fmtAge and fmtLeft read naturally', () => {
  assert.equal(T.fmtAge(10_000), 'just now')
  assert.equal(T.fmtAge(5 * 60_000), '5 min ago')
  assert.equal(T.fmtAge(3 * 3600_000), '3 h ago')
  assert.equal(T.fmtAge(3 * 86400_000), '3 d ago')
  assert.equal(T.fmtLeft(90_000), '1:30')
  assert.equal(T.fmtLeft(5_000), '0:05')
  assert.equal(T.fmtLeft(0), 'expired')
  assert.equal(T.fmtLeft(-5), 'expired')
})

test('toggleChoice replaces in single-select and flips in multi-select', () => {
  assert.deepEqual(T.toggleChoice({ selected: ['A'], custom: '' }, 'B', false).selected, ['B'])
  assert.deepEqual(T.toggleChoice({ selected: ['B'], custom: '' }, 'B', false).selected, [])
  assert.deepEqual(T.toggleChoice({ selected: ['A'], custom: '' }, 'B', true).selected, ['A', 'B'])
  assert.deepEqual(T.toggleChoice({ selected: ['A', 'B'], custom: '' }, 'A', true).selected, ['B'])
  assert.deepEqual(T.toggleChoice(undefined, 'A', false), { selected: ['A'], custom: '' })
})

test('buildAnswers needs an answer for every question and keeps custom text', () => {
  const qs = [{ id: 'a' }, { id: 'b' }]
  assert.equal(T.buildAnswers(qs, { a: { selected: ['X'] } }), undefined)
  assert.deepEqual(T.buildAnswers(qs, { a: { selected: ['X'] }, b: { selected: [], custom: ' hi ' } }), [{ id: 'a', selected: ['X'] }, { id: 'b', selected: [], custom: 'hi' }])
  assert.equal(T.buildAnswers([], {}), undefined)
})

test('resolutionText says what happened to each kind of item', () => {
  assert.equal(T.resolutionText({ resolution: { kind: 'answered', by: 'card', answers: [{ id: 'q', selected: ['B'] }] } }), 'Answered here: B')
  assert.equal(T.resolutionText({ resolution: { kind: 'expired', assumed: ['A (Recommended)'] } }), 'Expired; recommended option taken: A (Recommended)')
  assert.equal(T.resolutionText({ resolution: { kind: 'expired', assumed: [] } }), 'Expired; the assistant carried on')
  assert.equal(T.resolutionText({ resolution: { kind: 'denied', by: 'screen' } }), 'Denied on screen')
  assert.equal(T.resolutionText({ resolution: { kind: 'replied', by: 'session' } }), 'You continued the session')
  assert.equal(T.resolutionText({ resolution: { kind: 'cancelled', by: 'restart' } }), 'Cancelled when the server restarted')
  assert.equal(T.resolutionText({ resolution: { kind: 'reviewed' } }), 'Reviewed')
})

test('the button reset cannot out-rank the component classes, so their padding applies', () => {
  const css = T.CSS
  assert.ok(css.includes(':where(.rq) button{'), 'reset must use :where() (specificity 0)')
  assert.ok(!/\.rq button\{[^}]*padding:0/.test(css), '".rq button{padding:0}" beats .rq-btn/.rq-opt/.rq-link/.rq-row-i padding')
  for (const cls of ['.rq-btn', '.rq-opt', '.rq-link', '.rq-row-i']) assert.match(css, new RegExp('\\' + cls + '\\{[^}]*padding:\\d'), cls + ' sets padding')
})

test('apply puts one button in the session header utilities and nothing in the right sidebar', async () => {
  const injected = []
  const cleanups = []
  const ctx = {
    effect: (fn) => { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    slots: { inject: (name, make) => { injected.push(name); const reg = make(); return reg }, register: (opts, comp) => ({ opts, comp }) },
    // A sidebar-right surface must not be touched; any use throws.
    get sidebarRightTabs() { throw new Error('sidebarRightTabs used') },
    get sidebarRight() { throw new Error('sidebarRight used') },
  }
  const seen = []
  ctx.slots.register = (opts, comp) => { seen.push(opts); return { opts, comp } }
  try { mod.apply(ctx) } finally { cleanups.forEach((f) => f()) }
  assert.deepEqual(injected, ['conversation.session.header.utilities'])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].name, 'conversation.session.header.utilities')
  assert.equal(seen[0].id, 'review-queue')
  assert.ok(seen[0].order >= 1000, 'last among the utilities, so it sits next to the right-sidebar button')
  assert.ok(!injected.some((n) => n.startsWith('sidebar.right')))
})

test('resolutionText names late answers and confirmations', () => {
  assert.match(T.resolutionText({ resolution: { kind: 'late-answered', by: 'card', answers: [{ id: 'q', selected: ['B'] }] } }), /^Answered late: B/)
  assert.match(T.resolutionText({ resolution: { kind: 'confirmed', by: 'card', answers: [{ id: 'q', selected: ['A'] }] } }), /^Confirmed the recommended option: A/)
})

test('isSendKey: Enter sends, Shift+Enter and IME composition do not', () => {
  assert.equal(T.isSendKey({ key: 'Enter', shiftKey: false, isComposing: false }), true)
  assert.equal(T.isSendKey({ key: 'Enter', shiftKey: true }), false)
  assert.equal(T.isSendKey({ key: 'Enter', isComposing: true }), false)
  assert.equal(T.isSendKey({ key: 'a' }), false)
})

test('cardTitle prefers the task title and falls back to the session title', () => {
  assert.equal(T.cardTitle({ title: 'Move auth', sessionTitle: 'Session' }), 'Move auth')
  assert.equal(T.cardTitle({ sessionTitle: 'Session' }), 'Session')
  assert.equal(T.cardTitle({}), 'Untitled')
})

test('the done card makes Send reply the primary button and Reviewed a plain one', () => {
  const src = readFileSync(file, 'utf8')
  const body = src.slice(src.indexOf('function CompletedBody'), src.indexOf('function Card('))
  assert.match(body, /className: "rq-btn pri"[^\n]*"Send reply"/)
  assert.match(body, /className: "rq-btn"[^\n]*"Reviewed"/)
  assert.doesNotMatch(body, /rq-btn pri[^\n]*"Reviewed"/)
})

const ids = (xs) => xs.map((x) => x.id)

test('nextAfter picks the following item, else the previous one, else nothing', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.equal(T.nextAfter(items, 'a'), 'b')
  assert.equal(T.nextAfter(items, 'b'), 'c')
  assert.equal(T.nextAfter(items, 'c'), 'b')
  assert.equal(T.nextAfter([{ id: 'a' }], 'a'), undefined)
  assert.equal(T.nextAfter(items, 'zzz'), undefined)
  assert.equal(T.nextAfter([], 'a'), undefined)
})

test('keyAction maps keys, ignoring typing in fields, modifiers and IME composition', () => {
  const k = (key, extra = {}) => T.keyAction({ key, ...extra })
  assert.equal(k('j'), 'next'); assert.equal(k('ArrowDown'), 'next')
  assert.equal(k('k'), 'prev'); assert.equal(k('ArrowUp'), 'prev')
  assert.equal(k('r'), 'read'); assert.equal(k('e'), 'reviewed')
  assert.equal(k('A', { shiftKey: true }), 'approve'); assert.equal(k('D', { shiftKey: true }), 'deny')
  assert.equal(k('a'), undefined, 'approving needs Shift so it cannot happen by accident')
  assert.equal(k('d'), undefined)
  assert.equal(k('j', { ctrlKey: true }), undefined); assert.equal(k('j', { metaKey: true }), undefined); assert.equal(k('j', { altKey: true }), undefined)
  assert.equal(k('j', { isComposing: true }), undefined)
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(k('j', { target: { tagName: tag } }), undefined)
  assert.equal(k('j', { target: { tagName: 'DIV', isContentEditable: true } }), undefined)
  assert.equal(k('j', { target: { tagName: 'BUTTON' } }), 'next')
})

test('filterItems filters by type and by text over title, session, workspace and summary', () => {
  const items = [
    { id: '1', type: 'completed', title: 'Fix login', sessionTitle: 'Auth work', workspace: 'D:/proj/a', summary: 'Moved code' },
    { id: '2', type: 'question', title: 'Port', sessionTitle: 'Server', workspace: 'D:/proj/b', payload: { questions: [{ question: 'Which port?' }] } },
    { id: '3', type: 'permission', title: 'shell: ls', sessionTitle: 'Auth work', workspace: 'D:/proj/a', payload: { summary: 'shell: ls' } },
  ]
  assert.deepEqual(ids(T.filterItems(items, { type: 'all', query: '' })), ['1', '2', '3'])
  assert.deepEqual(ids(T.filterItems(items, { type: 'question', query: '' })), ['2'])
  assert.deepEqual(ids(T.filterItems(items, { type: 'all', query: 'auth' })), ['1', '3'])
  assert.deepEqual(ids(T.filterItems(items, { type: 'all', query: 'proj/b' })), ['2'])
  assert.deepEqual(ids(T.filterItems(items, { type: 'all', query: 'which PORT' })), ['2'])
  assert.deepEqual(ids(T.filterItems(items, { type: 'completed', query: 'ls' })), [])
  assert.deepEqual(ids(T.filterItems(items, undefined)), ['1', '2', '3'])
})

test('similarCount counts identical open permission requests of the same session, none when risky', () => {
  const p = (id, over = {}) => ({ id, type: 'permission', sessionId: 's1', payload: { toolName: 'shell', detail: 'npm test' }, risks: [], ...over })
  const open = [p('a'), p('b'), p('c', { sessionId: 's2' }), p('d', { payload: { toolName: 'shell', detail: 'npm run x' } }), { id: 'e', type: 'completed', sessionId: 's1' }]
  assert.equal(T.similarCount(open, open[0]), 2)
  assert.equal(T.similarCount(open, open[2]), 1)
  assert.equal(T.similarCount(open, p('r', { risks: [{ code: 'x' }] })), 0)
  assert.equal(T.similarCount(open, open[4]), 0)
})

test('pruneSaved keeps only drafts of items still in the queue', () => {
  const saved = { drafts: { a: { q: { selected: ['x'] } }, gone: { q: {} } }, replies: { b: 'hi', gone: 'old', c: '' } }
  const snap = { open: [{ id: 'a' }], resolved: [{ id: 'b' }] }
  assert.deepEqual(T.pruneSaved(saved, snap), { drafts: { a: { q: { selected: ['x'] } } }, replies: { b: 'hi' } })
  assert.deepEqual(T.pruneSaved(undefined, snap), { drafts: {}, replies: {} })
  assert.deepEqual(T.pruneSaved({ drafts: 5, replies: null }, snap), { drafts: {}, replies: {} })
})

test('resolutionText knows superseded', () => {
  assert.equal(T.resolutionText({ resolution: { kind: 'superseded' } }), 'Replaced by a newer result')
})

test('mdInline splits inline markdown and only links http(s) URLs', () => {
  assert.deepEqual(T.mdInline('a **b** `c` [d](https://x.y) *e*'), [
    { t: 'text', text: 'a ' }, { t: 'b', text: 'b' }, { t: 'text', text: ' ' }, { t: 'code', text: 'c' }, { t: 'text', text: ' ' },
    { t: 'a', text: 'd', href: 'https://x.y' }, { t: 'text', text: ' ' }, { t: 'i', text: 'e' },
  ])
  assert.deepEqual(T.mdInline('[bad](javascript:void) x'), [{ t: 'text', text: 'bad x' }])
  assert.deepEqual(T.mdInline('plain'), [{ t: 'text', text: 'plain' }])
  assert.deepEqual(T.mdInline('2 * 3 * 4'), [{ t: 'text', text: '2 * 3 * 4' }])
})

test('mdBlocks finds headings, paragraphs, lists, quotes and fenced code', () => {
  const md = '# Title\n\nFirst line\nsecond line\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n```js\nconst a = 1\n\nb()\n```\n\nend'
  assert.deepEqual(T.mdBlocks(md), [
    { t: 'h', level: 1, text: 'Title' },
    { t: 'p', text: 'First line\nsecond line' },
    { t: 'ul', items: ['one', 'two'] },
    { t: 'ol', items: ['a', 'b'] },
    { t: 'q', text: 'quoted' },
    { t: 'code', text: 'const a = 1\n\nb()', lang: 'js' },
    { t: 'p', text: 'end' },
  ])
  assert.deepEqual(T.mdBlocks(''), [])
  assert.deepEqual(T.mdBlocks('```\nunclosed'), [{ t: 'code', text: 'unclosed', lang: '' }])
})
