import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// The phone shows paused sessions read-only: an indicator and a list, never a Resume or a Dismiss (DEVICE_ACTIONS stays as it is).
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
const paused = (id, over = {}) => ({ id, type: 'paused', status: 'open', sessionId: 's-' + id, sessionTitle: 'Work ' + id, createdAt: 10, payload: { lastWrite: 1000, reason: 'Cut off in the middle of a turn' }, ...over })

test('the list model: paused sessions do not raise the waiting count and have their own count and chip', async () => {
  const { listModel } = await model()
  const snap = { open: [paused('a'), paused('b'), { id: 'c', type: 'completed', createdAt: 1 }], resolved: [] }
  const m = listModel(core, snap, { type: 'all', query: '' })
  assert.equal(m.waiting, 1)
  assert.equal(m.paused, 2)
  assert.equal(m.open.length, 3)
  assert.ok(m.chips.some((c) => c.type === 'paused' && c.label === 'Paused'))
  assert.deepEqual(plain(listModel(core, snap, { type: 'paused', query: '' }).open.map((i) => i.id)), ['a', 'b'])
  assert.equal(listModel(core, null, { type: 'all' }).paused, 0)
})

test('pausedNote is the indicator line: how many, and where to resume them', async () => {
  const { pausedNote } = await model()
  assert.equal(pausedNote(0), undefined)
  assert.equal(pausedNote(1), '1 session was paused by a restart. Resume or dismiss it at the PC.')
  assert.equal(pausedNote(3), '3 sessions were paused by a restart. Resume or dismiss them at the PC.')
})

test('pausedView is read only: the facts and a note where to act, no actions', async () => {
  const { pausedView } = await model()
  const v = pausedView(core, paused('a'), 1000 + 5 * 60_000)
  assert.deepEqual(plain(v.facts), ['Cut off in the middle of a turn', 'Last activity 5 min ago'])
  assert.equal(v.note, 'To resume this session, use the Task list on the PC.')
  assert.equal(v.actions, undefined)
})

test('the phone has no way to resume or dismiss: no route in its code, nothing on its action list, a style for the chip', () => {
  const mobile = ['api.js', 'views.js', 'model.js', 'app.js', 'core.js'].map((f) => readFileSync(join(root, 'lib', 'mobile', f), 'utf8')).join('\n')
  assert.ok(!/paused-resume|paused-dismiss|paused-scan/.test(mobile))
  assert.ok(/PausedBody/.test(readFileSync(join(root, 'lib', 'mobile', 'views.js'), 'utf8')))
  assert.ok(/\.chip\.paused/.test(readFileSync(join(root, 'lib', 'mobile', 'style.css'), 'utf8')))
})
