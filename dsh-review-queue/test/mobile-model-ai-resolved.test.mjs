// Slice 2 of the AI triage plan on the phone: the "Resolved by" chips, the unseen AI count, and the persisted resolvedBy filter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { listModel } from '../lib/mobile/model.js'

const file = fileURLToPath(new URL('../lib/client.js', import.meta.url))
function loadOverlay() {
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
}
const core = loadOverlay().shared

const aiItem = (over = {}) => ({ id: 'a' + Math.random(), type: 'permission', status: 'resolved', title: 'ai', createdAt: 1, resolution: { kind: 'ai-resolved', by: 'ai', action: 'approved', ...over } })
const myItem = () => ({ id: 'm' + Math.random(), type: 'permission', status: 'resolved', title: 'me', createdAt: 1, resolution: { kind: 'approved', by: 'card' } })
const openItem = () => ({ id: 'o' + Math.random(), type: 'permission', status: 'open', title: 'open', createdAt: 1, payload: {} })

test('listModel offers the Resolved by chips, All on by default', () => {
  const m = listModel(core, { open: [], resolved: [] }, { type: 'all', query: '' })
  assert.deepEqual(m.resolvedChips.map((c) => ({ ...c })), [
    { value: 'all', label: 'All', on: true },
    { value: 'me', label: 'Me', on: false },
    { value: 'ai', label: 'AI', on: false },
  ])
})

test('the chip of the active resolvedBy filter is on; an unknown value turns none on', () => {
  const on = (resolvedBy) => listModel(core, { open: [], resolved: [] }, { type: 'all', query: '', resolvedBy }).resolvedChips.filter((c) => c.on).map((c) => c.value)
  assert.deepEqual(on('ai'), ['ai'])
  assert.deepEqual(on('me'), ['me'])
  assert.deepEqual(on('all'), ['all'])
  assert.deepEqual(on(undefined), ['all'])
  assert.deepEqual(on('bogus'), [], 'the chips only say what is set; the filter treats an unknown value as All')
})

test('listModel counts the AI-resolved items nobody has seen or reviewed', () => {
  const resolved = [aiItem(), aiItem({ seen: true }), aiItem({ review: 'agreed' }), myItem()]
  assert.equal(listModel(core, { open: [], resolved }, { type: 'all', query: '' }).aiUnseen, 1)
  assert.equal(listModel(core, { open: [], resolved: [] }, { type: 'all', query: '' }).aiUnseen, 0)
  assert.equal(listModel(core, undefined, undefined).aiUnseen, 0)
})

test('the unseen count ignores the resolvedBy filter', () => {
  const resolved = [aiItem(), myItem()]
  assert.equal(listModel(core, { open: [], resolved }, { type: 'all', query: '', resolvedBy: 'me' }).aiUnseen, 1)
})

test('the resolved list follows the resolvedBy filter, and the open list is left alone', () => {
  const a = aiItem(), m = myItem(), o = openItem()
  const snap = { open: [o], resolved: [a, m] }
  const by = (resolvedBy) => listModel(core, snap, { type: 'all', query: '', resolvedBy })
  assert.deepEqual(by('ai').resolved, [a])
  assert.deepEqual(by('me').resolved, [m])
  assert.deepEqual(by('all').resolved, [a, m])
  assert.deepEqual(by('bogus').resolved, [a, m])
  assert.deepEqual(by('ai').open, [o])
  assert.equal(by('ai').resolvedCount, 2)
})

test('the filter bar shows for the AI filter and for any AI-resolved item', () => {
  assert.equal(listModel(core, { open: [], resolved: [myItem()] }, { type: 'all', query: '', resolvedBy: 'ai' }).barVisible, true)
  assert.equal(listModel(core, { open: [], resolved: [aiItem()] }, { type: 'all', query: '' }).barVisible, true)
  assert.equal(listModel(core, { open: [], resolved: [myItem()] }, { type: 'all', query: '' }).barVisible, false)
})

test('the existing list model fields are unchanged', () => {
  const m = listModel(core, { open: [openItem()], resolved: [myItem()] }, { type: 'all', query: '' })
  for (const k of ['waiting', 'paused', 'held', 'heldOpen', 'sessions', 'open', 'resolved', 'resolvedCount', 'barVisible', 'chips']) assert.ok(k in m, k)
  assert.equal(m.chips.length, core.FILTER_TYPES.length)
  assert.equal(m.resolvedCount, 1)
})
