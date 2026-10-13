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
