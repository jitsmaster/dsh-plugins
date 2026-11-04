import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createExecutor } from '../agent/executor.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { TIMEOUT_MS } from '../hub/commands.js'
import { postJson } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'
import { startPhoneHub } from './hub-device-helpers.mjs'
import { startFakeHub, startProxy } from './agent-proxy-helpers.mjs'

// "Follow handoff" on a done card through the hub (the phone has no local queue): the same path as archive / reply.
//   agent/proxy.js HUB_ACTIONS has '/v1/follow-handoff'; agent/hub-queue.js followHandoff(id) -> action('follow-handoff', { id }); agent/executor.js runs it as queue.followHandoff(itemId);
//   hub/routing.js OWNER_ACTIONS['follow-handoff'] = true; hub/commands.js has a timeout for it (a session is spawned: 60 s); hub/http.js DEVICE_ACTIONS lets a paired phone send it and audits it.
const REPLY = 'Handoff written to `D:\\secret\\dir\\a-handoff.md`'
const completed = (over = {}) => ({ type: 'completed', sessionId: 's1', workspace: 'D:/w', payload: { reply: REPLY }, ...over })

test('the instance proxy forwards /v1/follow-handoff to the hub like any action (it is a hub action)', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, { ok: true, sessionId: 'n1' }]
  const p = await startProxy(t, { hub })
  const res = await p.post('/v1/follow-handoff', { id: 'x' })
  assert.deepEqual([res.status, res.json], [200, { ok: true, sessionId: 'n1' }])
  assert.deepEqual(hub.requests.map((r) => [r.method, r.url, r.body]), [['POST', '/review-queue/v1/follow-handoff', { id: 'x' }]])
})

test('the hub queue sends followHandoff to the hub when connected and answers locally otherwise', async () => {
  const calls = []
  const local = new Proxy({ onChange: () => () => {}, followHandoff: (id) => { calls.push(['local', id]); return { ok: true, from: 'local' } } }, { get: (t, k) => (k in t ? t[k] : () => ({ ok: true })) })
  const client = {
    state: 'connected', calls: [],
    mirror: { ready: true, snapshot: () => ({ snapshotId: 'e:1', open: [], resolved: [] }), workspaces: () => [], onChange: () => () => {} },
    onState: () => () => {},
    call: async (kind, body) => { client.calls.push([kind, body]); return { ok: true, from: 'hub' } },
  }
  const queue = createHubQueue({ local, client, speaker: { speak: () => ({ ok: true }), stop() {} }, controllerOf: () => ({}), now: () => 5000 })
  assert.equal(typeof queue.followHandoff, 'function', 'hub-queue.js exports followHandoff')
  assert.deepEqual(await queue.followHandoff('a'), { ok: true, from: 'hub' })
  assert.deepEqual(client.calls, [['follow-handoff', { id: 'a' }]])
  client.state = 'degraded'
  assert.deepEqual(await queue.followHandoff('a'), { ok: true, from: 'local' })
  assert.deepEqual(calls, [['local', 'a']])
})

test('the executor runs the follow-handoff command as queue.followHandoff(itemId) and answers with its result', async () => {
  const calls = []
  const queue = { followHandoff: async (id) => { calls.push(id); return { ok: true, sessionId: 'n2' } } }
  const executor = createExecutor({ queue, adapter: { adopt: () => ({ ok: true }), applyRemote: () => ({ ok: true }) } })
  assert.deepEqual(await executor.execute({ cid: 'c1', seq: 1, kind: 'follow-handoff', itemId: 'i4', args: {} }), { ok: true, sessionId: 'n2' })
  assert.deepEqual(calls, ['i4'])
})

test('a spawned session takes a while: the hub waits 60 s for follow-handoff', () => {
  assert.equal(TIMEOUT_MS['follow-handoff'], 60_000)
})

async function twoAgents(t, over = {}) {
  const ctx = await startHub(t, over)
  const a = agentOf(ctx.port)
  const b = agentOf(ctx.port, { id: 'bbbb2222', key: 'k2', label: 'DSH :2' })
  await a.register({ sync: sync({ workspaces: [{ id: 'w1', title: 'alpha', path: 'D:/a' }] }) })
  await b.register({ sync: sync({ workspaces: [{ id: 'w1', title: 'beta', path: 'D:/b' }] }) })
  return { ...ctx, a, b }
}
async function viaAgent(agent, port, kind, body, result) {
  const pending = postJson(port, P + '/v1/' + kind, body)
  const got = await agent.poll(0, 3000)
  const cmd = got.json.commands[0]
  if (cmd && result) await agent.result(cmd.cid, result)
  return { res: await pending, cmd }
}

test('the hub routes follow-handoff to the app that owns the item, as the command of that name, and returns what the app says', async (t) => {
  const { port, a, b } = await twoAgents(t)
  await a.send(a.add(1, completed()))
  const { res, cmd } = await viaAgent(a, port, 'follow-handoff', { id: a.itemId(1) }, { ok: true, sessionId: 'n3' })
  assert.deepEqual([res.status, res.json], [200, { ok: true, sessionId: 'n3' }])
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args], ['follow-handoff', a.itemId(1), {}])
  assert.deepEqual((await b.poll(0, 0)).json.commands, [])
})

test('follow-handoff is an owner action: an unknown item is not-found and a closed one not-open, before anything is sent', async (t) => {
  const { port, a } = await twoAgents(t)
  await a.send(a.add(1, completed()), { op: 'resolve', id: a.itemId(1), resolution: { kind: 'reviewed' } })
  const gone = await postJson(port, P + '/v1/follow-handoff', { id: 'nope' })
  assert.deepEqual([gone.status, gone.json], [409, { ok: false, error: 'not-found' }])
  const closed = await postJson(port, P + '/v1/follow-handoff', { id: a.itemId(1) })
  assert.deepEqual([closed.status, closed.json], [409, { ok: false, error: 'not-open' }])
  assert.deepEqual((await a.poll(0, 0)).json.commands, [])
})

test('a paired phone may follow a handoff; the hub log has an audit line with the device and the item id and never a path', async (t) => {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: sync({ workspaces: [{ id: 'w1', title: 'alpha', path: 'D:/a' }] }) })
  await a.post('presence', { desktopActive: true })
  const p = await h.pairPhone()
  await a.send(a.add(1, completed()))
  const pending = p.call('POST', P + '/v1/follow-handoff', { id: a.itemId(1), confirmed: true, path: 'D:\\secret\\evil.md' })
  const cmd = (await a.poll(0, 3000)).json.commands[0]
  assert.equal(cmd?.kind, 'follow-handoff', 'a phone is not refused with 403 desktop-only / 404')
  assert.deepEqual(cmd.args, {}, 'nothing of the phone body but the id travels')
  await a.result(cmd.cid, { ok: true, sessionId: 'n4' })
  assert.deepEqual([(await pending).status, (await pending).json], [200, { ok: true, sessionId: 'n4' }])
  const lines = h.logs.filter((l) => l.startsWith('follow-handoff'))
  assert.deepEqual(lines, ['follow-handoff: device ' + p.deviceId + ' item ' + a.itemId(1), 'follow-handoff-result: device ' + p.deviceId + ' item ' + a.itemId(1) + ' ok n4'])
  assert.ok(!h.logs.join('\n').includes('secret'), 'no path in the hub log')
})

test('the audit line cuts a hostile item id to safe characters', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  await p.call('POST', P + '/v1/follow-handoff', { id: 'x\nforged: line ' + 'y'.repeat(200) })
  const lines = h.logs.filter((l) => l.startsWith('follow-handoff'))
  assert.equal(lines.length, 2, 'the request line and the result line')
  for (const l of lines) { assert.doesNotMatch(l, /[\r\n]/); assert.ok(l.length < 200) }
})

test('the phone action list has follow-handoff and still never open-session', () => {
  const http = readFileSync(new URL('../hub/http.js', import.meta.url), 'utf8')
  const m = /const DEVICE_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(http)
  const actions = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  assert.ok(actions.includes('follow-handoff'))
  assert.ok(!actions.includes('open-session'))
})

test('a phone follow-handoff without confirmed is needs-confirm: nothing is sent to the app; with confirmed it goes through', async (t) => {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: sync({ workspaces: [{ id: 'w1', title: 'alpha', path: 'D:/a' }] }) })
  await a.post('presence', { desktopActive: true })
  const p = await h.pairPhone()
  await a.send(a.add(1, completed()))
  for (const body of [{ id: a.itemId(1) }, { id: a.itemId(1), confirmed: 'true' }, { id: a.itemId(1), confirmed: false }]) {
    const res = await p.call('POST', P + '/v1/follow-handoff', body)
    assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'needs-confirm' }])
  }
  assert.deepEqual((await a.poll(0, 0)).json.commands, [], 'no command was queued')
  const pending = p.call('POST', P + '/v1/follow-handoff', { id: a.itemId(1), confirmed: true })
  const cmd = (await a.poll(0, 3000)).json.commands[0]
  assert.equal(cmd?.kind, 'follow-handoff')
  await a.result(cmd.cid, { ok: true, sessionId: 'n5' })
  assert.deepEqual([(await pending).status, (await pending).json], [200, { ok: true, sessionId: 'n5' }])
})

test('the desktop follows a handoff without any confirm', async (t) => {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: sync({ workspaces: [{ id: 'w1', title: 'alpha', path: 'D:/a' }] }) })
  await a.send(a.add(1, completed()))
  const { res, cmd } = await viaAgent(a, h.port, 'follow-handoff', { id: a.itemId(1) }, { ok: true, sessionId: 'n6' })
  assert.deepEqual([res.status, res.json], [200, { ok: true, sessionId: 'n6' }])
  assert.equal(cmd.kind, 'follow-handoff')
  assert.deepEqual(h.logs.filter((l) => l.startsWith('follow-handoff')), [], 'only a phone leaves an audit line')
})

test('the result audit line has the error code on a failure, an id-safe session id only, and never a path', async (t) => {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: sync({ workspaces: [{ id: 'w1', title: 'alpha', path: 'D:/a' }] }) })
  await a.post('presence', { desktopActive: true })
  const p = await h.pairPhone()
  await a.send(a.add(1, completed()), a.add(2, completed({ sessionId: 's2' })))
  const run = async (n, result) => {
    const pending = p.call('POST', P + '/v1/follow-handoff', { id: a.itemId(n), confirmed: true })
    const cmd = (await a.poll(0, 3000)).json.commands[0]
    await a.result(cmd.cid, result)
    await pending
  }
  await run(1, { ok: false, error: 'follow-busy', path: 'D:\\secret\\x.md' })
  await run(2, { ok: true, sessionId: 'bad id/with\\D:\\secret' })
  const results = h.logs.filter((l) => l.startsWith('follow-handoff-result'))
  assert.equal(results[0], 'follow-handoff-result: device ' + p.deviceId + ' item ' + a.itemId(1) + ' follow-busy')
  assert.equal(results[1], 'follow-handoff-result: device ' + p.deviceId + ' item ' + a.itemId(2) + ' ok', 'an unsafe session id is left out')
  assert.ok(!h.logs.join('\n').includes('secret'))
})

test('the phone page asks to confirm before following a handoff and retries with confirmed: true', () => {
  const views = readFileSync(new URL('../lib/mobile/views.js', import.meta.url), 'utf8')
  const row = views.split('\n').find((l) => l.includes('Follow handoff</button>'))
  assert.ok(row, 'the button is there')
  assert.doesNotMatch(row, /act\('\/v1\/follow-handoff'/, 'the button does not act directly')
  assert.match(views, /Open a new session that resumes this handoff and archive this one\?/)
  assert.match(views, /act\('\/v1\/follow-handoff', \{ id: item\.id, confirmed: true \}/)
  assert.match(views, /confirmLabel="Follow handoff"/)
})