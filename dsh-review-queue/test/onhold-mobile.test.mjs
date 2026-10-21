import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// The phone's On hold tab: its own list and count (never waiting), the card (Continue, Release), the Hold button with a reason on Done and Paused cards.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
function loadOverlay() {
  let registered
  const file = join(root, 'lib', 'client.js')
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const core = loadOverlay().shared
const plain = (x) => JSON.parse(JSON.stringify(x))
const model = () => import('../lib/mobile/model.js')
const thread = () => import('../lib/mobile/thread.js')
const read = (f) => readFileSync(join(root, 'lib', 'mobile', f), 'utf8')
const held = (id, over = {}) => ({ id, type: 'onhold', status: 'open', sessionId: 's-' + id, sessionTitle: 'Fix: Bug - 4711', createdAt: 10, payload: { reason: 'waiting for the customer', heldAt: 1000, ticket: { id: '4711', base: 'b' }, lastCheckedAt: null }, ...over })

test('the list model: held sessions are not waiting, not in All, and have their own count and list', async () => {
  const { listModel } = await model()
  const snap = { open: [held('a'), held('b', { payload: { reason: 'other', heldAt: 1 } }), { id: 'c', type: 'completed', createdAt: 1 }], resolved: [] }
  const m = listModel(core, snap, { type: 'all', query: '' })
  assert.equal(m.waiting, 1)
  assert.equal(m.held, 2)
  assert.deepEqual(plain(m.open.map((i) => i.id)), ['c'])
  assert.deepEqual(plain(m.heldOpen.map((i) => i.id)), ['a', 'b'])
  assert.deepEqual(plain(listModel(core, snap, { type: 'all', query: 'customer' }).heldOpen.map((i) => i.id)), ['a'], 'the search covers the reason')
  assert.ok(!m.chips.some((c) => c.type === 'onhold'), 'no chip: the held queue is a tab of its own')
  assert.equal(listModel(core, null, { type: 'all' }).held, 0)
  assert.deepEqual(plain(listModel(core, null, { type: 'all' }).heldOpen), [])
})

test('heldView gives the facts the desktop card shows', async () => {
  const { heldView } = await model()
  const v = heldView(core, held('a'), 1000 + 5 * 60_000)
  assert.equal(v.facts[0], 'waiting for the customer')
  assert.ok(v.facts.some((l) => /ticket 4711/.test(l)))
})

test('the chat: a held session can be read but not written to from the phone (Continue it first)', async () => {
  const { canPost, hasThread, postErrorText } = await thread()
  assert.equal(hasThread(held('a')), true)
  assert.equal(canPost(held('a')), false)
  assert.equal(canPost({ type: 'completed', sessionId: 's' }), true)
  assert.match(postErrorText('onhold'), /on hold/)
})

test('the service refuses a post to an open on-hold item and keeps the item', async () => {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const prompts = []
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({ prompt: async (r) => { prompts.push(r); return {} } }) })
  const open = store.add({ type: 'onhold', sessionId: 's-h', sessionTitle: 'x', payload: { reason: 'r', heldAt: 1, ticket: null } })
  assert.deepEqual(await queue.post(open.id, 'hello'), { ok: false, error: 'onhold' })
  assert.equal(store.get(open.id).status, 'open')
  assert.deepEqual(prompts, [])
})

test('the phone words: the error, and the resolution lines are the shared ones', () => {
  assert.match(core.errorText(409, { error: 'onhold' }), /on hold/)
  const views = read('views.js')
  assert.match(views, /c\.resolutionText\(/)
})

test('the phone code: the On hold tab and route, the card with Continue and Release, the Hold button with a reason, the chip style', () => {
  const mobile = ['api.js', 'views.js', 'model.js', 'app.js'].map(read).join('\n')
  for (const route of ['/v1/hold-continue', '/v1/hold-release', '/v1/hold']) assert.ok(mobile.includes("'" + route + "'"), route)
  const views = read('views.js')
  for (const needle of ['HeldBody', 'HeldList', 'OnHoldButton', 'OnHoldForm', "'/onhold'", '#/onhold', 'On hold']) assert.ok(views.includes(needle), needle)
  assert.match(views, /'Continue'/)
  assert.match(views, />Release</)
  assert.ok(/\.chip\.onhold/.test(read('style.css')))
})

test('the Hold button is on the Done card and on the Paused card, not on a held card', () => {
  const views = read('views.js')
  const body = (name) => { const i = views.indexOf('function ' + name + '('); return views.slice(i, views.indexOf('\n}\n', i)) }
  assert.match(body('PausedBody'), /OnHoldButton/)
  assert.match(body('CompletedBody'), /OnHoldButton/)
  assert.doesNotMatch(body('HeldBody'), /OnHoldButton/)
})
