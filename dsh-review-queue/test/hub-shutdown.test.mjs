// POST /hub/v1/shutdown (docs/hub.md 8.2/8.3): the agent secret asks the hub to end itself; used by a strictly newer plugin ("upgrade").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postJson, raw, waitFor } from './hub-helpers.mjs'
import { SECRET, startHub } from './hub-agent-helpers.mjs'

const auth = { authorization: 'Bearer ' + SECRET }
const post = (port, body, headers = auth) => postJson(port, '/hub/v1/shutdown', body, headers)

test('the agent secret shuts the hub down: 200 first, then onShutdown hears the reason', async (t) => {
  const calls = []
  const { port } = await startHub(t, { onShutdown: (reason) => calls.push(reason) })
  const res = await post(port, { reason: 'upgrade' })
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  await waitFor(() => calls.length === 1, 2000, 'onShutdown')
  assert.deepEqual(calls, ['upgrade'])
})

test('no secret, a wrong secret or a proxied request never shuts the hub down', async (t) => {
  const calls = []
  const { port } = await startHub(t, { onShutdown: (reason) => calls.push(reason) })
  assert.equal((await post(port, { reason: 'upgrade' }, {})).status, 401)
  assert.equal((await post(port, { reason: 'upgrade' }, { authorization: 'Bearer ' + 'X'.repeat(43) })).status, 401)
  assert.equal((await post(port, { reason: 'upgrade' }, { ...auth, 'x-forwarded-for': '100.1.2.3' })).status, 401)
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(calls, [])
})

test('only POST, and the reason is optional but must be a short word', async (t) => {
  const calls = []
  const { port } = await startHub(t, { onShutdown: (reason) => calls.push(reason) })
  assert.equal((await raw({ port, path: '/hub/v1/shutdown', headers: auth })).status, 405)
  assert.equal((await post(port, { reason: 'x'.repeat(200) })).status, 400)
  assert.equal((await post(port, { reason: 'upgrade' }, { ...auth, origin: 'http://evil.example' })).status, 403)
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(calls, [])
  const res = await post(port, {})
  assert.equal(res.status, 200)
  await waitFor(() => calls.length === 1, 2000, 'onShutdown')
  assert.deepEqual(calls, ['requested'])
})

test('a shutdown that names another hub (a restart that already happened) is refused and the new hub keeps running', async (t) => {
  const calls = []
  const { hub, port } = await startHub(t, { onShutdown: (reason) => calls.push(reason) })
  const res = await post(port, { reason: 'upgrade', hubId: 'some-other-hub' })
  assert.deepEqual([res.status, res.json.error], [409, 'wrong-hub'])
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(calls, [])
  assert.equal((await post(port, { reason: 'upgrade', hubId: hub.hubId })).status, 200)
  await waitFor(() => calls.length === 1, 2000, 'onShutdown')
})
