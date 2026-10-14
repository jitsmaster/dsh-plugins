// Slice 7: a held alert is re-rendered (refresh) just before it is replayed, so a queue position that changed while the flow ran is
// never spoken stale. refresh is optional and never breaks the replay.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeferredAlerts } from '../voice/deferred-alerts.js'

function setup(over = {}) {
  const h = { played: [], logs: [], clock: 0, busy: false }
  h.alerts = createDeferredAlerts({ busy: () => h.busy, play: (item) => { h.played.push(item) }, now: () => h.clock, log: (e) => h.logs.push(e), ...over })
  return h
}
const alert = (sessionId, event = 'Stop') => ({ sessionId, event, body: { headline: 'old ' + sessionId } })

test('DR1 refresh runs at replay time, not at defer time, and its result is what is played', async () => {
  let position = 3
  const calls = []
  const h = setup({ refresh: (item) => { calls.push(item.sessionId); return { ...item, body: { headline: 'Item ' + position } } } })
  h.alerts.defer(alert('a'))
  assert.deepEqual(calls, [], 'not at defer time')
  position = 1 // the queue changed while the flow ran
  await h.alerts.flush()
  assert.deepEqual(calls, ['a'])
  assert.deepEqual(h.played.map((p) => p.body.headline), ['Item 1'])
})

test('DR2 every alert is refreshed in turn, right before it plays', async () => {
  const order = []
  const h = setup({
    refresh: (item) => { order.push('refresh ' + item.sessionId); return item },
    play: (item) => { order.push('play ' + item.sessionId) },
  })
  h.alerts.defer(alert('a')); h.alerts.defer(alert('b'))
  await h.alerts.flush()
  assert.deepEqual(order, ['refresh a', 'play a', 'refresh b', 'play b'])
})

test('DR3 a refresh that throws, or returns nothing, plays the held alert as it was (and logs)', async () => {
  const h = setup({ refresh: (item) => { if (item.sessionId === 'a') throw new Error('boom'); return undefined } })
  h.alerts.defer(alert('a')); h.alerts.defer(alert('b'))
  await h.alerts.flush()
  assert.deepEqual(h.played.map((p) => p.body.headline), ['old a', 'old b'])
  assert.ok(h.logs.some((l) => l.stage === 'refresh-failed'))
})

test('DR4 expired and stale alerts are dropped before refresh runs (no lookup for an alert that is not spoken)', async () => {
  const calls = []
  const h = setup({ refresh: (item) => { calls.push(item.sessionId); return item }, relevant: (item) => item.sessionId !== 'stale', maxAgeMs: 1000 })
  h.alerts.defer(alert('old')); h.clock = 5000
  h.alerts.defer(alert('stale', 'PermissionRequest')); h.alerts.defer(alert('ok'))
  await h.alerts.flush()
  assert.deepEqual(calls, ['ok'])
  assert.deepEqual(h.played.map((p) => p.sessionId), ['ok'])
})

test('DR5 without a refresh option nothing changes', async () => {
  const h = setup()
  h.alerts.defer(alert('a'))
  await h.alerts.flush()
  assert.deepEqual(h.played.map((p) => p.body.headline), ['old a'])
})

test('DR6 a flow that starts again before the alert plays holds it (and its refresh is not spent)', async () => {
  const calls = []
  const h = setup({ refresh: (item) => { calls.push(1); return item } })
  h.alerts.defer(alert('a'))
  h.busy = true
  await h.alerts.flush()
  assert.deepEqual(calls, [])
  assert.equal(h.alerts.size(), 1)
})
