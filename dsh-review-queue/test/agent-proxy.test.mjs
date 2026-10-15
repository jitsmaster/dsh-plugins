// agent/proxy.js in hub mode (docs/hub.md 5.1, 6.1, D7): the instance's /review-queue/v1/* forwards to the hub with the agent secret, keeps the
// overlay's URL layout and error mapping, answers read/stop/ui/focus itself, merges this instance's focus/reading/ui into the hub's snapshot,
// and hangs up on the hub when the overlay goes away.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROTOCOL } from '../hub/protocol.js'
import { OWN, SECRET, hubItem, hubSnap, sleep, startFakeHub, startProxy, tokenOf } from './agent-proxy-helpers.mjs'
import { waitFor, freePort } from './hub-helpers.mjs'

test('an action goes to the hub with the agent secret, the desktop role and this instance; the hub answer comes back as it is', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, { ok: true, count: 2 }]
  const p = await startProxy(t, { hub })
  const res = await p.post('/v1/approve', { id: 'x', confirmed: true }, { 'content-type': 'application/json', origin: 'http://127.0.0.1:64047' })
  assert.deepEqual([res.status, res.json], [200, { ok: true, count: 2 }])
  assert.equal(hub.requests.length, 1)
  const r = hub.requests[0]
  assert.deepEqual([r.method, r.url], ['POST', '/review-queue/v1/approve'])
  assert.equal(r.headers.authorization, 'Bearer ' + SECRET)
  assert.equal(r.headers['x-rq-role'], 'desktop')
  assert.equal(r.headers['x-rq-instance'], OWN)
  assert.equal(r.headers['x-rq-protocol'], String(PROTOCOL))
  assert.match(r.headers['content-type'], /^application\/json/)
  assert.equal(r.headers.origin, undefined, 'the browser Origin stays at the instance')
  assert.deepEqual(r.body, { id: 'x', confirmed: true })
})

test('every action of the overlay is forwarded under its own name', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { hub })
  const names = ['answer', 'late-answer', 'approve', 'deny', 'reviewed', 'archive', 'reply', 'reopen', 'approve-similar', 'todo', 'todo-confirm', 'todo-cancel']
  for (const name of names) assert.equal((await p.post('/v1/' + name, { id: 'x' })).status, 200, name)
  assert.deepEqual(hub.requests.map((r) => r.url), names.map((n) => '/review-queue/v1/' + n))
})

test('the refusals of the hub keep their status and code', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { hub })
  for (const [status, error] of [[409, 'not-open'], [400, 'needs-confirm'], [409, 'owner-offline'], [409, 'owner-away'], [504, 'owner-timeout'], [504, 'unknown-outcome'], [409, 'risky']]) {
    hub.respond = () => [status, { ok: false, error }]
    const res = await p.post('/v1/approve', { id: 'x' })
    assert.deepEqual([res.status, res.json], [status, { ok: false, error }])
  }
})

test('a bad body is refused before the hub hears of it: 415, 400, 413 like the standalone server', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { hub })
  assert.equal((await p.post('/v1/reviewed', { id: 'x' }, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await p.post('/v1/reviewed', '{nope')).status, 400)
  assert.equal((await p.post('/v1/reply', { id: 'x', text: 'y'.repeat(100_000) })).status, 413)
  assert.deepEqual(hub.requests, [])
})

test('a wrong method on an action is 405 and an unknown action is the local 404; the hub hears of neither', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { hub })
  assert.equal((await fetch(p.base + '/v1/reviewed')).status, 405)
  assert.equal((await fetch(p.base + '/v1/snapshot', { method: 'POST' })).status, 405)
  assert.equal((await fetch(p.base + '/v1/workspaces', { method: 'POST' })).status, 405)
  const unknown = await p.post('/v1/nope', {})
  assert.deepEqual([unknown.status, unknown.json], [404, { error: 'unknown-action' }])
  assert.deepEqual(hub.requests, [])
})

test('read, stop, ui and focus stay with this instance (D7): the local service answers, the hub is not asked', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { hub })
  const item = p.own()
  assert.equal((await p.post('/v1/focus', { id: item.id })).status, 200)
  assert.equal((await p.post('/v1/focus', { id: 'ghost' })).status, 409)
  assert.equal((await p.post('/v1/read', { id: item.id })).status, 200)
  assert.equal((await p.post('/v1/stop', {})).status, 200)
  assert.equal((await p.post('/v1/ui', { cmd: 'show' })).json.ok, true)
  assert.equal((await p.post('/v1/ui', { cmd: 'explode' })).status, 400)
  assert.deepEqual(hub.requests, [])
})

test('workspaces come from the hub, asked as this instance', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, { workspaces: [{ id: 'aaaa/w1', title: 'mine' }, { id: 'bbbb/w1', title: 'theirs (DSH :2)' }] }]
  const p = await startProxy(t, { hub })
  const res = await p.get('/v1/workspaces')
  assert.deepEqual(res.json.workspaces.map((w) => w.title), ['mine', 'theirs (DSH :2)'])
  assert.deepEqual([hub.requests[0].method, hub.requests[0].url, hub.requests[0].headers['x-rq-instance']], ['GET', '/review-queue/v1/workspaces', OWN])
})

test('the snapshot is the hub list with this instance focus, reading and ui merged in', async (t) => {
  const hub = await startFakeHub(t)
  const theirs = hubItem(1)
  hub.respond = () => [200, hubSnap('E:5', [theirs])]
  const p = await startProxy(t, { hub })
  const own = p.own()
  p.queue.setFocus(own.id)
  p.queue.read(own.id)
  p.queue.uiCommand('show')
  const snap = await p.snap()
  assert.deepEqual(snap.open.map((i) => i.id), [theirs.id], 'the items are the hub items, not the local ones')
  assert.equal(snap.snapshotId, 'E:5')
  assert.deepEqual([snap.focusId, snap.reading, snap.ui.cmd], [own.id, own.id, 'show'])
  assert.equal(snap.notice, undefined)
  assert.equal(hub.requests[0].url, '/review-queue/v1/snapshot')
})

test('a current token waits at the hub (asked with the hub id and the remaining wait) and answers unchanged', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = (rec) => (rec.url.includes('since') ? [200, { unchanged: true, snapshotId: 'E:5' }] : [200, hubSnap('E:5')])
  const p = await startProxy(t, { hub })
  const token = tokenOf(await p.snap())
  const res = await p.get('/v1/snapshot?wait=3000&since=' + encodeURIComponent(token))
  assert.deepEqual(res.json, { unchanged: true, snapshotId: 'E:5' })
  const asked = new URL('http://x' + hub.requests[1].url)
  assert.equal(asked.searchParams.get('since'), 'E:5|||0')
  assert.ok(Number(asked.searchParams.get('wait')) > 2000 && Number(asked.searchParams.get('wait')) <= 3000)
  const noWait = await p.get('/v1/snapshot?since=' + encodeURIComponent(token))
  assert.deepEqual(noWait.json, { unchanged: true, snapshotId: 'E:5' })
  assert.equal(new URL('http://x' + hub.requests[2].url).searchParams.get('wait'), '0')
})

test('visible=1 of the overlay is passed on to the hub', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, hubSnap()]
  const p = await startProxy(t, { hub })
  await p.get('/v1/snapshot?wait=0&visible=1')
  assert.equal(new URL('http://x' + hub.requests[0].url).searchParams.get('visible'), '1')
  await p.get('/v1/snapshot')
  assert.equal(new URL('http://x' + hub.requests[1].url).searchParams.get('visible'), null)
})

test('a token whose focus part is stale gets the full merged snapshot at once, without waiting at the hub', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, hubSnap('E:5')]
  const p = await startProxy(t, { hub })
  const own = p.own()
  p.queue.setFocus(own.id)
  const stale = 'E:5|||0'
  const res = await p.get('/v1/snapshot?wait=5000&since=' + encodeURIComponent(stale))
  assert.equal(res.json.focusId, own.id)
  assert.equal(hub.requests.length, 1)
  assert.equal(hub.requests[0].url, '/review-queue/v1/snapshot')
})

test('a change of the hub list passes through merged', async (t) => {
  const hub = await startFakeHub(t)
  let release
  const gate = new Promise((r) => { release = r })
  hub.respond = async (rec) => (rec.url.includes('since') ? (await gate, [200, hubSnap('E:6', [hubItem(1), hubItem(2)])]) : [200, hubSnap('E:5')])
  const p = await startProxy(t, { hub })
  const token = tokenOf(await p.snap())
  const pending = p.get('/v1/snapshot?wait=5000&since=' + encodeURIComponent(token))
  await sleep(50)
  release()
  const res = await pending
  assert.deepEqual([res.json.snapshotId, res.json.open.length], ['E:6', 2])
})

test('a local change (the overlay focuses an item) wakes a waiting poll at once and the hub request is dropped', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = (rec) => (rec.url.includes('since') ? new Promise(() => {}) : [200, hubSnap('E:5')])
  const p = await startProxy(t, { hub })
  const own = p.own()
  const token = tokenOf(await p.snap())
  const started = Date.now()
  const pending = p.get('/v1/snapshot?wait=8000&since=' + encodeURIComponent(token))
  await sleep(60)
  p.queue.setFocus(own.id)
  const res = await pending
  assert.ok(Date.now() - started < 3000)
  assert.equal(res.json.focusId, own.id)
  await waitFor(() => hub.aborted.length >= 1, 3000, 'the hub request hung up on')
})

test('when the overlay goes away the request to the hub is aborted', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = (rec) => (rec.url.includes('since') ? new Promise(() => {}) : [200, hubSnap('E:5')])
  const p = await startProxy(t, { hub })
  const token = tokenOf(await p.snap())
  const ac = new AbortController()
  const pending = fetch(p.base + '/v1/snapshot?wait=20000&since=' + encodeURIComponent(token), { signal: ac.signal }).catch(() => 'gone')
  await waitFor(() => hub.requests.length === 2, 3000, 'the poll reached the hub')
  ac.abort()
  assert.equal(await pending, 'gone')
  await waitFor(() => hub.aborted.length === 1 && hub.aborted[0].url.includes('since'), 3000, 'the hub poll aborted')
})

test('a hub nobody listens at: the request is answered locally with the notice and the failure is reported', async (t) => {
  const dead = 'http://127.0.0.1:' + (await freePort())
  const p = await startProxy(t, { hubUrl: dead })
  const own = p.own()
  const snap = await p.snap()
  assert.deepEqual(snap.open.map((i) => i.id), [own.id])
  assert.match(snap.notice.text, /^Phone sync is off: hub unreachable\./)
  assert.equal(snap.notice.level, 'warn')
  assert.equal(p.reports.length, 1)
  assert.equal(typeof p.reports[0], 'string')
  const approve = await p.post('/v1/deny', { id: own.id })
  assert.equal(approve.status, 200)
  assert.deepEqual(p.calls, [['deny', own.id]], 'an action on an own item ran locally')
})

test('a hub that answers 401, 426 or 503 counts as not reachable for this request', async (t) => {
  const hub = await startFakeHub(t)
  const p = await startProxy(t, { hub })
  p.own()
  for (const status of [401, 426, 503]) {
    hub.respond = () => [status, { error: 'nope' }]
    const snap = await p.snap()
    assert.equal(snap.open.length, 1, String(status))
    assert.ok(snap.notice, String(status))
  }
  assert.equal(p.reports.length, 3)
})

test('an action the hub took too long over is an unknown outcome (504) and is never repeated locally', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => new Promise(() => {})
  const p = await startProxy(t, { hub, timeoutMs: 150 })
  const own = p.own()
  const res = await p.post('/v1/deny', { id: own.id })
  assert.deepEqual([res.status, res.json], [504, { ok: false, error: 'unknown-outcome' }])
  assert.deepEqual(p.calls, [])
  assert.deepEqual(p.reports, [])
})

test('an answer of the hub that is not JSON is a 502 bad-gateway', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, '<html>proxy error</html>']
  const p = await startProxy(t, { hub })
  const res = await p.post('/v1/approve', { id: 'x' })
  assert.deepEqual([res.status, res.json], [502, { ok: false, error: 'bad-gateway' }])
})
