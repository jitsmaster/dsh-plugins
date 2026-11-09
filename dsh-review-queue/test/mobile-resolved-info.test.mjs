// Phone: a resolved item shows the same information as a waiting one. List rows get the session and workspace line; the item screen gets the
// raised time and the original message, read only (views.ResolvedItemBody, hook-free, built on the shared core.resolvedBody).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const noop = () => {}
globalThis.location = { pathname: '/m/', hash: '', origin: 'http://x', href: 'http://x/m/' }
globalThis.window = globalThis
globalThis.document = { addEventListener: noop, removeEventListener: noop, hidden: false, createElement: () => ({}), head: { append: noop } }
globalThis.addEventListener = noop
globalThis.removeEventListener = noop
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })

function loadOverlay() {
  let registered
  const file = join(root, 'lib', 'client.js')
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const core = loadOverlay().shared
const api = await import('../lib/mobile/api.js')
api.setCoreForTests(core)
const views = await import('../lib/mobile/views.js')
const viewsSource = readFileSync(join(root, 'lib', 'mobile', 'views.js'), 'utf8')

const HOOKED = new Set(['ArchiveSessionButton', 'Mic', 'HoldSheet', 'MarkWrongSheet'])
function expand(n) {
  if (Array.isArray(n)) return n.map(expand)
  if (!n || typeof n !== 'object') return n
  if (typeof n.type === 'function' && HOOKED.has(n.type.name)) return { type: n.type.name, props: n.props, children: [] }
  if (typeof n.type === 'function') return expand(n.type(n.props))
  const kids = n.props && n.props.children
  return { type: n.type, props: n.props, children: [].concat(kids === undefined ? [] : kids).flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map(expand) }
}
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); n.children.forEach((c) => walk(c, out)) } return out }
const textOf = (n) => (Array.isArray(n) ? n.map(textOf).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : n && typeof n === 'object' ? n.children.map(textOf).join('') : '')
const draw = (name, props) => { assert.equal(typeof views[name], 'function', name + ' is exported'); return expand(views[name](props)) }
const find = (tree, pred) => walk(tree).filter(pred)

const H = 3600e3
const base = (over = {}) => ({ id: 'x1', sessionId: 's1', sessionTitle: 'Fix login', workspace: 'dsh-plugins', status: 'resolved', createdAt: Date.now() - 3 * H, resolvedAt: Date.now() - H, ...over })
const question = (over = {}) => base({
  type: 'question', title: 'Which db?',
  payload: { questions: [{ id: 'q1', question: 'Which database should we use?', options: [{ label: 'Postgres (Recommended)' }, { label: 'SQLite' }] }] },
  resolution: { kind: 'answered', by: 'card', answers: [{ id: 'q1', selected: ['SQLite'] }] }, ...over })
const permission = () => base({ type: 'permission', title: 'Run rm', risks: [{ code: 'delete', label: 'Deletes files' }], payload: { toolName: 'Bash', summary: 'rm -rf build', detail: 'rm -rf build && echo done', reason: 'Clean up' }, resolution: { kind: 'approved', by: 'card' } })
const completed = () => base({ type: 'completed', title: 'Done', summary: 'Fixed the **login** bug.', payload: { reply: 'Long reply <img src=x onerror=1>' }, resolution: { kind: 'reviewed', by: 'card' } })

test('a Resolved list row shows the session and workspace line under the title', () => {
  api.set({ busy: {}, errors: {}, sheet: null, filter: { type: 'all', query: '', resolvedBy: 'all' }, snap: { snapshotId: 'e:1', open: [], resolved: [question()] } })
  const tree = draw('ResolvedBody', { st: api.state })
  const row = find(tree, (n) => n.props && String(n.props.class || '').split(/\s+/).includes('resolved-row'))[0]
  assert.ok(row, 'a row')
  assert.match(textOf(row), /Fix login · dsh-plugins/)
})

test('a row of an item with no session shows no empty session line and never undefined', () => {
  api.set({ snap: { snapshotId: 'e:1', open: [], resolved: [question({ sessionTitle: undefined, workspace: undefined })] } })
  assert.doesNotMatch(textOf(draw('ResolvedBody', { st: api.state })), /undefined/)
})

test('ResolvedItemBody question: every option, the chosen one marked, no input and no button', () => {
  const tree = draw('ResolvedItemBody', { item: question() })
  const text = textOf(tree)
  assert.match(text, /Which database should we use\?/)
  assert.match(text, /Postgres/)
  const chosen = find(tree, (n) => n.props && n.props['data-chosen'] === 'true')
  assert.equal(chosen.length, 1)
  assert.match(textOf(chosen[0]), /SQLite/)
  assert.equal(find(tree, (n) => n.type === 'input' || n.type === 'textarea' || n.type === 'button').length, 0)
})

test('ResolvedItemBody permission: the command, the risks and the reason, no Approve / Deny', () => {
  const tree = draw('ResolvedItemBody', { item: permission() })
  const text = textOf(tree)
  assert.match(text, /rm -rf build/)
  assert.match(text, /Deletes files/)
  assert.match(text, /Clean up/)
  assert.equal(find(tree, (n) => n.type === 'button').length, 0)
})

test('ResolvedItemBody completed: the summary and a Full reply fold, the reply stays text (no markup)', () => {
  const tree = draw('ResolvedItemBody', { item: completed() })
  assert.match(textOf(tree), /Fixed the login bug\./)
  const d = find(tree, (n) => n.type === 'details')
  assert.equal(d.length, 1)
  assert.match(textOf(d[0]), /Full reply/)
  assert.equal(find(tree, (n) => n.type === 'img' || n.type === 'script').length, 0)
  assert.match(textOf(d[0]), /<img src=x onerror=1>/)
})

test('ResolvedItemBody: unknown type renders nothing', () => {
  assert.equal(views.ResolvedItemBody({ item: base({ type: 'mystery' }) }), null)
})

test('source: ItemView shows the raised time and the read-only body for a resolved item, and the old open-only Body is untouched', () => {
  const a = viewsSource.indexOf('function ItemView'), b = viewsSource.indexOf('const INSTALL_HINT_KEY')
  assert.ok(a >= 0 && b > a)
  const src = viewsSource.slice(a, b)
  assert.match(src, /ResolvedItemBody/)
  assert.match(src, /raisedText\(/)
  assert.match(src, /open \? html`<\$\{Body\} item=\$\{item\} \/>`/, 'a waiting item still gets its interactive Body')
})
