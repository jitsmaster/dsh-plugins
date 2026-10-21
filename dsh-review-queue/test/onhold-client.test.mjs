import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadClient, el, findAll, textOf, okJson, tick } from './client-todo-helpers.mjs'

// The overlay side of the on-hold queue: labels, counts, the separate view, the card facts, the Hold button and the routes it calls.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')
function load() {
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, AbortSignal, fetch: () => new Promise(() => {}),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const mod = registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
  return { mod, T: mod.__test, shared: mod.shared }
}
const held = (id, over = {}) => ({ id, type: 'onhold', status: 'open', sessionId: 's-' + id, sessionTitle: 'Fix: Bug - 4711', createdAt: 10, payload: { reason: 'waiting for the customer', heldAt: 1000, ticket: { id: '4711', base: 'https://dev.azure.com/o/p' }, baseline: {}, lastCheckedAt: null, checkError: null }, ...over })

test('the label, and the held items stay out of the chips, the waiting count and the "All" filter', () => {
  const { T, shared } = load()
  assert.equal(T.typeLabel('onhold'), 'On hold')
  assert.ok(!T.FILTER_TYPES.includes('onhold'), 'the held queue is its own view, not a chip')
  const open = [held('a'), held('b'), { id: 'c', type: 'completed', sessionTitle: 'x' }]
  assert.equal(T.waitingCount(open), 1)
  assert.equal(shared.heldCount(open), 2)
  assert.equal(shared.heldCount(undefined), 0)
  assert.deepEqual(T.filterItems(open, { type: 'all', query: '' }).map((i) => i.id), ['c'])
  assert.deepEqual(T.filterItems(open, { type: 'onhold', query: '' }).map((i) => i.id), ['a', 'b'])
  assert.deepEqual(T.filterItems(open, { type: 'onhold', query: 'customer' }).map((i) => i.id), ['a', 'b'], 'the reason is searchable')
  assert.deepEqual(T.filterItems(open, { type: 'onhold', query: 'nothing-like-this' }).map((i) => i.id), [])
})

test('resolution lines: held, released and continued (by the ticket or by the card)', () => {
  const { T } = load()
  assert.equal(T.resolutionText({ type: 'completed', resolution: { kind: 'held', by: 'card' } }), 'Put on hold')
  assert.equal(T.resolutionText({ type: 'onhold', resolution: { kind: 'released', by: 'card' } }), 'Taken off hold')
  assert.equal(T.resolutionText({ type: 'onhold', resolution: { kind: 'continued', by: 'card' } }), 'Continued from hold')
  assert.equal(T.resolutionText({ type: 'onhold', resolution: { kind: 'continued', by: 'ticket', changes: ['new comment', 'state changed'] } }), 'Continued: the ticket changed (new comment; state changed)')
  assert.equal(T.resolutionText({ type: 'onhold', resolution: { kind: 'continued', by: 'ticket' } }), 'Continued: the ticket changed')
})

test('heldFacts: reason, ticket, last check and the error codes', () => {
  const { shared } = load()
  const now = 1000 + 5 * 60_000
  const f = shared.heldFacts(held('a'), now)
  assert.equal(f[0], 'waiting for the customer')
  assert.ok(f.some((l) => /ticket 4711/.test(l) && /10 minutes/.test(l)), 'names the ticket and the check interval')
  assert.ok(f.some((l) => /^Held /.test(l)))
  assert.ok(f.some((l) => /Not checked yet/.test(l)))
  const g = shared.heldFacts(held('b', { payload: { heldAt: 1000, ticket: null, lastCheckedAt: null } }), now)
  assert.equal(g[0], 'On hold')
  assert.ok(g.some((l) => /No ticket/.test(l) && /Continue or Release/.test(l)))
  const h = shared.heldFacts(held('c', { payload: { reason: 'r', heldAt: 1000, ticket: { id: '9', base: 'b' }, lastCheckedAt: now - 60_000, checkError: 'no-pat', continueError: 'timeout' } }), now)
  assert.ok(h.some((l) => /^Last checked /.test(l)))
  assert.ok(h.some((l) => /Could not read the ticket/.test(l) && /no-pat/.test(l)))
  assert.ok(h.some((l) => /Could not prompt the session/.test(l) && /timeout/.test(l)))
})

test('errors: not-holdable and no-onhold have words', () => {
  const { T } = load()
  assert.match(T.errorText(409, { error: 'not-holdable' }), /finished work|paused/)
  assert.match(T.errorText(409, { error: 'no-onhold' }), /not available/)
})

test('the overlay has the On hold view, the card, the Hold button and the three routes', () => {
  for (const needle of ['/v1/hold"', '/v1/hold-release', '/v1/hold-continue', 'OnHoldBody', 'HoldForm', 'showHeld', 'rq-chip.onhold']) assert.ok(source.includes(needle), needle)
})

// ---- what the cards do -------------------------------------------------------------------------------------

function render() {
  const calls = []
  const c = loadClient({
    react: { createElement: el, useEffect() {}, useState: () => [0, () => {}] },
    fetchImpl: async (url, opts) => { calls.push([url.replace(/^.*(\/v1\/[a-z-]+).*$/, '$1'), opts?.body ? JSON.parse(opts.body) : undefined]); return okJson({ ok: true }) },
  })
  return { ...c, calls }
}
const button = (tree, label) => findAll(tree, (n) => n.type === 'button').find((b) => textOf(b) === label)

test('the on-hold card shows the facts and its Continue and Release buttons call the hold routes', async () => {
  const { T, calls } = render()
  const tree = T.OnHoldBody({ item: held('h1'), full: true })
  const text = textOf(tree)
  assert.match(text, /waiting for the customer/)
  assert.match(text, /ticket 4711/)
  button(tree, 'Continue').props.onClick()
  await tick()
  button(tree, 'Release').props.onClick()
  await tick()
  assert.deepEqual(calls.map((c) => c[0]), ['/v1/hold-continue', '/v1/hold-release'])
  assert.deepEqual(calls.map((c) => c[1]), [{ id: 'h1' }, { id: 'h1' }])
})

test('the Hold form: closed it shows nothing; the Hold button opens it; Put on hold posts the id and the reason and closes it', async () => {
  const { T, calls } = render()
  const item = { id: 'd1', type: 'completed', status: 'open', sessionId: 's1', sessionTitle: 'Fix: X - 4711', summary: 'Done', createdAt: 1 }
  assert.equal(T.HoldForm({ item }), null)
  const hasHold = (tree) => findAll(tree, (n) => n.type === T.HoldButton).length === 1
  assert.ok(hasHold(T.PausedBody({ item: { ...item, type: 'paused', payload: {} }, full: true })), 'a paused card has a Hold button')
  assert.ok(hasHold(T.CompletedBody({ item, full: true })), 'a Done card has a Hold button once it is expanded')
  assert.ok(!hasHold(T.CompletedBody({ item, full: false })), 'but not while collapsed')
  T.HoldButton({ item }).props.onClick()
  assert.equal(T.state.holdOpen.d1, '', 'the Hold button opens the reason line')
  assert.equal(T.HoldButton({ item }).props.disabled, true, 'and is disabled while the line is open')
  T.set({ holdOpen: { d1: 'waiting for the customer' } })
  const form = T.HoldForm({ item })
  assert.equal(findAll(form, (n) => n.type === 'input')[0].props.value, 'waiting for the customer')
  button(form, 'Put on hold').props.onClick()
  await tick()
  await tick()
  assert.deepEqual(calls, [['/v1/hold', { id: 'd1', reason: 'waiting for the customer' }]])
  assert.equal(T.state.holdOpen.d1, undefined, 'the form closes after a successful hold')
})
