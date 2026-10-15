// Headline test of slice H2: one real hub and two fake apps, each built from the REAL agent client, store adapter, executor and hub
// queue over the REAL capture.js and service.js; only the DSH host (ctx, sessions) is faked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createAgentClient } from '../agent/client.js'
import { createExecutor } from '../agent/executor.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { installCapture } from '../capture.js'
import { AWAY_MS, GRACE_MS } from '../hub/instances.js'
import { createReviewQueue } from '../service.js'
import { postJson, raw, waitFor } from './hub-helpers.mjs'
import { P, SECRET, startHub } from './hub-agent-helpers.mjs'

const never = () => new Promise(() => {})
const PHONE = { 'x-test-role': 'device' }
const roleOf = (req) => req.headers['x-test-role'] ?? 'desktop'

/** One DSH app: local store file, real capture and service, real agent client, optional flaky network. */
function makeApp(t, { port, dir, clock, key, id, label, secret = SECRET, fetch: baseFetch = globalThis.fetch, workspaces = () => [] }) {
  const file = join(dir, 'local', key + '.json')
  const io = {
    read: () => { try { return readFileSync(file, 'utf8') } catch { return undefined } },
    write: (text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) },
  }
  const logs = []
  const net = { down: false, loseNextCommandResponse: false }
  const fetch = async (url, init) => {
    if (net.down) throw new TypeError('network down')
    const res = await baseFetch(url, init)
    if (net.loseNextCommandResponse && new URL(url).pathname.endsWith('/commands')) {
      const body = await res.clone().json()
      if (body.commands?.length) { net.loseNextCommandResponse = false; throw new TypeError('response lost') }
    }
    return res
  }
  const adapter = createStoreAdapter({ instanceId: id, io, now: clock.now })
  const summarizer = { summarize: async (reply) => ({ text: 'summary of ' + reply.slice(0, 12), source: 'test', title: 'Title ' + reply.slice(0, 6), actionable: true }) }
  const capture = installCapture({ on() {}, get: () => undefined }, { store: adapter, summarizer, log: (l) => logs.push(l) })
  const queue = createReviewQueue({ store: adapter, capture, controllerOf: () => ({}), now: clock.now })
  const executed = []
  const inner = createExecutor({ queue, adapter })
  const executor = { execute: (c) => { executed.push(c.kind); return inner.execute(c) } }
  const client = createAgentClient({ baseUrl: 'http://127.0.0.1:' + port, secret, instanceKey: key, instanceId: id, label, adapter, executor, workspaces, fetch, backoff: { minMs: 10, maxMs: 40 }, waitMs: 400, log: (l) => logs.push(l) })
  const hubQueue = createHubQueue({ local: queue, client, now: clock.now })
  t.after(() => client.stop({ bye: false }))
  let reply = ''
  const session = (sessionId) => ({ id: sessionId, devTitle: 'Title of ' + sessionId, session: { header: { cwd: 'D:/w' }, deriveMessages: () => [{ role: 'user', content: 'do it' }, { role: 'assistant', content: reply }] } })
  let calls = 0
  const app = {
    id, key, label, adapter, capture, queue, client, hubQueue, executed, logs, net, file,
    async completed(sessionId, text) { clock.advance(10); reply = text; await capture.handlers['agent/turn-stopping']({ agent: session(sessionId) }); return adapter.findOpen({ type: 'completed', sessionId }).id },
    async permission(sessionId, command = 'ls') {
      clock.advance(10)
      const callId = 'call-' + id + '-' + ++calls
      const agent = session(sessionId)
      await capture.handlers['tools/pre-execute']({ name: 'shell', callId, arguments: { command }, agent }, async () => ({}))
      const outcome = capture.handlers['approval/request']({ agent, toolName: 'shell', callId, signal: new AbortController().signal }, never)
      return { outcome, id: adapter.findOpen({ type: 'permission', sessionId }).id }
    },
    question(sessionId) {
      clock.advance(10)
      const callId = 'call-' + id + '-' + ++calls
      const outcome = capture.handlers['user-questions/request']({ agent: session(sessionId), questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }], signal: new AbortController().signal, wait: { callId } }, never)
      return { outcome, id: adapter.findOpen({ type: 'question', sessionId }).id }
    },
    drained: () => waitFor(() => adapter.outbox().length === 0, 8000, 'outbox of ' + label + ' drained'),
    connected: () => waitFor(() => client.state === 'connected', 8000, label + ' connected'),
  }
  return app
}
async function twoApps(t, over = {}) {
  const ctx = await startHub(t, { roleOf, ...over })
  const common = { port: ctx.port, dir: ctx.dir, clock: ctx.clock }
  const A = makeApp(t, { ...common, key: 'kA', id: 'aaaa1111', label: 'DSH :1', workspaces: () => [{ id: 'w1', title: 'alpha', path: 'D:/a' }] })
  const B = makeApp(t, { ...common, key: 'kB', id: 'bbbb2222', label: 'DSH :2', workspaces: () => [{ id: 'w1', title: 'beta', path: 'D:/b' }] })
  A.client.start(); B.client.start()
  await Promise.all([A.connected(), B.connected()])
  return { ...ctx, A, B, common }
}
const phone = (port, kind, body) => postJson(port, P + '/v1/' + kind, body, PHONE)
const openIds = (hub) => hub.store.list({ status: 'open' }).map((i) => i.id)

test('A and B add items: one global order, one numbering, the same list in the hub, the phone and both apps', async (t) => {
  const { hub, port, A, B } = await twoApps(t)
  const a1 = await A.completed('sa1', 'A is done with the first task')
  const b1 = B.question('sb1').id
  const a2 = (await A.permission('sa2')).id
  await Promise.all([A.drained(), B.drained()])
  await waitFor(() => hub.store.get(a1)?.title, 5000, 'late summary of a1')
  assert.deepEqual(openIds(hub), [a1, b1, a2])
  const snap = (await raw({ port, path: P + '/v1/snapshot' })).json
  assert.deepEqual(snap.open.map((i) => [i.id, i.position, i.ownerLabel, i.ownerState]), [[a1, 1, 'DSH :1', 'online'], [b1, 2, 'DSH :2', 'online'], [a2, 3, 'DSH :1', 'online']])
  assert.match(hub.store.get(a1).summary, /^summary of A is done/)
  for (const app of [A, B]) {
    await waitFor(() => app.hubQueue.count().total === 3, 5000, app.label + ' mirror')
    assert.deepEqual(app.hubQueue.snapshot().open.map((i) => [i.id, i.position]), [[a1, 1], [b1, 2], [a2, 3]], app.label)
    assert.deepEqual(app.hubQueue.workspaces().map((w) => w.title), app.id === A.id ? ['alpha', 'beta (DSH :2)'] : ['beta', 'alpha (DSH :1)'], app.label)
  }
})

test('a phone approve of the permission of A runs in A only; the risky one needs the hold; B can approve for A through the hub too', async (t) => {
  const { hub, port, A, B } = await twoApps(t)
  const plain = await A.permission('sa1')
  const risky = await A.permission('sa2', 'rm -rf /tmp/x')
  await A.drained()
  const noHold = await phone(port, 'approve', { id: risky.id, confirmed: true })
  assert.deepEqual([noHold.status, noHold.json.error], [400, 'needs-hold'])
  const res = await phone(port, 'approve', { id: plain.id, confirmed: true })
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  assert.equal(await plain.outcome, 'allowed-once', 'the promise that DSH is waiting on was settled in A')
  assert.equal(hub.store.get(plain.id).resolution.kind, 'approved')
  assert.deepEqual(B.executed, [])
  const viaB = await B.hubQueue.approve(risky.id)
  assert.deepEqual(viaB, { ok: true })
  assert.equal(await risky.outcome, 'allowed-once')
  assert.deepEqual([A.executed, B.executed], [['approve', 'approve'], []])
  assert.deepEqual(await phone(port, 'approve', { id: plain.id, confirmed: true }).then((r) => [r.status, r.json.error]), [409, 'not-open'])
})

test('B restarts with the same key and a new id: its question is gone as session-ended, its completed items are adopted', async (t) => {
  const { hub, port, A, B, common } = await twoApps(t)
  const question = B.question('sb1')
  const done = await B.completed('sb2', 'B finished something')
  const aDone = await A.completed('sa1', 'A finished something')
  await Promise.all([A.drained(), B.drained()])
  await B.client.stop({ bye: false }) // the process dies: no bye
  const B2 = makeApp(t, { ...common, key: 'kB', id: 'bbbb9999', label: 'DSH :2' })
  B2.client.start()
  await B2.connected()
  assert.deepEqual(hub.store.get(question.id).resolution, { kind: 'session-ended', by: 'hub', reason: 'restarted' })
  assert.deepEqual([hub.store.get(done).owner, hub.store.get(done).status], ['bbbb9999', 'open'])
  assert.equal(hub.store.get(aDone).owner, 'aaaa1111')
  assert.equal(B2.adapter.get(question.id), undefined, 'the stale question of the dead process is dropped from its local store too')
  assert.equal(B2.adapter.get(done).status, 'open')
  const snap = (await raw({ port, path: P + '/v1/snapshot' })).json
  assert.deepEqual(snap.open.map((i) => [i.id, i.ownerState]), [[done, 'online'], [aDone, 'online']])
  assert.equal(hub.instances.get('bbbb2222').state, 'gone')
})

test('A sleeps: it goes away, then gone (its permission ends); when it wakes the same process revives it and the phone can approve again', async (t) => {
  const { hub, port, clock, A } = await twoApps(t)
  const permission = await A.permission('sa1')
  const done = await A.completed('sa2', 'done while awake')
  await A.drained()
  A.net.down = true // the laptop sleeps
  await waitFor(() => hub.instances.get('aaaa1111').pollsOpen === 0, 5000, 'last poll ended')
  clock.advance(AWAY_MS + 1000); hub.instances.tick()
  assert.equal(hub.instances.get('aaaa1111').state, 'away')
  const away = await phone(port, 'approve', { id: permission.id, confirmed: true })
  assert.deepEqual([away.status, away.json.error], [409, 'owner-away'])
  clock.advance(GRACE_MS); hub.instances.tick()
  assert.equal(hub.instances.get('aaaa1111').state, 'gone')
  assert.deepEqual([hub.store.get(permission.id).resolution.reason, hub.store.get(done).status], ['owner-gone', 'open'])
  A.net.down = false // it wakes up
  await waitFor(() => hub.store.get(permission.id).status === 'open' && hub.instances.get('aaaa1111').state === 'online', 8000, 'revived')
  const res = await phone(port, 'approve', { id: permission.id, confirmed: true })
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  assert.equal(await permission.outcome, 'allowed-once')
})

test('the hub restarts mid-run: both apps register again and sync, nothing is lost or ended, and a pending permission still works', async (t) => {
  const first = await twoApps(t)
  const { A, B, dir } = first
  const q = B.question('sb1')
  const a1 = await A.completed('sa1', 'first')
  const permission = await A.permission('sa2')
  await Promise.all([A.drained(), B.drained()])
  const before = openIds(first.hub)
  await first.hub.stop()
  await waitFor(() => A.client.state === 'degraded' && B.client.state === 'degraded', 8000, 'both degraded')
  const second = await startHub(t, { roleOf, dir, port: first.port, clock: first.clock })
  await Promise.all([A.connected(), B.connected()])
  assert.deepEqual(openIds(second.hub), before)
  assert.deepEqual(second.hub.store.list().map((i) => i.resolution?.reason).filter(Boolean), [])
  assert.deepEqual([a1, q.id, permission.id].map((id) => second.hub.store.get(id).owner), ['aaaa1111', 'bbbb2222', 'aaaa1111'])
  const res = await phone(second.port, 'approve', { id: permission.id, confirmed: true })
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  assert.equal(await permission.outcome, 'allowed-once')
})

test('the hub is killed and its state is gone when it returns: the outbox kept what happened meanwhile and the apps give everything back', async (t) => {
  const first = await twoApps(t)
  const { A, B, dir } = first
  const a1 = await A.completed('sa1', 'first')
  const b1 = await B.completed('sb1', 'second')
  await Promise.all([A.drained(), B.drained()])
  const order = openIds(first.hub)
  await first.hub.stop()
  for (const f of ['queue.json', 'queue.json.bak']) rmSync(join(dir, 'hub', f), { force: true })
  rmSync(join(dir, 'hub.json'), { force: true })
  await waitFor(() => A.client.state === 'degraded', 8000, 'degraded')
  const offline = await A.completed('sa2', 'written while the hub was down')
  assert.equal(A.adapter.outbox().length > 0 || A.adapter.needsResync, true)
  const second = await startHub(t, { roleOf, dir, port: first.port, clock: first.clock })
  await Promise.all([A.connected(), B.connected()])
  await Promise.all([A.drained(), B.drained()])
  assert.deepEqual(openIds(second.hub), [...order, offline], 'same order as before, the offline item last')
  assert.deepEqual([a1, b1, offline].map((id) => second.hub.store.get(id).owner), ['aaaa1111', 'bbbb2222', 'aaaa1111'])
})

test('a hub of a newer protocol: the app is told to upgrade, keeps working on its own items, and its hub queue is the local service', async (t) => {
  const { port, dir, clock } = await startHub(t, { protocol: 3, roleOf })
  const A = makeApp(t, { port, dir, clock, key: 'kA', id: 'aaaa1111', label: 'DSH :1' })
  const permission = await A.permission('sa1')
  A.client.start()
  await waitFor(() => A.client.state === 'upgrade-required', 5000, 'upgrade-required')
  assert.deepEqual(A.hubQueue.snapshot().open.map((i) => i.id), [permission.id])
  assert.deepEqual(A.hubQueue.approve(permission.id), { ok: true })
  assert.equal(await permission.outcome, 'allowed-once')
})

test('a command whose response got lost is delivered again and runs once; the phone gets one answer', async (t) => {
  const { port, A } = await twoApps(t)
  const permission = await A.permission('sa1')
  await A.drained()
  A.net.loseNextCommandResponse = true
  const res = await phone(port, 'approve', { id: permission.id, confirmed: true })
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  assert.equal(await permission.outcome, 'allowed-once')
  assert.deepEqual(A.executed, ['approve'])
})

test('no secret, reply text or title ever reaches hub.log or the agent logs', async (t) => {
  const { hub, port, dir, A, B } = await twoAppsWithGeneratedSecret(t)
  const secret = readFileSync(join(dir, 'hub.secret'), 'utf8').trim()
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/)
  const done = await A.completed('SENTINEL-SESSION', 'SENTINEL-REPLY-TEXT of the first task')
  const permission = await B.permission('sb1', 'echo SENTINEL-COMMAND')
  await Promise.all([A.drained(), B.drained()])
  await phone(port, 'approve', { id: permission.id, confirmed: true })
  await phone(port, 'reviewed', { id: done })
  await A.client.stop()
  await B.client.stop()
  await hub.stop()
  const hubLog = readFileSync(join(dir, 'hub', 'hub.log'), 'utf8')
  assert.match(hubLog, /hub started/)
  assert.match(hubLog, /agent registered/)
  for (const [name, text] of [['hub.log', hubLog], ['agent A', A.logs.join('\n')], ['agent B', B.logs.join('\n')]]) {
    for (const needle of [secret, 'SENTINEL', 'Bearer', 'Title SENTINEL']) assert.equal(text.includes(needle), false, name + ' contains ' + needle.slice(0, 8))
  }
})

async function twoAppsWithGeneratedSecret(t) {
  const ctx = await startHub(t, { roleOf, secret: undefined, log: undefined })
  const secret = readFileSync(join(ctx.dir, 'hub.secret'), 'utf8').trim()
  const common = { port: ctx.port, dir: ctx.dir, clock: ctx.clock, secret }
  const A = makeApp(t, { ...common, key: 'kA', id: 'aaaa1111', label: 'DSH :1' })
  const B = makeApp(t, { ...common, key: 'kB', id: 'bbbb2222', label: 'DSH :2' })
  A.client.start(); B.client.start()
  await Promise.all([A.connected(), B.connected()])
  return { ...ctx, A, B }
}
