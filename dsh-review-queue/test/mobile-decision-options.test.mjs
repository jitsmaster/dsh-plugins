// Slice 5: a done card on the phone shows the AI's decision options; tapping one fills the reply draft (the composer sends it).
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

function expand(n) {
  if (Array.isArray(n)) return n.map(expand)
  if (!n || typeof n !== 'object') return n
  if (typeof n.type === 'function') return expand(n.type(n.props))
  const kids = n.props && n.props.children
  return { type: n.type, props: n.props, children: [].concat(kids === undefined ? [] : kids).flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map(expand) }
}
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); n.children.forEach((c) => walk(c, out)) } return out }
const textOf = (n) => (Array.isArray(n) ? n.map(textOf).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : n && typeof n === 'object' ? n.children.map(textOf).join('') : '')

const item = { id: 'c1', type: 'completed', status: 'open', decision: { text: 'Ship it?', options: ['Yes', 'No'] } }

test('DecisionOptions lists the AI decision text and one button per option', () => {
  api.set({ replies: {} })
  const tree = expand(views.DecisionOptions({ item, st: api.state }))
  const buttons = walk(tree).filter((n) => n.type === 'button')
  assert.deepEqual(buttons.map(textOf).map((t) => t.replace(/[◉○\s]/g, '')), ['Yes', 'No'])
  assert.match(textOf(tree), /Ship it\?/)
})

test('tapping an option sets the reply draft and marks it pressed', () => {
  api.set({ replies: {} })
  const buttons = walk(expand(views.DecisionOptions({ item, st: api.state }))).filter((n) => n.type === 'button')
  buttons[1].props.onClick()
  assert.equal(api.state.replies.c1, 'No')
  const again = walk(expand(views.DecisionOptions({ item, st: api.state }))).filter((n) => n.type === 'button')
  assert.deepEqual(again.map((b) => b.props['aria-pressed']), [false, true])
})

test('no decision: nothing is drawn', () => {
  assert.equal(views.DecisionOptions({ item: { id: 'x', type: 'completed' }, st: api.state }), null)
})

test('non-string options are not drawn', () => {
  api.set({ replies: {} })
  const it2 = { id: 'c2', type: 'completed', status: 'open', decision: { text: 'Q', options: ['Yes', null, 5, { a: 1 }] } }
  const buttons = walk(expand(views.DecisionOptions({ item: it2, st: api.state }))).filter((n) => n.type === 'button')
  assert.equal(buttons.length, 1)
})
