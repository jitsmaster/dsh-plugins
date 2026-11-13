// Slice 2: the queue order switch in the Rules view (Oldest first / By priority), posted to /v1/queue-order.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, findAll, textOf, tick, okJson } from './client-todo-helpers.mjs'

const PAYLOAD = { ok: true, enabled: true, rules: [], lessons: [] }

function clientSetup(queueOrder) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const method = (init && init.method) || 'GET'
    calls.push([method, String(url), init && init.body ? JSON.parse(init.body) : undefined])
    return method === 'GET' ? okJson(PAYLOAD) : okJson({ ok: true })
  }
  const { T } = loadClient({ fetchImpl, react: { createElement: el } })
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [], ...(queueOrder ? { queueOrder } : {}) }
  return { T, calls }
}
const part = (T, name) => { const n = findAll(T.Panel(), (x) => typeof x.type === 'function' && x.type.name === name)[0]; assert.ok(n, name); return n.type(n.props) }
const sw = (tree) => findAll(tree, (n) => n.props && n.props['data-queue-order'] !== undefined)[0]
const btn = (tree, text) => findAll(sw(tree), (n) => n.type === 'button' && textOf(n) === text)[0]

test('client: RulesView shows the order switch; default is Oldest first', () => {
  const { T } = clientSetup()
  T.set({ triageRules: PAYLOAD, showRules: true })
  const tree = part(T, 'RulesView')
  assert.ok(sw(tree), 'switch rendered')
  assert.equal(btn(tree, 'Oldest first').props['aria-checked'], true)
  assert.equal(btn(tree, 'By priority').props['aria-checked'], false)
})

test('client: picking By priority posts { mode } and the snapshot follows at once', async () => {
  const { T, calls } = clientSetup('oldest')
  T.set({ triageRules: PAYLOAD, showRules: true })
  btn(part(T, 'RulesView'), 'By priority').props.onClick()
  await tick(); await tick()
  const posted = calls.filter((c) => c[0] === 'POST')
  assert.equal(posted.length, 1)
  assert.match(posted[0][1], /\/v1\/queue-order$/)
  assert.deepEqual(posted[0][2], { mode: 'tier' })
  assert.equal(T.state.snap.queueOrder, 'tier')
  assert.equal(calls.filter((c) => c[0] === 'GET' && /triage-rules/.test(c[1])).length, 0) // no pointless reload of the rules
})

test('client: the switch shows By priority from the snapshot and is disabled while busy', () => {
  const { T } = clientSetup('tier')
  T.set({ triageRules: PAYLOAD, showRules: true, rulesBusy: { 'queue-order': true } })
  const tree = part(T, 'RulesView')
  assert.equal(btn(tree, 'By priority').props['aria-checked'], true)
  assert.equal(btn(tree, 'Oldest first').props.disabled, true)
})

test('client: switching the order retakes the overlay hold in the new order', async () => {
  const { T } = clientSetup('oldest')
  T.set({ triageRules: PAYLOAD, showRules: true })
  T.state.overlay = true
  T.state.hold = { ids: ['stale'] }
  btn(part(T, 'RulesView'), 'By priority').props.onClick()
  await tick(); await tick()
  assert.equal(T.state.hold, null)
})
