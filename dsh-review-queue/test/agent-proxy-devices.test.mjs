// The instance route of the devices page: /review-queue/v1/pairing-code and /v1/devices* forward to the hub's /hub/v1/* as the desktop role
// (the user passed DSH's own login to get here). Without a hub there is nothing to pair with.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OWN, SECRET, startFakeHub, startProxy } from './agent-proxy-helpers.mjs'

const call = async (p, method, path, body) => {
  const res = await fetch(p.base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

test('a pairing code is asked from the hub as the desktop; its answer comes back as it is', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, { ok: true, code: 'ABCD-EFGH', url: 'https://x/review-queue/m/#/pair' }]
  const p = await startProxy(t, { hub })
  const res = await call(p, 'POST', '/v1/pairing-code', {})
  assert.deepEqual([res.status, res.json.code], [200, 'ABCD-EFGH'])
  const r = hub.requests[0]
  assert.deepEqual([r.method, r.url], ['POST', '/hub/v1/pairing-codes'])
  assert.deepEqual([r.headers.authorization, r.headers['x-rq-role'], r.headers['x-rq-instance']], ['Bearer ' + SECRET, 'desktop', OWN])
})

test('the device list, rename and revoke go to the hub paths of the same names', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { hub })
  assert.equal((await call(p, 'GET', '/v1/devices')).status, 200)
  assert.equal((await call(p, 'PATCH', '/v1/devices/dv_0123456789ab', { name: 'Tablet' })).status, 200)
  assert.equal((await call(p, 'POST', '/v1/devices/dv_0123456789ab/revoke', {})).status, 200)
  assert.deepEqual(hub.requests.map((r) => [r.method, r.url, r.body]), [
    ['GET', '/hub/v1/devices', undefined],
    ['PATCH', '/hub/v1/devices/dv_0123456789ab', { name: 'Tablet' }],
    ['POST', '/hub/v1/devices/dv_0123456789ab/revoke', {}],
  ])
})

test('the status and code of a hub refusal are kept', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [404, { error: 'unknown-device' }]
  const p = await startProxy(t, { hub })
  const res = await call(p, 'POST', '/v1/devices/dv_000000000000/revoke', {})
  assert.deepEqual([res.status, res.json], [404, { error: 'unknown-device' }])
})

test('without a working hub (standalone, starting, degraded, unreachable) the answer is 503 hub-unavailable and nothing is invented locally', async (t) => {
  for (const mode of ['standalone', 'starting', 'degraded']) {
    const hub = await startFakeHub(t)
    const p = await startProxy(t, { hub, mode })
    const res = await call(p, 'GET', '/v1/devices')
    assert.deepEqual([res.status, res.json], [503, { error: 'hub-unavailable' }], mode)
    assert.equal(hub.requests.length, 0)
  }
  const dead = await startProxy(t, { hubUrl: 'http://127.0.0.1:1' })
  assert.deepEqual((await call(dead, 'POST', '/v1/pairing-code', {})).json, { error: 'hub-unavailable' })
  assert.equal(dead.reports.length, 1, 'the unreachable hub is reported like for every other call')
})

test('only the exact routes are forwarded: odd ids, other paths and wrong methods are not', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { hub })
  assert.equal((await call(p, 'POST', '/v1/devices/..%2Fagent/revoke', {})).status, 404)
  assert.equal((await call(p, 'GET', '/v1/devices/dv_0123456789ab/secret')).status, 404)
  assert.equal((await call(p, 'DELETE', '/v1/devices')).status, 405)
  assert.equal((await call(p, 'GET', '/v1/pairing-code')).status, 405)
  assert.equal((await call(p, 'GET', '/v1/devices/dv_0123456789ab/revoke')).status, 405)
  assert.equal(hub.requests.length, 0)
})

test('a body that is not JSON is refused here and never reaches the hub', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { hub })
  const res = await fetch(p.base + '/v1/devices/dv_0123456789ab', { method: 'PATCH', headers: { 'content-type': 'text/plain' }, body: 'x' })
  assert.equal(res.status, 415)
  assert.equal(hub.requests.length, 0)
})
