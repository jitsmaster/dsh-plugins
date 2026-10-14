import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// From the phone an approve must say it went through the confirm sheet, and a risky one also the press-and-hold.
function setup() {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const decided = []
  const capture = { decidePermission: (id, d) => { decided.push([id, d]); return { ok: true } } }
  const queue = createReviewQueue({ store, capture, controllerOf: () => ({}), speaker: undefined })
  const safe = store.add({ type: 'permission', sessionId: 's', sessionTitle: 'S', payload: { toolName: 'shell', summary: 'shell: ls', detail: 'ls' } })
  const risky = store.add({ type: 'permission', sessionId: 's', sessionTitle: 'S', payload: { toolName: 'shell', summary: 'shell: git push --force', detail: 'git push --force origin main' } })
  return { queue, decided, safe, risky }
}

test('desktop approve (no via) is unchanged, risky or not', () => {
  const { queue, decided, safe, risky } = setup()
  assert.deepEqual(queue.approve(safe.id), { ok: true })
  assert.deepEqual(queue.approve(risky.id), { ok: true })
  assert.equal(decided.length, 2)
})

test('phone approve without the confirm sheet is refused and nothing is decided', () => {
  const { queue, decided, safe } = setup()
  assert.deepEqual(queue.approve(safe.id, { via: 'phone' }), { ok: false, error: 'needs-confirm' })
  assert.deepEqual(queue.approve(safe.id, { via: 'phone', confirmed: false }), { ok: false, error: 'needs-confirm' })
  assert.deepEqual(decided, [])
})

test('phone approve with the confirm sheet works for a safe request', () => {
  const { queue, decided, safe } = setup()
  assert.deepEqual(queue.approve(safe.id, { via: 'phone', confirmed: true }), { ok: true })
  assert.deepEqual(decided, [[safe.id, 'approve']])
})

test('a risky request also needs the press-and-hold from the phone', () => {
  const { queue, decided, risky } = setup()
  assert.deepEqual(queue.approve(risky.id, { via: 'phone', confirmed: true }), { ok: false, error: 'needs-hold' })
  assert.deepEqual(decided, [])
  assert.deepEqual(queue.approve(risky.id, { via: 'phone', confirmed: true, held: true }), { ok: true })
  assert.deepEqual(decided, [[risky.id, 'approve']])
})

test('deny from the phone needs no confirmation', () => {
  const { queue, decided, risky } = setup()
  assert.deepEqual(queue.deny(risky.id), { ok: true })
  assert.deepEqual(decided, [[risky.id, 'deny']])
})

test('approve all identical from the phone needs the confirm sheet', () => {
  const { queue, safe } = setup()
  assert.deepEqual(queue.approveSimilar(safe.id, { via: 'phone' }), { ok: false, error: 'needs-confirm' })
  assert.equal(queue.approveSimilar(safe.id, { via: 'phone', confirmed: true }).ok, true)
})
