import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The overlay's side of the devices page: a Phone tab in the Views tablist whose body is the phone panel (no dialog over the list), and the lazy
// load of lib/phone-panel.js (lib/client.js must stay one self-contained script, so the panel is a separate file the overlay imports on first use).
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')
const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })

function load() {
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: el, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  const mod = registered.factory(() => stubReact)
  return { mod, T: mod.__test, React: stubReact }
}
const find = (node, pred) => (node && typeof node === 'object' ? (pred(node) ? node : (node.children ?? []).map((c) => find(c, pred)).find(Boolean)) : undefined)
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''))

const tabs = (T) => { const bar = find(T.Panel(), (n) => typeof n.type === 'function' && n.type.name === 'ViewTabs'); return bar.type(bar.props) }
const tabOf = (T, view) => find(tabs(T), (n) => n.props?.role === 'tab' && n.props['data-tab'] === view)

test('the overlay has a Phone tab that selects and leaves the phone panel', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  assert.match(text(tabOf(T, 'phone')), /Phone/)
  assert.equal(tabOf(T, 'phone').props['aria-selected'], false)
  assert.equal(T.state.showPhone, false)
  tabOf(T, 'phone').props.onClick()
  assert.equal(T.state.showPhone, true)
  assert.equal(tabOf(T, 'phone').props['aria-selected'], true)
  tabOf(T, 'waiting').props.onClick()
  assert.equal(T.state.showPhone, false)
})

test('with the Phone tab selected the panel is the body of the overlay, not a dialog; the card list is not shown', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  assert.equal(find(T.Panel(), (n) => n.type === T.PhoneHost), undefined)
  T.state.showPhone = true
  const tree = T.Panel()
  assert.ok(find(tree, (n) => n.type === T.PhoneHost), 'the panel is in the page')
  assert.equal(find(tree, (n) => n.props?.role === 'dialog' && n.props['aria-label'] === 'Phone'), undefined, 'no phone dialog')
  assert.equal(find(tree, (n) => n.props?.['data-rq'] === 'phone-dialog'), undefined)
  assert.equal(find(tree, (n) => /rq-split/.test(n.props?.className ?? '')), undefined, 'the card list is replaced by the phone tab')
})

test('the header has + New todo and the close icon, nothing for the phone', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  const head = find(T.Panel(), (n) => typeof n.type === 'function' && n.type.name === 'Head')
  const labels = []
  const walk = (n) => { if (n && typeof n === 'object') { if (n.type === 'button') labels.push([text(n), n.props.className, n.props['aria-label']]); (n.children ?? []).forEach(walk) } }
  walk(head.type(head.props))
  assert.deepEqual(labels.map(([l]) => l), ['+ New todo', '✕'])
  assert.equal(labels[1][2], 'Close (Esc)')
  assert.ok(labels.every(([, c]) => /rq-btn|rq-iconx/.test(c)))
})

test('the panel module is imported from this app once, with React, the API prefix and the age formatter; a failed import can be retried', async () => {
  const { T, React } = load()
  const urls = []
  let fail = true
  T.setPhoneImporter(async (url) => {
    urls.push(url)
    if (fail) throw new Error('offline')
    return { createPhonePanel: (react, deps) => { urls.push([react === React, deps.API, typeof deps.fmtAge]); return () => 'PANEL' } }
  })
  await assert.rejects(T.loadPhonePanel(), /offline/)
  fail = false
  const Panel = await T.loadPhonePanel()
  assert.equal(Panel(), 'PANEL')
  assert.equal(await T.loadPhonePanel(), Panel, 'loaded once')
  assert.deepEqual(urls, ['/review-queue/m/phone-panel.js', '/review-queue/m/phone-panel.js', [true, '/review-queue', 'function']])
})
