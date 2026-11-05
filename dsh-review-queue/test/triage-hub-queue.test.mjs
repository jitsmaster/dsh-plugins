import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createHubQueue } from '../agent/hub-queue.js'
import { createRouter } from '../server.js'

// Triage is this app's own (rules file, log, memory): the hub-mode queue must pass it to the local service, whatever the mode.
const METHODS = ['triageRules', 'triageRuleMode', 'triageEnabled', 'triageReview', 'triageForget']

function make(connected) {
  const calls = []
  const local = {
    snapshot: () => ({ snapshotId: 'L', open: [], resolved: [], triage: { enabled: false }, aiReport: { total: 3, handled: 2, overruled: 1, text: 't', to: 9 }, secret: 'local-only' }),
    onChange: () => () => {}, stop: () => ({ ok: true }), uiState: () => ({ seq: 0 }),
  }
  for (const m of METHODS) local[m] = (...args) => { calls.push([m, args]); return { ok: true, from: m } }
  const client = {
    state: connected ? 'connected' : 'stopped',
    mirror: { ready: connected, snapshot: () => (connected ? { snapshotId: 'e:1', open: [], resolved: [] } : undefined), workspaces: () => [], onChange: () => () => {} },
    onState: () => () => {}, call: async () => { throw new Error('triage must never go to the hub') },
  }
  return { queue: createHubQueue({ local, client, speaker: { speak: () => ({ ok: true }), stop() {} }, controllerOf: () => ({}) }), calls }
}

for (const connected of [true, false]) {
  test(`triage methods delegate to the local service (${connected ? 'hub connected' : 'degraded'})`, async () => {
    const { queue, calls } = make(connected)
    const args = { triageRules: [], triageRuleMode: ['r1', 'auto', { confirmed: true }], triageEnabled: [false], triageReview: ['i1', { review: 'ok' }], triageForget: ['l1'] }
    for (const m of METHODS) {
      assert.equal(typeof queue[m], 'function', m + ' exists')
      assert.deepEqual(await queue[m](...args[m]), { ok: true, from: m })
    }
    assert.deepEqual(calls, METHODS.map((m) => [m, args[m]]))
  })

  test(`the snapshot carries the local triage and aiReport fields, nothing else of local (${connected ? 'hub connected' : 'degraded'})`, () => {
    const { queue } = make(connected)
    const snap = queue.snapshot()
    assert.deepEqual(snap.triage, { enabled: false })
    assert.equal(snap.aiReport.total, 3)
    if (connected) assert.equal(snap.snapshotId !== 'L' && snap.secret === undefined, true)
  })
}

test('the router answers a triage action over the hub-mode queue (not 500 internal)', async () => {
  const { queue, calls } = make(true)
  const handle = createRouter({ queue })
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ enabled: false }))]), { method: 'POST', url: '/v1/triage-enabled', headers: { 'content-type': 'application/json' } })
  let code, out
  const res = { destroyed: false, writeHead: (c) => { code = c }, end: (b) => { out = b }, once() {}, on() {} }
  await handle(req, res)
  assert.equal(code, 200, String(out))
  assert.deepEqual(calls, [['triageEnabled', [false]]])
})
