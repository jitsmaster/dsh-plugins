import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AWAY_MS } from '../hub/instances.js'
import { raw, postJson } from './hub-helpers.mjs'
import { P, SECRET, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

const snapshot = async (port) => (await raw({ port, path: P + '/v1/snapshot' })).json

// ---- auth and protocol ---------------------------------------------------------------------------------------------------------

test('the agent API needs the secret: a wrong or missing one is 401, and so is a proxied request that has the right one', async (t) => {
  const { port } = await startHub(t)
  const path = '/hub/v1/agent/commands?instanceId=aaaa1111'
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'Basic ' + SECRET }, { authorization: 'Bearer ' + SECRET.slice(1) }, { authorization: 'Bearer ' + SECRET + 'x' }]) {
    const res = await raw({ port, path, headers: { 'x-rq-protocol': '1', ...headers } })
    assert.deepEqual([res.status, res.json], [401, { error: 'auth-required' }], JSON.stringify(headers))
  }
  const proxied = await raw({ port, path, headers: { authorization: 'Bearer ' + SECRET, 'x-rq-protocol': '1', 'x-forwarded-for': '100.64.0.9' } })
  assert.equal(proxied.status, 401)
})

test('an agent of an older protocol, or one that sends none, gets 426 upgrade-required on every route; this protocol and newer are served', async (t) => {
  const { port } = await startHub(t, { protocol: 3 })
  for (const protocol of [1, undefined]) {
    const a = agentOf(port, { protocol })
    const res = await a.register()
    assert.deepEqual([res.status, res.json], [426, { error: 'upgrade-required', protocol: 3 }], String(protocol))
    assert.equal((await a.poll()).status, 426)
    assert.equal((await a.ops([])).status, 426)
  }
  for (const protocol of [2, 3, 4]) assert.equal((await agentOf(port, { protocol }).register()).status, 200, String(protocol))
})

test('only POST registers and only GET polls; unknown agent routes are 404', async (t) => {
  const { port } = await startHub(t)
  const a = agentOf(port)
  assert.equal((await raw({ port, path: '/hub/v1/agent/register', headers: a.headers })).status, 405)
  assert.equal((await postJson(port, '/hub/v1/agent/commands', {}, a.headers)).status, 405)
  assert.equal((await a.post('nothing')).status, 404)
  assert.equal((await postJson(port, '/hub/v1/agent/register', {}, { ...a.headers, origin: 'https://evil.example' })).status, 403)
})

// ---- register, sync ------------------------------------------------------------------------------------------------------------

test('register answers with the hub id, the protocol and the last applied op, and the instance is online', async (t) => {
  const { hub, port } = await startHub(t)
  const res = await agentOf(port).register({ pid: 7, pluginVersion: '0.1.0' })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.deepEqual([res.json.hubId, res.json.protocol, res.json.lastOp], [hub.hubId, hub.protocol, 0])
  assert.deepEqual([hub.instances.get('aaaa1111').state, hub.instances.get('aaaa1111').label], ['online', 'DSH :1'])
})

test('an unusable instance id is 400, and an instance that was replaced by a restart cannot register again', async (t) => {
  const { port } = await startHub(t)
  assert.deepEqual((await agentOf(port, { id: 'x' }).register()).json, { ok: false, error: 'bad-instance' })
  const old = agentOf(port)
  const fresh = agentOf(port, { id: 'cccc3333' })
  assert.equal((await old.register()).status, 200)
  assert.equal((await fresh.register()).status, 200)
  const again = await old.register()
  assert.deepEqual([again.status, again.json], [409, { ok: false, error: 'superseded' }])
})

test('a request from an instance that never registered is 409 unknown-instance', async (t) => {
  const { port } = await startHub(t)
  const a = agentOf(port)
  for (const res of [await a.send(a.add(1)), await a.poll(), await a.post('sync', { sync: sync() }), await a.post('presence', {}), await a.result('c1', { ok: true }), await a.post('bye')]) {
    assert.deepEqual([res.status, res.json.error], [409, 'unknown-instance'])
  }
})

test('a resync after a gap is a full owner view: new items, resolutions, workspaces and the op counter', async (t) => {
  const { hub, port } = await startHub(t)
  const a = agentOf(port)
  await a.register()
  const res = await a.post('sync', { sync: sync({ n: 9, openItems: [a.add(1).item], workspaces: [{ id: 'w1', title: 'alpha', path: 'D:/a' }], sessionIds: ['s1'] }) })
  assert.deepEqual([res.status, res.json.ok, res.json.lastOp], [200, true, 9])
  assert.equal(hub.store.get(a.itemId(1)).owner, 'aaaa1111')
  assert.deepEqual(hub.instances.get('aaaa1111').workspaces.map((x) => x.id), ['w1'])
  assert.equal((await a.send(a.add(2))).status, 200, 'the counter goes on after the sync value')
})

// ---- ops -----------------------------------------------------------------------------------------------------------------------

test('ops are applied in order, owned by the instance, and acknowledged with the last n', async (t) => {
  const { hub, port } = await startHub(t)
  const a = agentOf(port)
  await a.register()
  const res = await a.send(a.add(1), a.add(2, { sessionTitle: 'Two' }))
  assert.deepEqual([res.status, res.json.ok, res.json.ack], [200, true, 2])
  assert.deepEqual(res.json.results, [{ n: 1, ok: true }, { n: 2, ok: true }])
  assert.deepEqual(hub.store.list().map((i) => [i.id, i.owner]), [[a.itemId(1), 'aaaa1111'], [a.itemId(2), 'aaaa1111']])
  assert.equal(hub.instances.get('aaaa1111').lastOp, 2)
})

test('a repeated batch is acknowledged without being applied twice', async (t) => {
  const { hub, port } = await startHub(t)
  const a = agentOf(port)
  await a.register()
  const ops = [{ n: 1, ...a.add(1) }, { n: 2, op: 'update', id: a.itemId(1), patch: { summary: 's' } }]
  await a.ops(ops)
  const rev = hub.store.rev
  const again = await a.ops(ops)
  assert.deepEqual([again.status, again.json.ack, again.json.results.map((r) => r.duplicate)], [200, 2, [true, true]])
  assert.equal(hub.store.rev, rev)
})

test('a gap in the op numbers is 409 resync-needed and applies nothing after the gap', async (t) => {
  const { hub, port } = await startHub(t)
  const a = agentOf(port)
  await a.register()
  await a.send(a.add(1))
  const res = await a.ops([{ n: 3, ...a.add(3) }])
  assert.deepEqual([res.status, res.json.error, res.json.ack], [409, 'resync-needed', 1])
  assert.equal(hub.store.get(a.itemId(3)), undefined)
})

test('item ids are <instance short>-<12 hex>; anything else is refused and a clash with another instance is 409 id-conflict', async (t) => {
  const { hub, port } = await startHub(t)
  const a = agentOf(port, { id: 'abcd1111' })
  const b = agentOf(port, { id: 'abcd2222', key: 'k2' })
  await a.register(); await b.register()
  const bad = await a.send({ op: 'add', item: { id: 'zzzz-0123456789ab', type: 'completed' } }, { op: 'add', item: { id: 'abcd-nothex', type: 'completed' } }, { op: 'add', item: { type: 'completed' } })
  assert.deepEqual(bad.json.results.map((r) => r.error), ['bad-id', 'bad-id', 'bad-id'])
  await a.send(a.add(1))
  const clash = await b.send({ op: 'add', item: { id: a.itemId(1), type: 'completed' } })
  assert.deepEqual([clash.status, clash.json.error, clash.json.ack], [409, 'id-conflict', 1])
  assert.equal(hub.store.get(a.itemId(1)).owner, 'abcd1111')
})

test('createdAt from the agent is clamped to [now - 24 h, now]', async (t) => {
  const { hub, port, clock } = await startHub(t)
  const a = agentOf(port)
  await a.register()
  const now = clock.now()
  await a.send(a.add(1, { createdAt: now - 48 * 3600 * 1000 }), a.add(2, { createdAt: now + 3600_000 }), a.add(3, { createdAt: now - 5000 }))
  assert.deepEqual([1, 2, 3].map((n) => hub.store.get(a.itemId(n)).createdAt), [now - 24 * 3600 * 1000, now, now - 5000])
})

test('the first resolve wins, and a late update of a resolved item still applies', async (t) => {
  const { hub, port } = await startHub(t)
  const a = agentOf(port)
  await a.register()
  await a.send(a.add(1, { type: 'question' }))
  hub.store.resolve(a.itemId(1), { kind: 'session-ended', by: 'hub' })
  const res = await a.send({ op: 'resolve', id: a.itemId(1), resolution: { kind: 'answered' } }, { op: 'update', id: a.itemId(1), patch: { summary: 'late summary' } })
  assert.deepEqual(res.json.results.map((r) => r.error), ['not-open', undefined])
  assert.equal(hub.store.get(a.itemId(1)).resolution.kind, 'session-ended')
  assert.equal(hub.store.get(a.itemId(1)).summary, 'late summary')
})

test('reopen, resolveSession and retitle ops work for the owner and cannot touch another instance', async (t) => {
  const { hub, port } = await startHub(t)
  const a = agentOf(port)
  const b = agentOf(port, { id: 'bbbb2222', key: 'k2' })
  await a.register(); await b.register()
  await a.send(a.add(1, { sessionId: 'shared', sessionTitle: 'old' }), a.add(2, { sessionId: 'shared', sessionTitle: 'old' }))
  await b.send(b.add(1, { sessionId: 'shared', sessionTitle: 'old' }))
  await a.send({ op: 'retitle', sessionId: 'shared', title: 'new' })
  assert.deepEqual([a.itemId(1), a.itemId(2), b.itemId(1)].map((id) => hub.store.get(id).sessionTitle), ['new', 'new', 'old'])
  await a.send({ op: 'resolveSession', sessionId: 'shared', resolution: { kind: 'session-ended' } })
  assert.deepEqual([a.itemId(1), a.itemId(2), b.itemId(1)].map((id) => hub.store.get(id).status), ['resolved', 'resolved', 'open'])
  const res = await a.send({ op: 'reopen', id: a.itemId(1) }, { op: 'reopen', id: b.itemId(1) }, { op: 'resolve', id: b.itemId(1), resolution: {} })
  assert.deepEqual(res.json.results.map((r) => r.error), [undefined, 'not-owner', 'not-owner'])
})

test('an unknown op and a malformed batch are refused without breaking the counter', async (t) => {
  const { port } = await startHub(t)
  const a = agentOf(port)
  await a.register()
  assert.deepEqual((await a.send({ op: 'explode' })).json.results, [{ n: 1, ok: false, error: 'bad-op' }])
  assert.equal((await a.post('ops', { ops: 'nope' })).status, 400)
  assert.equal((await a.post('ops', {})).status, 400)
})

// ---- what the others see -------------------------------------------------------------------------------------------------------

test('the snapshot says who owns an item and in what state that owner is, and a state change refreshes waiting readers', async (t) => {
  const { hub, port, clock } = await startHub(t)
  const a = agentOf(port)
  await a.register()
  await a.send(a.add(1))
  hub.store.applyOp({ op: 'add', item: { type: 'completed', sessionId: 'old', payload: {} } }, {})
  let snap = await snapshot(port)
  assert.deepEqual(snap.open.map((i) => [i.ownerLabel, i.ownerState]), [['DSH :1', 'online'], [undefined, 'gone']])
  const before = snap.snapshotId
  clock.advance(AWAY_MS + 1000)
  hub.instances.tick()
  snap = await snapshot(port)
  assert.notEqual(snap.snapshotId, before)
  assert.equal(snap.open[0].ownerState, 'away')
})

test('a hub restart forgets nobody: the agent registers again with a sync and every item is still there', async (t) => {
  const first = await startHub(t)
  const a = agentOf(first.port)
  await a.register()
  await a.send(a.add(1, { type: 'question' }), a.add(2))
  await first.hub.stop()
  const second = await startHub(t, { dir: first.dir })
  const b = agentOf(second.port)
  b.n = 2
  assert.equal((await b.send(b.add(3))).json.error, 'unknown-instance')
  const res = await b.register({ sync: sync({ n: 2, openItems: [a.add(1, { type: 'question' }).item, a.add(2).item] }) })
  assert.deepEqual([res.status, res.json.lastOp, res.json.ended], [200, 2, 0])
  b.n = 2
  assert.equal((await b.send(b.add(3))).status, 200)
  assert.deepEqual(second.hub.store.list({ status: 'open' }).map((i) => i.id), [a.itemId(1), a.itemId(2), a.itemId(3)])
})

test('presence and bye: presence marks the desktop active, bye ends the questions of the instance at once', async (t) => {
  const { hub, port } = await startHub(t)
  const a = agentOf(port)
  await a.register()
  await a.send(a.add(1, { type: 'question' }), a.add(2))
  assert.deepEqual((await a.post('presence', { desktopActive: true })).json, { ok: true, watch: false }) // watch: does anybody look at the session numbers (hub.md 6.7a)
  assert.equal(typeof hub.instances.get('aaaa1111').lastDesktopActiveAt, 'number')
  assert.deepEqual((await a.post('bye')).json, { ok: true })
  assert.deepEqual([hub.store.get(a.itemId(1)).status, hub.store.get(a.itemId(2)).status], ['resolved', 'open'])
  assert.equal((await a.poll()).status, 409)
})

test('a long poll that is open keeps the instance online and is answered when a command arrives', async (t) => {
  const { hub, port, clock } = await startHub(t)
  const a = agentOf(port)
  await a.register()
  await a.send(a.add(1))
  const waiting = a.poll(0, 5000)
  await new Promise((r) => setTimeout(r, 80))
  clock.advance(AWAY_MS * 2)
  hub.instances.tick()
  assert.equal(hub.instances.get('aaaa1111').state, 'online')
  const done = postJson(port, P + '/v1/reply', { id: a.itemId(1), text: 'hi' })
  const res = await waiting
  assert.deepEqual([res.status, res.json.commands.map((c) => c.kind)], [200, ['reply']])
  await a.result(res.json.commands[0].cid, { ok: true })
  assert.equal((await done).status, 200)
})

test('a long poll with nothing queued ends empty at its wait time, and is answered 503 when the hub stops', async (t) => {
  const { hub, port } = await startHub(t)
  const a = agentOf(port)
  await a.register()
  const quiet = await a.poll(0, 150)
  assert.deepEqual([quiet.status, quiet.json.commands], [200, []])
  const waiting = a.poll(0, 20_000)
  await new Promise((r) => setTimeout(r, 100))
  await hub.stop()
  const res = await waiting
  assert.deepEqual([res.status, res.json], [503, { error: 'shutting-down' }])
})
