// The overlay's workspace list in hub mode: the app first makes sure the hub has its current workspaces (a bounded wait), then asks the hub; the log
// says when the hub lists none, once per change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeHub, startProxy } from './agent-proxy-helpers.mjs'

const list = (n) => [200, { workspaces: Array.from({ length: n }, (_, i) => ({ id: 'bbbb/w' + i, title: 't' + i })) }]

test('the app has the hub updated before it asks for the list, and the answer is the hub list', async (t) => {
  const hub = await startFakeHub(t)
  const events = []
  hub.respond = (rec) => { events.push('hub ' + rec.url); return list(2) }
  const api = await startProxy(t, { hub, refreshWorkspaces: async () => { events.push('refresh') } })
  const res = await api.get('/v1/workspaces')
  assert.deepEqual([res.status, res.json.workspaces.length], [200, 2])
  assert.deepEqual(events, ['refresh', 'hub /review-queue/v1/workspaces'])
})

test('a refresh that never answers does not hold the overlay back', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => list(1)
  const api = await startProxy(t, { hub, refreshWorkspaces: () => new Promise(() => {}), workspaceSyncMs: 40 })
  const res = await api.get('/v1/workspaces')
  assert.deepEqual([res.status, res.json.workspaces.length], [200, 1])
})

test('a refresh that fails does not fail the request', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => list(1)
  const api = await startProxy(t, { hub, refreshWorkspaces: async () => { throw new Error('boom') } })
  assert.equal((await api.get('/v1/workspaces')).status, 200)
})

test('other modes answer from the local service and do not refresh', async (t) => {
  let refreshed = 0
  const api = await startProxy(t, { mode: 'standalone', reason: 'x', refreshWorkspaces: async () => { refreshed++ } })
  assert.deepEqual((await api.get('/v1/workspaces')).json, { workspaces: [] })
  assert.equal(refreshed, 0)
})

test('the log says when the hub lists no workspace, once, and again when it lists some', async (t) => {
  const hub = await startFakeHub(t)
  const lines = []
  let n = 0
  hub.respond = () => list(n)
  const api = await startProxy(t, { hub, log: (line) => lines.push(line) })
  await api.get('/v1/workspaces')
  await api.get('/v1/workspaces')
  n = 2
  await api.get('/v1/workspaces')
  await api.get('/v1/workspaces')
  assert.deepEqual(lines.filter((l) => /workspaces/.test(l)), ['workspaces: the hub lists none', 'workspaces: the hub lists 2'])
})
