import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { startFakeHub, startProxy } from './agent-proxy-helpers.mjs'

// Pause all and quit (POST /v1/pause-all) and Quit (POST /v1/quit): service methods over a power = { canQuit, pauseSessions, quitSoon }.
function setup({ canQuit = true, pause = { ok: true, paused: 2 }, scan } = {}) {
  const calls = []
  const power = {
    canQuit: async () => { calls.push('canQuit'); return canQuit },
    pauseSessions: async () => { calls.push('pause'); if (pause instanceof Error) throw pause; return pause },
    quitSoon: () => { calls.push('quit') },
  }
  const paused = { scan: async () => { calls.push('scan'); if (scan instanceof Error) throw scan; return { ok: true } }, markHandled() {} }
  const queue = createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}), power, paused })
  return { queue, calls }
}

test('pauseAll checks for a desktop first, pauses, lists the paused sessions, then quits, in that order', async () => {
  const { queue, calls } = setup()
  assert.deepEqual(await queue.pauseAll(), { ok: true, paused: 2, quitting: true })
  assert.deepEqual(calls, ['canQuit', 'pause', 'scan', 'quit'])
})

test('pauseAll with no desktop to close pauses nothing and quits nothing', async () => {
  const { queue, calls } = setup({ canQuit: false })
  assert.deepEqual(await queue.pauseAll(), { ok: false, error: 'no-desktop' })
  assert.deepEqual(calls, ['canQuit'])
})

test('pauseAll that fails to pause does not quit; a failing list scan does not stop the quit', async () => {
  const bad = setup({ pause: { ok: false, error: 'no-controller' } })
  assert.deepEqual(await bad.queue.pauseAll(), { ok: false, error: 'no-controller' })
  assert.ok(!bad.calls.includes('quit'))
  const thrown = setup({ pause: new Error('boom') })
  const r = await thrown.queue.pauseAll()
  assert.equal(r.ok, false)
  assert.match(r.error, /boom/)
  assert.ok(!thrown.calls.includes('quit'))
  const scanBroke = setup({ scan: new Error('x') })
  assert.equal((await scanBroke.queue.pauseAll()).ok, true)
  assert.ok(scanBroke.calls.includes('quit'))
})

test('quitApp only quits (no pausing), and not without a desktop', async () => {
  const a = setup()
  assert.deepEqual(await a.queue.quitApp(), { ok: true, quitting: true })
  assert.deepEqual(a.calls, ['canQuit', 'quit'])
  const b = setup({ canQuit: false })
  assert.deepEqual(await b.queue.quitApp(), { ok: false, error: 'no-desktop' })
  assert.deepEqual(b.calls, ['canQuit'])
})

test('an app without power says so', async () => {
  const queue = createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}) })
  assert.deepEqual(await queue.pauseAll(), { ok: false, error: 'no-power' })
  assert.deepEqual(await queue.quitApp(), { ok: false, error: 'no-power' })
})

test('the routes: 200 with the result, 409 with the reason', async (t) => {
  for (const [opts, expected] of [[{}, [200, { ok: true, paused: 2, quitting: true }]], [{ canQuit: false }, [409, { ok: false, error: 'no-desktop' }]]]) {
    const { queue } = setup(opts)
    const server = createServer(createRouter({ queue }))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    t.after(() => new Promise((r) => server.close(r)))
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/v1/pause-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.deepEqual([res.status, await res.json()], expected)
  }
})

test('through the proxy both routes are answered by this app in every hub mode; the hub is never asked', async (t) => {
  for (const mode of ['hub', 'degraded', 'standalone']) {
    const hub = await startFakeHub(t)
    const { queue } = setup()
    const p = await startProxy(t, { mode, hub, queue })
    const a = await p.post('/v1/pause-all', {})
    assert.deepEqual([a.status, a.json], [200, { ok: true, paused: 2, quitting: true }], mode)
    const b = await p.post('/v1/quit', {})
    assert.deepEqual([b.status, b.json], [200, { ok: true, quitting: true }], mode)
    assert.deepEqual(hub.requests, [], mode + ': nothing went to the hub')
  }
})
