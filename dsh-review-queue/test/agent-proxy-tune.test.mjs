import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReviewQueue } from '../service.js'
import { createStore } from '../store.js'
import { startFakeHub, startProxy } from './agent-proxy-helpers.mjs'

// RED test: POST /v1/todo-tune is handled LOCALLY in every hub mode. agent/proxy.js must not forward it (it is not in HUB_ACTIONS): the model
// is this app's, not the hub's. Today the local router does not know the route (404), so the proxy answers unknown-action.
const queueWith = (tune) => createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}), tuner: { tune } })

for (const mode of ['hub', 'degraded', 'standalone']) {
  test('in ' + mode + ' mode todo-tune is answered by this instance and the hub is not asked', async (t) => {
    const hub = await startFakeHub(t)
    const asked = []
    const queue = queueWith(async (text) => { asked.push(text); return { ok: true, text: 'TUNED ' + text } })
    const p = await startProxy(t, { mode, hub, queue })
    const res = await p.post('/v1/todo-tune', { text: 'fix it' })
    assert.deepEqual([res.status, res.json], [200, { ok: true, text: 'TUNED fix it' }])
    assert.deepEqual(asked, ['fix it'])
    assert.deepEqual(hub.requests, [], 'nothing went to the hub')
  })
}

test('with the hub gone the tune still works, and the hub is not blamed (it was never asked)', async (t) => {
  const queue = queueWith(async (text) => ({ ok: true, text: 'T ' + text }))
  const p = await startProxy(t, { mode: 'hub', hubUrl: 'http://127.0.0.1:1', queue })
  const res = await p.post('/v1/todo-tune', { text: 'x' })
  assert.deepEqual([res.status, res.json], [200, { ok: true, text: 'T x' }])
  assert.deepEqual(p.reports, [])
})

test('the local limits apply in hub mode too: an empty text is a 400 and the hub does not hear of it; /v1/todo is still forwarded', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { mode: 'hub', hub, queue: queueWith(async () => ({ ok: true, text: 'x' })) })
  const empty = await p.post('/v1/todo-tune', { text: '' })
  assert.deepEqual([empty.status, empty.json], [400, { ok: false, error: 'empty' }])
  assert.deepEqual(hub.requests, [])
  await p.post('/v1/todo', { text: 'still goes to the hub' })
  assert.deepEqual(hub.requests.map((r) => r.url), ['/review-queue/v1/todo'])
})
