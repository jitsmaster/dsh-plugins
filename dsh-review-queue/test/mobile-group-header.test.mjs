// Slice 5: the phone Waiting list draws a header row above each multi-item session group when the groups module is loaded (state.groupsUi).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import * as ui from '../lib/groups-ui.js'

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

const it = (id, groupId, createdAt) => ({ id, groupId, sessionId: groupId, type: 'completed', status: 'open', title: 't' + id, sessionTitle: 'Work ' + groupId, createdAt, payload: {}, tier: { severity: 'low', urgency: 'free', tier: 3, at: 1 } })
const draw = (groupsUi) => {
  api.set({ groupsUi, snap: { snapshotId: 'e:1', open: [it('a1', 's1', 1), it('b1', 's2', 2), it('a2', 's1', 3)], resolved: [] }, filter: { type: 'all', query: '', resolvedBy: 'all' } })
  return expand(views.WaitingBody({ st: api.state }))
}

test('with the groups module loaded, a multi-item session gets one header row with its title and count', () => {
  const heads = walk(draw(ui)).filter((n) => cls(n).includes('group-head'))
  assert.equal(heads.length, 1)
  assert.match(textOf(heads[0]), /Work s1/)
  assert.match(textOf(heads[0]), /2 items/)
})

test('without the module the list is flat: no header', () => {
  assert.equal(walk(draw(undefined)).filter((n) => cls(n).includes('group-head')).length, 0)
})
