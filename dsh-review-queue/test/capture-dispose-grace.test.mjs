import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { installCapture } from '../capture.js'

// A DSH shutdown disposes every agent and fires agent/disposed for each one: it is not a signal that the user closed the session.
// Cards that outlive the process (done, on hold, archive, todo, ...) must survive it; only a disposal that lasts closes them.

function setup(options = {}) {
  const handlers = {}
  const live = new Set()
  const ctx = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn) },
    get: (name) => (name === 'agents' ? { get: (id) => (live.has(id) ? { id } : undefined) } : undefined),
    logger: { warn() {}, info() {} },
  }
  let t = 1000
  let n = 0
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const logs = []
  installCapture(ctx, { store, summarizer: { summarize: async () => ({ text: 'x', source: 'llm' }) }, log: (l) => logs.push(l), ...options })
  const fire = (name, ...args) => handlers[name][0](...args)
  return { store, fire, live, logs }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a disposal leaves done, on-hold and archive cards open during the grace period', () => {
  const { store, fire } = setup({ disposeGraceMs: 60_000 })
  const done = store.add({ type: 'completed', sessionId: 's1', payload: {} })
  const hold = store.add({ type: 'onhold', sessionId: 's1', payload: { reason: 'x' } })
  const arch = store.add({ type: 'archive', sessionId: 's1', payload: { reason: 'x' } })
  fire('agent/disposed', { agent: { id: 's1' } })
  for (const item of [done, hold, arch]) assert.equal(store.get(item.id).status, 'open', item.type)
})

test('the cards close as session-ended once the grace period passes and the session did not come back', async () => {
  const { store, fire } = setup({ disposeGraceMs: 20 })
  const done = store.add({ type: 'completed', sessionId: 's1', payload: {} })
  fire('agent/disposed', { agent: { id: 's1' } })
  await wait(80)
  assert.equal(store.get(done.id).status, 'resolved')
  assert.equal(store.get(done.id).resolution.kind, 'session-ended')
})

test('a session that is live again after the grace period keeps its cards', async () => {
  const { store, fire, live } = setup({ disposeGraceMs: 20 })
  const hold = store.add({ type: 'onhold', sessionId: 's1', payload: { reason: 'x' } })
  fire('agent/disposed', { agent: { id: 's1' } })
  live.add('s1')
  await wait(80)
  assert.equal(store.get(hold.id).status, 'open')
})

test('a disposal still closes a permission card at once (its request died with the session)', () => {
  const { store, fire } = setup({ disposeGraceMs: 60_000 })
  const p = store.add({ type: 'permission', sessionId: 's1', payload: {} })
  fire('agent/disposed', { agent: { id: 's1' } })
  assert.equal(store.get(p.id).status, 'resolved')
})

test('a disposal leaves a question card open during the grace period (a DSH shutdown disposes every agent; the card survives the restart)', () => {
  const { store, fire } = setup({ disposeGraceMs: 60_000 })
  const q = store.add({ type: 'question', sessionId: 's1', payload: { questions: [] } })
  fire('agent/disposed', { agent: { id: 's1' } })
  assert.equal(store.get(q.id).status, 'open')
})

test('a question card closes as session-ended once the grace passes and the session did not come back', async () => {
  const { store, fire } = setup({ disposeGraceMs: 20 })
  const q = store.add({ type: 'question', sessionId: 's1', payload: { questions: [] } })
  fire('agent/disposed', { agent: { id: 's1' } })
  await wait(80)
  assert.equal(store.get(q.id).resolution.kind, 'session-ended')
})

