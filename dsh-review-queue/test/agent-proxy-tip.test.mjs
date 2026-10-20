import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReviewQueue } from '../service.js'
import { createStore } from '../store.js'
import { hubItem, hubSnap, sleep, startFakeHub, startProxy } from './agent-proxy-helpers.mjs'

// In hub mode the hub does not know the tip (it belongs to the local app): the proxy adds the local service's tip to the snapshot it serves to the
// desktop panel, only when the merged list is empty, and forwards the numbers part of the long-poll token to the hub.
const TIP = { id: 't1', title: 'Bloom filters', body: 'A Bloom filter is a bit array. It never has false negatives.', category: 'algorithms', at: 1, source: 'builtin' }
function localQueue(tip = TIP, { own = true } = {}) {
  let onChange = () => {}
  const tips = { asked: 0, tip: tip ?? undefined, current() { tips.asked++; return tips.tip }, peek: () => tips.tip, onChange: (l) => { onChange = l; return () => {} }, fire: () => onChange() }
  const store = createStore()
  // An item of its own keeps the service's snapshot from asking for a tip itself: only the proxy's explicit tip() call does (as with the hub queue).
  if (own) store.add({ type: 'completed', sessionId: 'own', summary: 'x', payload: {} })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => undefined, tips, speaker: { speak: () => ({ ok: true }), stop() {} } })
  return { queue, tips }
}

const TIPQ = '?tip=1'
const snapOf = async (p, q = TIPQ) => (await p.get('/v1/snapshot' + q)).json

test('hub list empty: the snapshot carries the local tip next to the hub numbers', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, hubSnap('E:5', [], { sessions: { working: 2, open: 7 } })]
  const { queue, tips } = localQueue()
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:5', []) })
  const snap = await snapOf(p)
  assert.equal(snap.tip.id, 't1')
  assert.deepEqual(snap.sessions, { working: 2, open: 7 })
  assert.ok(tips.asked >= 1)
})

test('without tip=1 (overlay closed) there is no tip and the generator is not asked, even with an empty list', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, hubSnap('E:5', [])]
  const { queue, tips } = localQueue()
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:5', []) })
  const snap = await snapOf(p, '')
  assert.ok(!('tip' in snap))
  assert.equal(tips.asked, 0)
})

test('hub list not empty: no tip, and the generator is never asked (no model call for a busy list)', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, hubSnap('E:5', [hubItem(1)])]
  const { queue, tips } = localQueue()
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:5', [hubItem(1)]) })
  const snap = await snapOf(p)
  assert.ok(!('tip' in snap))
  assert.equal(tips.asked, 0)
})

test('read-tip stays with this app: the local service answers, the hub is not asked', async (t) => {
  const hub = await startFakeHub(t)
  const { queue } = localQueue()
  const p = await startProxy(t, { hub, queue })
  assert.deepEqual((await p.post('/v1/read-tip', { id: 't1' })).json, { ok: true })
  assert.equal((await p.post('/v1/read-tip', { id: 'zzz' })).status, 409)
  assert.deepEqual(hub.requests, [])
  assert.equal((await p.snap()).reading, 'tip:t1')
})

test('the numbers part of the token and the watch flag go to the hub; the tip part stays here', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, { unchanged: true, snapshotId: 'E:5' }]
  const { queue } = localQueue()
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:5', []) })
  await p.get('/v1/snapshot?wait=0&tip=1&since=' + encodeURIComponent('E:5|||0|1/2|t1'))
  const q = new URL('http://x' + hub.requests[0].url).searchParams
  assert.equal(q.get('since'), 'E:5|||0|1/2')
  assert.equal(q.get('watch'), '1', 'the hub learns that somebody looks (an open overlay)')
  await p.get('/v1/snapshot?wait=0&since=' + encodeURIComponent('E:5|||0|1/2|'))
  assert.equal(new URL('http://x' + hub.requests[1].url).searchParams.get('watch'), null, 'a closed overlay does not say it')
})

test('a tip that becomes ready while the hub says unchanged is delivered at once', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = async (rec) => {
    if (!new URL('http://x' + rec.url).searchParams.has('since')) return [200, hubSnap('E:5', [], { sessions: { working: 1, open: 2 } })]
    await sleep(300)
    return [200, { unchanged: true, snapshotId: 'E:5' }]
  }
  const { queue, tips } = localQueue(null)
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:5', []) })
  const first = await snapOf(p)
  assert.ok(!('tip' in first), 'no tip yet')
  const started = Date.now()
  const pending = p.get('/v1/snapshot?wait=5000&tip=1&since=' + encodeURIComponent('E:5|||0|1/2|'))
  await sleep(60)
  tips.tip = TIP
  tips.fire()
  const res = await pending
  assert.equal(res.status, 200)
  assert.equal(res.json.tip.id, 't1')
  assert.ok(Date.now() - started < 3000)
})

test('the same token while nothing changed is answered unchanged by the hub, tip included in the token', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = (rec) => (new URL('http://x' + rec.url).searchParams.has('since') ? [200, { unchanged: true, snapshotId: 'E:5' }] : [200, hubSnap('E:5', [])])
  const { queue } = localQueue()
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:5', []) })
  await snapOf(p)
  const res = await p.get('/v1/snapshot?wait=0&tip=1&since=' + encodeURIComponent('E:5|||0||t1'))
  assert.deepEqual(res.json, { unchanged: true, snapshotId: 'E:5' })
})

test('a token of an old page (four parts) is still answered unchanged while a tip exists', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, { unchanged: true, snapshotId: 'E:5' }]
  const { queue } = localQueue()
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:5', []) })
  const res = await p.get('/v1/snapshot?wait=0&tip=1&since=' + encodeURIComponent('E:5|||0'))
  assert.equal(res.json.unchanged, true)
})

test('the tip disappears when the list fills: the hub answers the changed list in full, without a tip, and a tip being read stops', async (t) => {
  const hub = await startFakeHub(t)
  let calls = 0
  hub.respond = () => (calls++ === 0 ? [200, hubSnap('E:5', [])] : [200, hubSnap('E:6', [hubItem(1)])])
  const { queue } = localQueue()
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:5', []) })
  assert.equal((await snapOf(p)).tip.id, 't1')
  assert.deepEqual((await p.post('/v1/read-tip', { id: 't1' })).json, { ok: true })
  const res = await p.get('/v1/snapshot?wait=0&tip=1&since=' + encodeURIComponent('E:5|||0||t1'))
  assert.equal(res.json.snapshotId, 'E:6')
  assert.ok(!('tip' in res.json))
  assert.equal(res.json.reading, undefined, 'the reading of the tip ended with the empty list')
})

test('one source decides: a lagging mirror (empty) while the hub list is not does not cause back-to-back full snapshots', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = (rec) => (new URL('http://x' + rec.url).searchParams.has('since') ? [200, { unchanged: true, snapshotId: 'E:6' }] : [200, hubSnap('E:6', [hubItem(1)])])
  const { queue } = localQueue()
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:5', []) }) // the mirror still shows the old, empty list
  const full = (await p.get('/v1/snapshot?tip=1')).json
  assert.ok(!('tip' in full))
  const token = encodeURIComponent('E:6|||0||')
  for (let i = 0; i < 3; i++) assert.equal((await p.get('/v1/snapshot?wait=0&tip=1&since=' + token)).json.unchanged, true)
  assert.equal(hub.requests.filter((r) => !new URL('http://x' + r.url).searchParams.has('since')).length, 1, 'one full fetch only')
})

test('one source decides: a lagging mirror (not empty) while the hub list is empty still gives the tip and then waits', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = (rec) => (new URL('http://x' + rec.url).searchParams.has('since') ? [200, { unchanged: true, snapshotId: 'E:7' }] : [200, hubSnap('E:7', [])])
  const { queue } = localQueue()
  const p = await startProxy(t, { hub, queue, mirror: () => hubSnap('E:6', [hubItem(1)]) })
  const full = (await p.get('/v1/snapshot?tip=1')).json
  assert.equal(full.tip.id, 't1', 'the live hub answer decides')
  const token = encodeURIComponent('E:7|||0||t1')
  for (let i = 0; i < 3; i++) assert.equal((await p.get('/v1/snapshot?wait=0&tip=1&since=' + token)).json.unchanged, true)
  assert.equal(hub.requests.filter((r) => !new URL('http://x' + r.url).searchParams.has('since')).length, 1)
})

test('standalone and degraded: the local snapshot carries the local tip only for tip=1', async (t) => {
  const hub = await startFakeHub(t)
  for (const mode of ['standalone', 'degraded']) {
    const { queue } = localQueue(TIP, { own: false })
    const p = await startProxy(t, { hub, queue, mode, reason: 'x' })
    assert.ok(!('tip' in (await snapOf(p, ''))), mode)
    assert.equal((await snapOf(p)).tip.id, 't1', mode)
  }
})
