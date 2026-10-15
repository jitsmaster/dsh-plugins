// The workspace list an app reports to the hub follows the DSH registry: a change is sent by the next check, and an overlay that is about to list the
// workspaces can have the change sent first (syncWorkspaces). An unchanged list costs no request.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentClient } from '../agent/client.js'
import { createExecutor } from '../agent/executor.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { waitFor } from './hub-helpers.mjs'
import { SECRET, startHub } from './hub-agent-helpers.mjs'

const FAST = { backoff: { minMs: 10, maxMs: 40 }, waitMs: 400 }
const ws = (id, title) => ({ id, title, path: 'D:/' + title, sessionIds: [] })

function setup(t, port, over = {}) {
  const counts = {}
  const countingFetch = async (url, init) => { const name = new URL(url).pathname.split('/').pop(); counts[name] = (counts[name] ?? 0) + 1; return fetch(url, init) }
  const adapter = createStoreAdapter({ instanceId: 'aaaa1111' })
  const client = createAgentClient({ baseUrl: 'http://127.0.0.1:' + port, secret: SECRET, instanceKey: 'k1', instanceId: 'aaaa1111', label: 'DSH :1', adapter, executor: createExecutor({ queue: {}, adapter }), fetch: countingFetch, ...FAST, ...over })
  t.after(() => client.stop({ bye: false }))
  return { client, counts }
}
const titlesAt = (hub) => hub.instances.get('aaaa1111').workspaces.map((w) => w.title)
const connected = (client) => waitFor(() => client.state === 'connected', 8000, 'connected')

test('a workspace that appears in the registry after register reaches the hub with the next check, with no session change', async (t) => {
  const { hub, port } = await startHub(t)
  let list = []
  const { client } = setup(t, port, { workspaces: () => list, sessionCheckMs: 20 })
  client.start()
  await connected(client)
  assert.deepEqual(titlesAt(hub), [])
  list = [ws('w1', 'alpha')]
  await waitFor(() => titlesAt(hub).includes('alpha'), 3000, 'the workspace at the hub')
})

test('a renamed workspace is sent too', async (t) => {
  const { hub, port } = await startHub(t)
  let list = [ws('w1', 'alpha')]
  const { client } = setup(t, port, { workspaces: () => list, sessionCheckMs: 20 })
  client.start()
  await connected(client)
  list = [ws('w1', 'alpha two')]
  await waitFor(() => titlesAt(hub).includes('alpha two'), 3000, 'the new title at the hub')
})

test('an unchanged workspace list is not sent again before the slow heartbeat', async (t) => {
  const { port } = await startHub(t)
  const { client, counts } = setup(t, port, { workspaces: () => [ws('w1', 'alpha')], sessionCheckMs: 15, resyncEveryMs: 10_000 })
  client.start()
  await connected(client)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(counts.sync ?? 0, 0)
})

test('syncWorkspaces sends a changed list at once and answers after the hub has it; an unchanged list sends nothing', async (t) => {
  const { hub, port } = await startHub(t)
  let list = [ws('w1', 'alpha')]
  const { client, counts } = setup(t, port, { workspaces: () => list, sessionCheckMs: 60_000 })
  client.start()
  await connected(client)
  await client.syncWorkspaces()
  assert.equal(counts.sync ?? 0, 0, 'nothing changed: no request')
  list = [ws('w1', 'alpha'), ws('w2', 'beta')]
  await client.syncWorkspaces()
  assert.deepEqual(titlesAt(hub), ['alpha', 'beta'])
  assert.equal(counts.sync, 1)
})

test('syncWorkspaces on a client that is not connected answers at once and sends nothing', async (t) => {
  const { port } = await startHub(t)
  const { client, counts } = setup(t, port, { workspaces: () => [ws('w1', 'alpha')] })
  await client.syncWorkspaces()
  assert.deepEqual(counts, {})
})

test('the log says how many workspaces were reported when the list changes, never what they are called', async (t) => {
  const { port } = await startHub(t)
  const lines = []
  let list = [ws('w1', 'SENTINEL-TITLE')]
  const { client } = setup(t, port, { workspaces: () => list, sessionCheckMs: 20, log: (l) => lines.push(l) })
  client.start()
  await connected(client)
  list = [ws('w1', 'SENTINEL-TITLE'), ws('w2', 'beta')]
  await waitFor(() => lines.includes('workspaces reported: 2'), 3000, 'the log line')
  assert.deepEqual(lines.filter((l) => /workspaces/.test(l)), ['workspaces reported: 1', 'workspaces reported: 2'])
  assert.equal(lines.some((l) => l.includes('SENTINEL')), false)
})
