// Slice 5: the phone marks items that arrive after the first snapshot as new until opened.
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
const api = await import('../lib/mobile/api.js')
api.setCoreForTests(loadOverlay().shared)
const views = await import('../lib/mobile/views.js')

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
const cls = (n) => String((n.props && (n.props.class || n.props.className)) || '').split(/\s+/)

const it = (id) => ({ id, type: 'completed', status: 'open', title: 't' + id, createdAt: 1, payload: {} })
const snap = (...ids) => ({ snapshotId: 'e:1', open: ids.map(it), resolved: [] })

test('the first snapshot marks nothing; a later new item is marked; an item that returns is not new again', () => {
  api.set({ fresh: {} })
  api.trackFresh(snap('a', 'b'))
  assert.deepEqual(api.state.fresh, {})
  api.trackFresh(snap('a', 'b', 'c'))
  assert.deepEqual(Object.keys(api.state.fresh), ['c'])
  api.trackFresh(snap('a', 'b'))
  api.trackFresh(snap('a', 'b', 'c'))
  assert.deepEqual(Object.keys(api.state.fresh), [], 'c left, so its mark went, and it is known now')
})

test('clearFresh removes the mark; a marked row has class new', () => {
  api.set({ fresh: { a: true }, snap: snap('a', 'b'), filter: { type: 'all', query: '', resolvedBy: 'all' }, groupsUi: undefined })
  const rows = () => walk(expand(views.WaitingBody({ st: api.state }))).filter((n) => n.type === 'a' && cls(n).includes('rowitem'))
  assert.deepEqual(rows().map((r) => cls(r).includes('new')), [true, false])
  api.clearFresh('a')
  assert.deepEqual(rows().map((r) => cls(r).includes('new')), [false, false])
})