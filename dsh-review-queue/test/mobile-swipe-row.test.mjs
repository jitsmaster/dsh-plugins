import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// Touch behaviour of a Waiting row (docs/mobile.md "Swipe to review"): ItemRow is hook-free, so it is called as a plain function and its
// touch handlers are driven with fake events over fake row elements. A fake fetch plays the hub.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const noop = () => {}
globalThis.location = { pathname: '/m/', hash: '', origin: 'http://x', href: 'http://x/m/' }
globalThis.window = globalThis
globalThis.document = { addEventListener: noop, removeEventListener: noop, hidden: false, createElement: () => ({}), head: { append: noop } }
globalThis.addEventListener = noop
globalThis.removeEventListener = noop
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }

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

const itemOf = (id, type = 'completed') => ({ id, type, status: 'open', title: 't' + id, createdAt: 1, payload: {} })
const flush = () => new Promise((r) => setTimeout(r, 5))

let calls, status
beforeEach(() => {
  api.dismissUndo()
  calls = []
  status = 200
  api.set({ busy: {}, errors: {}, fresh: {}, undo: null, needsPairing: false })
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: status < 300, status, headers: { get: () => null }, json: async () => (status < 300 ? { ok: true } : { error: 'nope' }) }
  }
})

/** A row element with the two children the handlers move. */
function fakeRow() {
  const link = { style: {} }
  const hint = { style: {}, classList: { on: false, toggle(_c, v) { this.on = v }, remove() { this.on = false } } }
  return { link, hint, querySelector: (s) => (s === '.rowitem' ? link : s === '.swipe-hint' ? hint : null) }
}
const at = (row, x, y) => ({ touches: [{ clientX: x, clientY: y }], currentTarget: row })
const lift = (row) => ({ touches: [], currentTarget: row })
const linkVnode = (props) => [].concat(props.children).flat(Infinity).find((c) => c && c.props && String(c.props.class || '').includes('rowitem'))
const click = (props) => { const e = { prevented: false, preventDefault() { this.prevented = true } }; linkVnode(props).props.onClick(e); return e.prevented }

test('a swipeable row carries the touch handlers; a question row is the bare link without them', () => {
  const v = views.ItemRow({ item: itemOf('a') })
  assert.equal(v.type, 'div')
  for (const h of ['onTouchStart', 'onTouchMove', 'onTouchEnd', 'onTouchCancel']) assert.equal(typeof v.props[h], 'function', h)
  const q = views.ItemRow({ item: itemOf('q', 'question') })
  assert.equal(q.type, 'a')
  assert.equal(q.props.onTouchStart, undefined)
})

test('a drag to the right follows the finger and shows the hint; a release past the commit distance reviews the item once and leaves the row in place', async () => {
  const p = views.ItemRow({ item: itemOf('a') }).props
  const row = fakeRow()
  p.onTouchStart(at(row, 0, 0))
  p.onTouchMove(at(row, 30, 2))
  p.onTouchMove(at(row, 120, 5))
  assert.equal(row.link.style.transform, 'translateX(120px)')
  assert.equal(row.hint.classList.on, true, 'ready past the commit distance')
  p.onTouchEnd(lift(row))
  await flush()
  assert.deepEqual(calls, [{ url: '/v1/reviewed', body: { id: 'a' } }])
  assert.equal(row.link.style.transform, 'translateX(120px)', 'success: the snapshot removes the row, it does not slide back')
  assert.equal(api.state.undo.id, 'a')
})

test('a short release springs back and reviews nothing', async () => {
  const p = views.ItemRow({ item: itemOf('a') }).props
  const row = fakeRow()
  p.onTouchStart(at(row, 0, 0))
  p.onTouchMove(at(row, 60, 3))
  assert.equal(row.link.style.transform, 'translateX(60px)')
  p.onTouchEnd(lift(row))
  await flush()
  assert.equal(row.link.style.transform, '')
  assert.deepEqual(calls, [])
})

test('a vertical drag is a scroll: the row never moves and nothing is reviewed, even if the finger later runs far to the right', async () => {
  const p = views.ItemRow({ item: itemOf('a') }).props
  const row = fakeRow()
  p.onTouchStart(at(row, 0, 0))
  p.onTouchMove(at(row, 2, 30))
  p.onTouchMove(at(row, 200, 32))
  assert.equal(row.link.style.transform, undefined)
  p.onTouchEnd(lift(row))
  await flush()
  assert.deepEqual(calls, [])
})

test('a leftward drag does not move the row to the left', () => {
  const p = views.ItemRow({ item: itemOf('a') }).props
  const row = fakeRow()
  p.onTouchStart(at(row, 100, 0))
  p.onTouchMove(at(row, 40, 2))
  assert.equal(row.link.style.transform, undefined)
})

test('touchcancel puts the row back and reviews nothing', async () => {
  const p = views.ItemRow({ item: itemOf('a') }).props
  const row = fakeRow()
  p.onTouchStart(at(row, 0, 0))
  p.onTouchMove(at(row, 80, 2))
  p.onTouchCancel({ currentTarget: row })
  assert.equal(row.link.style.transform, '')
  await flush()
  assert.deepEqual(calls, [])
})

test('a second finger cancels the swipe (a pinch is not a review)', async () => {
  const p = views.ItemRow({ item: itemOf('a') }).props
  const row = fakeRow()
  p.onTouchStart({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 50, clientY: 50 }], currentTarget: row })
  p.onTouchMove(at(row, 150, 2))
  p.onTouchEnd(lift(row))
  await flush()
  assert.deepEqual(calls, [])
})

test('the click that follows a swipe is swallowed once; a later click opens the item as usual', async () => {
  const p = views.ItemRow({ item: itemOf('a') }).props
  const row = fakeRow()
  p.onTouchStart(at(row, 0, 0))
  p.onTouchMove(at(row, 50, 2))
  p.onTouchEnd(lift(row))
  assert.equal(click(p), true, 'swallowed')
  assert.equal(click(p), false, 'only once')
  p.onTouchStart(at(row, 0, 0))
  p.onTouchMove(at(row, 50, 2))
  p.onTouchEnd(lift(row))
  await new Promise((r) => setTimeout(r, 400)) // the 350 ms swallow window has passed
  assert.equal(click(p), false, 'a click after the lift has settled is a real click')
})

test('the swallow timer of an earlier lift does not clear the flag of a newer swipe', async () => {
  const p = views.ItemRow({ item: itemOf('a') }).props
  const row = fakeRow()
  p.onTouchStart(at(row, 0, 0))
  p.onTouchMove(at(row, 50, 2))
  p.onTouchEnd(lift(row)) // timer 1 fires at 350 ms
  await new Promise((r) => setTimeout(r, 200))
  p.onTouchStart(at(row, 0, 0))
  p.onTouchMove(at(row, 50, 2))
  p.onTouchEnd(lift(row)) // timer 2 fires at 550 ms
  await new Promise((r) => setTimeout(r, 250)) // 450 ms: timer 1 would have fired
  assert.equal(click(p), true, 'the second lift is still being swallowed')
})

test('the drag writes the transition once and toggles ready only when it changes', () => {
  const p = views.ItemRow({ item: itemOf('a') }).props
  const row = fakeRow()
  let transitionWrites = 0
  let v = ''
  Object.defineProperty(row.link.style, 'transition', { get: () => v, set: (x) => { transitionWrites++; v = x } })
  let toggles = 0
  const t = row.hint.classList.toggle
  row.hint.classList.toggle = function (c, on) { toggles++; return t.call(this, c, on) }
  p.onTouchStart(at(row, 0, 0))
  for (const x of [20, 40, 60, 80, 100, 110, 120, 130]) p.onTouchMove(at(row, x, 2))
  assert.equal(transitionWrites, 1)
  assert.ok(toggles <= 2, 'toggled ' + toggles + ' times')
})

test('a plain tap (no movement) is not swallowed', () => {
  const p = views.ItemRow({ item: itemOf('a') }).props
  const row = fakeRow()
  p.onTouchStart(at(row, 10, 10))
  p.onTouchEnd(lift(row))
  assert.equal(click(p), false)
})

test('a failed review springs the row back and shows the error in the toast', async () => {
  status = 409
  const p = views.ItemRow({ item: itemOf('a') }).props
  const row = fakeRow()
  p.onTouchStart(at(row, 0, 0))
  p.onTouchMove(at(row, 130, 2))
  p.onTouchEnd(lift(row))
  await flush()
  assert.equal(row.link.style.transform, '')
  assert.ok(api.state.undo && api.state.undo.error)
})
