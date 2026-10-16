import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The overlay's side of the devices page: a Phone button in the header, the panel opened in a dialog over the list, and the lazy load of
// lib/phone-panel.js (lib/client.js must stay one self-contained script, so the panel is a separate file the overlay imports on first use).
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
const phoneDialog = (tree) => { const el = find(tree, (n) => typeof n.type === 'function' && n.type.name === 'PhoneDialog'); return el && el.type(el.props) }
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''))

test('the overlay header has a Phone button that opens and closes the phone panel', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  const head = find(T.Panel(), (n) => typeof n.type === 'function' && n.type.name === 'Head')
  const button = find(head.type(head.props), (n) => n.type === 'button' && text(n) === 'Phone')
  assert.ok(button, 'a Phone button')
  assert.equal(T.state.showPhone, false)
  button.props.onClick()
  assert.equal(T.state.showPhone, true)
  button.props.onClick()
  assert.equal(T.state.showPhone, false)
})

test('with the phone panel open it is a closable dialog over the list; the list stays', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  assert.equal(find(T.Panel(), (n) => n.type === T.PhoneHost), undefined)
  T.state.showPhone = true
  const tree = T.Panel()
  const dialog = phoneDialog(tree)
  assert.ok(dialog, 'a phone dialog')
  assert.ok(find(dialog, (n) => n.type === T.PhoneHost), 'the panel is inside the dialog')
  assert.ok(find(tree, (n) => /rq-split/.test(n.props?.className ?? '')), 'the card list is still under the dialog')
  const close = find(dialog, (n) => n.type === 'button' && /Close/.test(text(n)))
  assert.ok(close, 'a Close button in the dialog')
  close.props.onClick()
  assert.equal(T.state.showPhone, false)
})

test('a click on the dialog backdrop closes it, a click inside does not', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  T.state.showPhone = true
  const dialog = phoneDialog(T.Panel())
  dialog.props.onMouseDown({ target: {}, currentTarget: {} })
  assert.equal(T.state.showPhone, true, 'target is not the backdrop')
  const backdrop = {}
  dialog.props.onMouseDown({ target: backdrop, currentTarget: backdrop })
  assert.equal(T.state.showPhone, false)
})

test('the header actions are real buttons with + New todo first', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  const head = find(T.Panel(), (n) => typeof n.type === 'function' && n.type.name === 'Head')
  const labels = []
  const walk = (n) => { if (n && typeof n === 'object') { if (n.type === 'button') labels.push([text(n), n.props.className]); (n.children ?? []).forEach(walk) } }
  walk(head.type(head.props))
  const names = labels.map(([l]) => l)
  assert.equal(names[0], '+ New todo')
  for (const want of ['Find paused', 'Phone']) assert.ok(names.includes(want), want)
  assert.ok(labels.every(([, c]) => /rq-btn/.test(c)), 'no plain text links in the header')
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
