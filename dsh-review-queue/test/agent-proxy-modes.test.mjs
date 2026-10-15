// agent/proxy.js outside hub mode (docs/hub.md 10): the local service answers exactly as server.js does, the snapshot carries the notice,
// a lost hub still shows the last known list of the other apps read-only, modes switch live, and driveModeFromClient maps the agent client.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { driveModeFromClient } from '../agent/proxy.js'
import { hubItem, hubSnap, sleep, startFakeHub, startProxy, tokenOf } from './agent-proxy-helpers.mjs'
import { waitFor } from './hub-helpers.mjs'

const STANDALONE = /^Phone sync is off: hub not running \((.+)\)\. This app shows only its own items\.$/

test('starting: the instance answers from its own items without any notice and does not touch the hub', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { mode: 'starting', hub })
  const own = p.own()
  const snap = await p.snap()
  assert.deepEqual(snap.open.map((i) => i.id), [own.id])
  assert.equal(snap.notice, undefined)
  assert.equal((await p.post('/v1/reviewed', { id: own.id })).status, 200)
  assert.deepEqual(hub.requests, [])
})

test('standalone: today\'s server.js answers on the own items, the snapshot carries the notice with the reason, the hub is not asked', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { mode: 'standalone', reason: 'port 47615 is taken by another program', hub })
  const own = p.own()
  const snap = await p.snap()
  assert.deepEqual(snap.open.map((i) => [i.id, i.position]), [[own.id, 1]])
  assert.ok(snap.open[0].spoken.headline)
  assert.deepEqual(snap.notice, { level: 'warn', text: 'Phone sync is off: hub not running (port 47615 is taken by another program). This app shows only its own items.' })
  assert.deepEqual((await p.get('/v1/workspaces')).json, { workspaces: p.queue.workspaces() })
  assert.equal((await p.post('/v1/reviewed', { id: own.id })).status, 200)
  assert.equal((await p.post('/v1/reviewed', { id: own.id })).status, 409)
  assert.equal((await p.post('/v1/nope', {})).status, 404)
  assert.equal((await fetch(p.base + '/v1/reviewed')).status, 405)
  assert.deepEqual(hub.requests, [])
})

test('the reason in the notice is one short plain line, and a missing one says unknown', async (t) => {
  const p = await startProxy(t, { mode: 'standalone', reason: 'line one\nline two ' + 'x'.repeat(300) })
  const text = (await p.snap()).notice.text
  assert.match(text, STANDALONE)
  assert.equal(text.includes('\n'), false)
  assert.ok(text.length < 260)
  p.proxy.setMode('standalone')
  assert.match((await p.snap()).notice.text, /\(unknown\)/)
})

test('standalone long poll works on the local stamp: unchanged while nothing happens, woken by a local change', async (t) => {
  const p = await startProxy(t, { mode: 'standalone', reason: 'x' })
  const snap = await p.snap()
  assert.deepEqual((await p.get('/v1/snapshot?since=' + encodeURIComponent(tokenOf(snap)))).json, { unchanged: true, snapshotId: snap.snapshotId })
  const quiet = await p.get('/v1/snapshot?wait=100&since=' + encodeURIComponent(tokenOf(snap)))
  assert.equal(quiet.json.unchanged, true)
  const started = Date.now()
  const pending = p.get('/v1/snapshot?wait=5000&since=' + encodeURIComponent(tokenOf(snap)))
  await sleep(50)
  p.own()
  const woke = await pending
  assert.ok(Date.now() - started < 3000)
  assert.equal(woke.json.open.length, 1)
})

test('degraded: the notice says the hub is unreachable and the own items keep working', async (t) => {
  const p = await startProxy(t, { mode: 'degraded', reason: 'poll failed' })
  const own = p.own()
  const snap = await p.snap()
  assert.match(snap.notice.text, /^Phone sync is off: hub unreachable\./)
  assert.equal(snap.notice.level, 'warn')
  assert.equal((await p.post('/v1/deny', { id: own.id })).status, 200)
  assert.deepEqual(p.calls, [['deny', own.id]])
})

test('degraded: the last known items of the other apps follow the own ones, read-only, with their positions continuing', async (t) => {
  const theirs = [hubItem(1), hubItem(2)]
  const mirrored = hubSnap('E:9', theirs, { resolved: [hubItem(3, { status: 'resolved', resolution: { kind: 'reviewed' } })] })
  const p = await startProxy(t, { mode: 'degraded', reason: 'x', mirror: () => mirrored })
  const own = p.own()
  const snap = await p.snap()
  assert.deepEqual(snap.open.map((i) => [i.id, i.position]), [[own.id, 1], [theirs[0].id, 2], [theirs[1].id, 3]])
  assert.deepEqual(snap.open.slice(1).map((i) => i.ownerState), ['gone', 'gone'])
  assert.match(snap.open[2].spoken.headline, /3/, 'the spoken position was recomputed for the merged list')
  assert.deepEqual(snap.resolved.map((i) => i.id), [mirrored.resolved[0].id])
})

test('degraded: an own item that is also in the last hub list is shown once, from the local store', async (t) => {
  const p = await startProxy(t, { mode: 'degraded', reason: 'x', mirror: () => hubSnap('E:9', [hubItem(1)]) })
  const own = p.own()
  const mirrored = hubSnap('E:9', [hubItem(1), hubItem(2, { id: own.id, owner: 'aaaa1111' })])
  p.proxy.setMode('degraded', 'x2')
  const q = await startProxy(t, { mode: 'degraded', reason: 'x', mirror: () => mirrored, queue: p.queue })
  assert.deepEqual((await q.snap()).open.map((i) => i.id), [own.id, hubItem(1).id])
})

test('degraded: acting on an item of another app is a 409 owner-offline and nothing runs; the own item still works', async (t) => {
  const theirs = hubItem(1)
  const p = await startProxy(t, { mode: 'degraded', reason: 'x', mirror: () => hubSnap('E:9', [theirs]) })
  const own = p.own()
  for (const kind of ['approve', 'deny', 'reviewed', 'reply', 'answer']) {
    const res = await p.post('/v1/' + kind, { id: theirs.id, text: 'hi', answers: [{ id: 'q', selected: ['A'] }] })
    assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'owner-offline' }], kind)
  }
  assert.deepEqual(p.calls, [])
  assert.equal((await p.post('/v1/reviewed', { id: own.id })).status, 200)
})

test('the mode API: getMode, getReason, setMode, and onModeChange that only fires on a real change and can be removed', async (t) => {
  const p = await startProxy(t, { mode: 'starting' })
  const heard = []
  const off = p.proxy.onModeChange((mode, reason) => heard.push([mode, reason]))
  assert.deepEqual([p.proxy.getMode(), p.proxy.getReason()], ['starting', undefined])
  assert.equal(p.proxy.setMode('standalone', 'no node'), true)
  assert.equal(p.proxy.setMode('standalone', 'no node'), false)
  assert.equal(p.proxy.setMode('standalone', 'no node either'), true)
  assert.equal(p.proxy.setMode('hub'), true)
  assert.equal(p.proxy.setMode('nonsense'), false)
  assert.deepEqual([p.proxy.getMode(), p.proxy.getReason()], ['hub', undefined])
  off()
  p.proxy.setMode('degraded')
  assert.deepEqual(heard, [['standalone', 'no node'], ['standalone', 'no node either'], ['hub', undefined]])
})

test('the snapshot id differs per mode and reason, so an overlay holding a token never sits on a stale notice', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, hubSnap('E:5')]
  const p = await startProxy(t, { mode: 'hub', hub })
  const ids = [(await p.snap()).snapshotId]
  p.proxy.setMode('standalone', 'a'); ids.push((await p.snap()).snapshotId)
  p.proxy.setMode('standalone', 'b'); ids.push((await p.snap()).snapshotId)
  p.proxy.setMode('degraded'); ids.push((await p.snap()).snapshotId)
  assert.equal(new Set(ids).size, 4)
  assert.equal(ids[0], 'E:5')
})

test('hub to degraded while the overlay waits: the poll is answered at once with the notice and the hub request is dropped', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = (rec) => (rec.url.includes('since') ? new Promise(() => {}) : [200, hubSnap('E:5')])
  const p = await startProxy(t, { mode: 'hub', hub })
  const own = p.own()
  const token = tokenOf(await p.snap())
  const started = Date.now()
  const pending = p.get('/v1/snapshot?wait=8000&since=' + encodeURIComponent(token))
  await waitFor(() => hub.requests.length === 2, 3000, 'poll at the hub')
  p.proxy.setMode('degraded', 'lost')
  const res = await pending
  assert.ok(Date.now() - started < 3000)
  assert.match(res.json.notice.text, /hub unreachable/)
  assert.deepEqual(res.json.open.map((i) => i.id), [own.id])
  await waitFor(() => hub.aborted.length === 1, 3000, 'hub request dropped')
})

test('standalone to hub while the overlay waits: it is answered with the hub snapshot', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, hubSnap('E:7', [hubItem(1), hubItem(2)])]
  const p = await startProxy(t, { mode: 'standalone', reason: 'x', hub })
  const token = tokenOf(await p.snap())
  const pending = p.get('/v1/snapshot?wait=8000&since=' + encodeURIComponent(token))
  await sleep(60)
  p.proxy.setMode('hub')
  const res = await pending
  assert.deepEqual([res.json.snapshotId, res.json.open.length, res.json.notice], ['E:7', 2, undefined])
})

function fakeClient(state = 'connecting', ready = false) {
  const stateListeners = new Set()
  const mirrorListeners = new Set()
  const c = {
    state, mirror: { ready, onChange: (l) => { mirrorListeners.add(l); return () => mirrorListeners.delete(l) } },
    onState: (l) => { stateListeners.add(l); return () => stateListeners.delete(l) },
    set(next, isReady = c.mirror.ready) { c.state = next; c.mirror.ready = isReady; for (const l of [...stateListeners]) l(next); for (const l of [...mirrorListeners]) l() },
  }
  return c
}
const modeOf = (p) => [p.proxy.getMode(), p.proxy.getReason()]

test('driveModeFromClient: hub once connected and the mirror is ready, degraded when the hub is lost, hub again on return', async (t) => {
  const p = await startProxy(t, { mode: 'starting' })
  const client = fakeClient('connecting')
  const off = driveModeFromClient(p.proxy, client)
  assert.deepEqual(modeOf(p), ['starting', undefined])
  client.set('connected', false)
  assert.equal(p.proxy.getMode(), 'starting', 'connected but the mirror is not ready yet')
  client.set('connected', true)
  assert.equal(p.proxy.getMode(), 'hub')
  client.set('connected', false)
  assert.equal(p.proxy.getMode(), 'degraded', 'the mirror lost the hub before the client noticed')
  client.set('degraded', false)
  assert.equal(p.proxy.getMode(), 'degraded')
  client.set('connecting', false)
  assert.equal(p.proxy.getMode(), 'degraded')
  client.set('connected', true)
  assert.equal(p.proxy.getMode(), 'hub')
  off()
  client.set('degraded', false)
  assert.equal(p.proxy.getMode(), 'hub', 'removed')
})

test('driveModeFromClient: a client that never reached the hub does not make it degraded; a newer hub or a newer app means standalone with the reason', async (t) => {
  const p = await startProxy(t, { mode: 'starting' })
  const client = fakeClient('connecting')
  driveModeFromClient(p.proxy, client)
  client.set('degraded', false)
  assert.equal(p.proxy.getMode(), 'starting')
  client.set('upgrade-required', false)
  assert.deepEqual(modeOf(p), ['standalone', 'hub is newer, restart DSH'])
  client.set('superseded', false)
  assert.deepEqual(modeOf(p), ['standalone', 'a newer window of this app took over'])
})

test('two overlays polling at once each get their own answer', async (t) => {
  const p = await startProxy(t, { mode: 'standalone', reason: 'x' })
  const snap = await p.snap()
  const one = p.get('/v1/snapshot?wait=5000&since=' + encodeURIComponent(tokenOf(snap)))
  const two = p.get('/v1/snapshot?wait=5000&since=' + encodeURIComponent(tokenOf(snap)))
  const stale = await p.get('/v1/snapshot?wait=5000&since=' + encodeURIComponent('old|||0'))
  assert.equal(stale.json.open.length, 0)
  await sleep(50)
  p.own()
  const [a, b] = await Promise.all([one, two])
  assert.deepEqual([a.json.open.length, b.json.open.length], [1, 1])
})
