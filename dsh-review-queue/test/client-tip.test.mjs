import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The desktop panel (lib/client.js): the tip card under "Nothing waiting on you." (only when the list is empty), its click, and the
// "N working / M open" count in the header.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')
const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
const TIP = { id: 't1', title: 'Bloom filters', body: 'A Bloom filter is a bit array. It never has false negatives.', category: 'algorithms', at: 1, source: 'model' }

function load({ fetchImpl, stored = {}, doc } = {}) {
  let registered
  const calls = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: (k) => stored[k] ?? null, setItem() {} } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, ...(doc ? { document: doc } : {}),
    fetch: fetchImpl ?? (async (url, init) => { calls.push([url, init && init.body ? JSON.parse(init.body) : undefined]); return { ok: true, status: 200, json: async () => ({ ok: true }) } }),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: el, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  const mod = registered.factory(() => stubReact)
  return { mod, T: mod.__test, calls }
}
const find = (node, pred) => (node && typeof node === 'object' ? (pred(node) ? node : (node.children ?? []).map((c) => find(c, pred)).find(Boolean)) : undefined)
const findAll = (node, pred) => (node && typeof node === 'object' ? [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))] : [])
const text = (node) => (typeof node === 'string' ? node : typeof node === 'number' ? String(node) : (node?.children ?? []).map(text).join(''))
const named = (tree, name) => find(tree, (n) => typeof n.type === 'function' && n.type.name === name)
const expand = (node) => node.type(node.props)
const withClass = (tree, cls) => findAll(tree, (n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls))
const tipCards = (tree) => findAll(tree, (n) => typeof n.type === 'function' && n.type.name === 'TipCard')
const item = (over = {}) => ({ id: 'a', type: 'completed', status: 'open', position: 1, createdAt: 1, sessionId: 's', title: 'Done', summary: 'x', payload: {}, ...over })
const snap = (over = {}) => ({ snapshotId: 'e:1', open: [], resolved: [], ...over })

test('an empty list shows "Nothing waiting on you." and the tip card in the side list and in the narrow list', () => {
  const { T } = load()
  T.state.snap = snap({ tip: TIP })
  const tree = T.Panel()
  const side = withClass(tree, 'rq-side')[0]
  const narrow = withClass(tree, 'rq-narrow')[0]
  for (const area of [side, narrow]) {
    assert.match(text(area), /Nothing waiting on you\./)
    assert.equal(tipCards(area).length, 1)
    assert.equal(tipCards(area)[0].props.tip.id, 't1')
  }
})

test('the tip card is a button with the category, title and body, and aria-pressed false while it is not read', () => {
  const { T } = load()
  T.state.snap = snap({ tip: TIP })
  const card = expand(tipCards(T.Panel())[0])
  const button = find(card, (n) => n.type === 'button')
  assert.ok(button, 'a real button (keyboard accessible)')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props['aria-pressed'], false)
  const all = text(button)
  assert.match(all, /Bloom filters/)
  assert.match(all, /bit array/)
  assert.match(all, /algorithms/i)
  assert.match(button.props.title, /read|aloud/i)
})

test('no tip card when the snapshot has no tip, when an item is open, or in the Resolved view', () => {
  const { T } = load()
  T.state.snap = snap()
  assert.equal(tipCards(T.Panel()).length, 0, 'no tip in the snapshot')
  T.state.snap = snap({ open: [item()], tip: TIP })
  assert.equal(tipCards(T.Panel()).length, 0, 'an open item hides it even if a stale tip is in the snapshot')
  T.state.snap = snap({ tip: TIP })
  T.state.showResolved = true
  assert.equal(tipCards(T.Panel()).length, 0, 'Resolved view')
  T.state.showResolved = false
  T.state.snap = null
  assert.equal(tipCards(T.Panel()).length, 0, 'still loading')
})

test('a filter that matches nothing while items are open shows no tip either', () => {
  const { T } = load()
  T.state.snap = snap({ open: [item()], tip: TIP })
  T.state.filter = { type: 'question', query: '' }
  assert.equal(tipCards(T.Panel()).length, 0)
})

test('clicking the card asks the server to read this tip', async () => {
  const { T, calls } = load()
  T.state.snap = snap({ tip: TIP })
  const button = find(expand(tipCards(T.Panel())[0]), (n) => n.type === 'button')
  button.props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls.map(([u, b]) => [u, b]), [['/review-queue/v1/read-tip', { id: 't1' }]])
})

test('while the tip is read the card is pressed and a click stops the reading', async () => {
  const { T, calls } = load()
  T.state.snap = snap({ tip: TIP, reading: 'tip:t1' })
  const button = find(expand(tipCards(T.Panel())[0]), (n) => n.type === 'button')
  assert.equal(button.props['aria-pressed'], true)
  assert.match(text(button), /stop/i)
  button.props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls.map(([u]) => u), ['/review-queue/v1/stop'])
})

test('the card is not pressed while another item or another tip is read', () => {
  const { T } = load()
  T.state.snap = snap({ tip: TIP, reading: 'tip:other' })
  assert.equal(find(expand(tipCards(T.Panel())[0]), (n) => n.type === 'button').props['aria-pressed'], false)
  T.state.snap = snap({ tip: TIP, reading: 'a' })
  assert.equal(find(expand(tipCards(T.Panel())[0]), (n) => n.type === 'button').props['aria-pressed'], false)
})

test('a failed read (muted voice) is shown on the card in words', async () => {
  const { T } = load({ fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'muted' }) }) })
  T.state.snap = snap({ tip: TIP })
  const button = find(expand(tipCards(T.Panel())[0]), (n) => n.type === 'button')
  button.props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.match(text(expand(tipCards(T.Panel())[0])), /Voice is muted/)
})

test('the tip card has its own style, with the category chip', () => {
  const { T } = load()
  assert.match(T.CSS, /\.rq-tip\{/)
})

// ---- the header count ------------------------------------------------------------------------------------------------------------------

const headOf = (T) => expand(named(T.Panel(), 'Head'))
test('the header shows "N working / M open" next to the waiting count, with a title that explains it', () => {
  const { T } = load()
  T.state.snap = snap({ sessions: { working: 2, open: 5 } })
  const head = headOf(T)
  const badge = withClass(head, 'rq-sess')[0]
  assert.ok(badge)
  assert.equal(text(badge), '2 working / 5 open')
  assert.match(badge.props.title, /turn running/)
  assert.match(badge.props.title, /not archived|open/)
  assert.ok(withClass(head, 'rq-count').length >= 2)
})

test('zero is shown when it is known; nothing is shown when it is not', () => {
  const { T } = load()
  T.state.snap = snap({ sessions: { working: 0, open: 0 } })
  assert.equal(text(withClass(headOf(T), 'rq-sess')[0]), '0 working / 0 open')
  T.state.snap = snap()
  assert.equal(withClass(headOf(T), 'rq-sess').length, 0)
  T.state.snap = snap({ sessions: { working: 'x', open: 1 } })
  assert.equal(withClass(headOf(T), 'rq-sess').length, 0)
  T.state.snap = null
  assert.equal(withClass(headOf(T), 'rq-sess').length, 0)
})

test('the numbers do not shift the layout: tabular digits and no wrapping', () => {
  const { T } = load()
  assert.match(T.CSS, /\.rq-sess\{[^}]*tabular-nums/)
  assert.match(T.CSS, /\.rq-sess\{[^}]*white-space:nowrap/)
})

test('sessionsText is a shared pure helper (the phone uses it)', () => {
  const { mod } = load()
  assert.equal(mod.shared.sessionsText({ working: 1, open: 3 }), '1 working / 3 open')
  assert.equal(mod.shared.sessionsText(undefined), '')
  assert.equal(mod.shared.sessionsText({ working: -1, open: 3 }), '')
  assert.equal(typeof mod.shared.sessionsTitle, 'string')
})

// ---- the long-poll token ---------------------------------------------------------------------------------------------------------------

test('the token carries the numbers and the tip id after the four old parts, always six parts', () => {
  const { T } = load()
  assert.equal(T.sinceOf({ snapshotId: 'e:3', focusId: 'f', reading: 'r', ui: { seq: 2 }, sessions: { working: 1, open: 4 }, tip: { id: 'tipX' } }), 'e:3|f|r|2|1/4|tipX')
  assert.equal(T.sinceOf({ snapshotId: 'e:3' }), 'e:3|||0||')
})

// ---- the poll asks for the tip only while the overlay is open --------------------------------------------------------------------------

const tick = () => new Promise((r) => setImmediate(r))
function hangingFetch(urls) {
  return (url, init) => {
    urls.push(url)
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  }
}
function visibleDoc() {
  const doc = { visibilityState: 'visible', listeners: {}, addEventListener(type, fn) { (doc.listeners[type] ??= []).push(fn) }, removeEventListener(type, fn) { doc.listeners[type] = (doc.listeners[type] ?? []).filter((f) => f !== fn) } }
  return doc
}
function startPolling(loaded) {
  const stops = []
  loaded.mod.apply({ uiWorkspace: {}, slots: { inject: () => () => {}, register: () => {} }, effect: (fn) => { const off = fn(); if (typeof off === 'function') stops.push(off) } })
  return () => stops.forEach((f) => f())
}

test('with the overlay closed the poll does not ask for a tip; opening it restarts the poll with tip=1, closing it again without', async () => {
  const urls = []
  const doc = visibleDoc()
  const loaded = load({ fetchImpl: hangingFetch(urls), doc })
  const stop = startPolling(loaded)
  await tick()
  assert.equal(urls.length, 1)
  assert.doesNotMatch(urls[0], /tip=1/)
  loaded.T.setOverlay(true)
  await tick()
  assert.equal(urls.length, 2, 'the request in flight was replaced at once')
  assert.match(urls[1], /tip=1/)
  loaded.T.setOverlay(false)
  await tick()
  assert.equal(urls.length, 3)
  assert.doesNotMatch(urls[2], /tip=1/)
  assert.equal(loaded.T.state.error, null, 'our own abort is not an error')
  stop()
})

test('an overlay that was left open starts the very first poll with tip=1', async () => {
  const urls = []
  const doc = visibleDoc()
  const loaded = load({ fetchImpl: hangingFetch(urls), stored: { 'dsh-review-queue.overlay': '1' }, doc })
  const stop = startPolling(loaded)
  await tick()
  assert.match(urls[0], /tip=1/)
  stop()
})

test('the tip is asked for only while the page is visible too; a change of visibility restarts the poll at once', async () => {
  const urls = []
  const doc = visibleDoc()
  const loaded = load({ fetchImpl: hangingFetch(urls), stored: { 'dsh-review-queue.overlay': '1' }, doc })
  const stop = startPolling(loaded)
  await tick()
  assert.match(urls[0], /tip=1/)
  doc.visibilityState = 'hidden'
  doc.listeners.visibilitychange.forEach((f) => f())
  await tick()
  assert.equal(urls.length, 2)
  assert.doesNotMatch(urls[1], /tip=1/, 'hidden: no tip')
  doc.visibilityState = 'visible'
  doc.listeners.visibilitychange.forEach((f) => f())
  await tick()
  assert.match(urls[2], /tip=1/)
  stop()
  assert.equal((doc.listeners.visibilitychange ?? []).length, 0, 'the listener is removed with the plugin')
})

test('a model-written tip says AI-generated; a built-in one does not', () => {
  const { T } = load()
  T.state.snap = snap({ tip: { ...TIP, source: 'model' } })
  assert.match(text(expand(tipCards(T.Panel())[0])), /AI-generated/)
  T.state.snap = snap({ tip: { ...TIP, source: 'builtin' } })
  assert.doesNotMatch(text(expand(tipCards(T.Panel())[0])), /AI-generated/)
})
