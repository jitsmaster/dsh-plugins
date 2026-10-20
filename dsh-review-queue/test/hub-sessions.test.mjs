import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHubStore } from '../hub/hub-store.js'
import { createCommands } from '../hub/commands.js'
import { createInstances, AWAY_MS } from '../hub/instances.js'
import { fullStampOf } from '../server.js'
import { WATCH_MS } from '../hub/hub.js'
import { fakeClock, memIo, raw } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

// "N working / M open" in hub mode: every app reports its numbers (register, then presence when they change); the hub's snapshot sums the
// apps that are online. An app that is away or gone adds nothing, an old agent that never reports adds 0.
const A = 'aaaa1111'
const B = 'bbbb2222'
function make(over = {}) {
  const clock = fakeClock()
  let n = 0
  const store = createHubStore({ now: clock.now, uuid: () => 'u' + ++n, timers: clock, io: memIo() })
  const commands = createCommands({ now: clock.now, timers: clock })
  const events = []
  const instances = createInstances({ store, commands, now: clock.now, onSessions: () => events.push('sessions'), ...over })
  return { clock, store, instances, events }
}
const reg = (instances, id, key, sessions) => instances.register({ key, id, label: 'DSH ' + id.slice(0, 1), ...(sessions ? { sessions } : {}) })

test('with no reports the total is unknown (undefined), not zero', () => {
  const { instances } = make()
  assert.equal(instances.sessionsTotal(), undefined)
  reg(instances, A, 'k1')
  assert.equal(instances.sessionsTotal(), undefined, 'an old agent without counts')
})

test('the register body can carry the numbers, and presence updates them', () => {
  const { instances } = make()
  reg(instances, A, 'k1', { working: 2, open: 5 })
  assert.deepEqual(instances.sessionsTotal(), { working: 2, open: 5 })
  instances.presence(A, { sessions: { working: 3, open: 5 } })
  assert.deepEqual(instances.sessionsTotal(), { working: 3, open: 5 })
})

test('the total sums every online app; an app without numbers adds 0', () => {
  const { instances } = make()
  reg(instances, A, 'k1', { working: 2, open: 5 })
  reg(instances, B, 'k2', { working: 1, open: 3 })
  reg(instances, 'cccc3333', 'k3')
  assert.deepEqual(instances.sessionsTotal(), { working: 3, open: 8 })
})

test('an app that is away or gone contributes nothing', () => {
  const { instances, clock } = make()
  reg(instances, A, 'k1', { working: 2, open: 5 })
  reg(instances, B, 'k2', { working: 1, open: 3 })
  instances.pollOpen(B)
  clock.advance(AWAY_MS + 1000)
  instances.tick() // A: away (no poll), B: online (poll open)
  assert.deepEqual(instances.sessionsTotal(), { working: 1, open: 3 })
  instances.bye(B)
  assert.equal(instances.sessionsTotal(), undefined, 'nobody online reports')
})

test('numbers that are not non-negative integers are ignored; the object is copied, not kept', () => {
  const { instances } = make()
  reg(instances, A, 'k1', { working: 1, open: 2 })
  for (const bad of [{ working: -1, open: 2 }, { working: 'x', open: 2 }, { working: 1.5, open: 2 }, { working: 1 }, null, 'x', { working: 5, open: 2 }, { working: 1e9, open: 1e9 + 1 }]) {
    instances.presence(A, { sessions: bad })
    assert.deepEqual(instances.sessionsTotal(), { working: 1, open: 2 }, JSON.stringify(bad))
  }
  const mine = { working: 1, open: 2, extra: 'x' }
  instances.presence(A, { sessions: mine })
  mine.working = 99
  assert.deepEqual(instances.sessionsTotal(), { working: 1, open: 2 })
})

test('a change tells the listeners (the hub wakes its long polls), a repeat of the same numbers does not', () => {
  const { instances, events } = make()
  reg(instances, A, 'k1', { working: 1, open: 2 })
  const n = events.length
  instances.presence(A, { sessions: { working: 1, open: 2 } })
  assert.equal(events.length, n)
  instances.presence(A, { sessions: { working: 2, open: 2 } })
  assert.equal(events.length, n + 1)
})

test('an app going away changes the total and tells the listeners once', () => {
  const { instances, clock, events } = make()
  reg(instances, A, 'k1', { working: 2, open: 5 })
  const n = events.length
  clock.advance(AWAY_MS + 1000)
  instances.tick()
  assert.equal(instances.sessionsTotal(), undefined)
  assert.equal(events.length, n + 1)
  instances.tick()
  assert.equal(events.length, n + 1)
})

// ---- over HTTP --------------------------------------------------------------------------------------------------------------------------

test('the agent API takes sessions on register and on presence, and an old agent that sends none still works', async (t) => {
  const { hub, port } = await startHub(t, { roleOf: () => 'desktop' })
  const a = agentOf(port, { id: A, key: 'k1' })
  const b = agentOf(port, { id: B, key: 'k2' })
  assert.equal((await a.register({ sync: sync(), sessions: { working: 1, open: 2 } })).status, 200)
  assert.equal((await b.register({ sync: sync() })).status, 200, 'an old agent')
  assert.deepEqual(hub.snapshot().sessions, { working: 1, open: 2 })
  assert.equal((await b.post('presence', { sessions: { working: 2, open: 4 } })).status, 200)
  assert.deepEqual(hub.snapshot().sessions, { working: 3, open: 6 })
  assert.equal((await a.post('presence', { desktopActive: true })).status, 200, 'the old presence body is unchanged')
  assert.deepEqual(hub.snapshot().sessions, { working: 3, open: 6 })
})

test('the hub snapshot has no sessions field while nobody reported, and its snapshotId is the store id either way', async (t) => {
  const { hub, port } = await startHub(t, { roleOf: () => 'desktop' })
  const a = agentOf(port, { id: A, key: 'k1' })
  await a.register({ sync: sync() })
  const before = hub.snapshot()
  assert.ok(!('sessions' in before))
  await a.post('presence', { sessions: { working: 1, open: 1 } })
  const after = hub.snapshot()
  assert.equal(after.snapshotId, before.snapshotId, 'the count never moves the snapshotId')
  assert.deepEqual(after.sessions, { working: 1, open: 1 })
})

test('GET /v1/snapshot serves the sum, and a long poll wakes when a count changes (after the 3 s coalescing of the hub)', async (t) => {
  const clock = fakeClock()
  const { port } = await startHub(t, { clock, timers: clock, roleOf: () => 'desktop' })
  const a = agentOf(port, { id: A, key: 'k1' })
  await a.register({ sync: sync(), sessions: { working: 1, open: 2 } })
  clock.advance(3000)
  const get = (q = '') => raw({ port, path: P + '/v1/snapshot' + q, headers: { host: '127.0.0.1:' + port } })
  const first = (await get()).json
  assert.deepEqual(first.sessions, { working: 1, open: 2 })
  const stamp = encodeURIComponent(fullStampOf(first))
  assert.equal((await get('?wait=0&since=' + stamp)).json.unchanged, true)
  const waiting = get('?wait=5000&since=' + stamp)
  await new Promise((r) => setTimeout(r, 60))
  await a.post('presence', { sessions: { working: 2, open: 2 } })
  clock.advance(3000)
  const woke = await waiting
  assert.deepEqual(woke.json.sessions, { working: 2, open: 2 })
})

test('an old mirror token (id|||0) is still answered unchanged while only the numbers move', async (t) => {
  const { port } = await startHub(t, { roleOf: () => 'desktop' })
  const a = agentOf(port, { id: A, key: 'k1' })
  await a.register({ sync: sync(), sessions: { working: 1, open: 2 } })
  const get = (q) => raw({ port, path: P + '/v1/snapshot' + q, headers: { host: '127.0.0.1:' + port } })
  const first = (await get('')).json
  await a.post('presence', { sessions: { working: 2, open: 2 } })
  const answer = await get('?wait=0&since=' + encodeURIComponent(first.snapshotId + '|||0'))
  assert.equal(answer.json.unchanged, true)
})

// ---- is anybody looking? (the agents keep their numbers fresh only while somebody is) -----------------------------------------------------

test('the watch window is 60 s', () => assert.equal(WATCH_MS, 60_000))

test('the hub says nobody looks until a phone or an open overlay polls the snapshot, and for 60 s after', async (t) => {
  const clock = fakeClock()
  const { hub, port } = await startHub(t, { clock, roleOf: (req) => (req.headers['x-test-role'] ?? 'desktop') })
  const a = agentOf(port, { id: A, key: 'k1' })
  assert.equal((await a.register({ sync: sync() })).json.watch, false)
  assert.equal((await a.post('presence', {})).json.watch, false)
  const get = (q, headers = {}) => raw({ port, path: P + '/v1/snapshot' + q, headers })
  await get('?wait=0')
  assert.equal(hub.watching(), false, 'a plain desktop poll (overlay closed, an agent mirror) is not looking')
  await get('?wait=0&watch=1')
  assert.equal(hub.watching(), true)
  assert.equal((await a.post('presence', {})).json.watch, true)
  clock.advance(59_000)
  assert.equal(hub.watching(), true)
  clock.advance(2_000)
  assert.equal(hub.watching(), false)
  await get('?wait=0', { 'x-test-role': 'device' })
  assert.equal(hub.watching(), true, 'a phone poll')
})

// ---- a long poll that cannot see the numbers keeps waiting ---------------------------------------------------------------------------------

test('a token without the numbers part (an old page, the agent mirror) is not answered early when only the numbers move: it waits out its time', async (t) => {
  const { port } = await startHub(t, { roleOf: () => 'desktop' })
  const a = agentOf(port, { id: A, key: 'k1' })
  await a.register({ sync: sync(), sessions: { working: 1, open: 2 } })
  const get = (q) => raw({ port, path: P + '/v1/snapshot' + q })
  const first = (await get('')).json
  const started = Date.now()
  const waiting = get('?wait=700&since=' + encodeURIComponent(first.snapshotId + '|||0'))
  await new Promise((r) => setTimeout(r, 100))
  await a.post('presence', { sessions: { working: 2, open: 2 } })
  const answer = await waiting
  assert.equal(answer.json.unchanged, true)
  assert.ok(Date.now() - started >= 600, 'answered after ' + (Date.now() - started) + ' ms')
})

test('a token that has the numbers part still wakes at once, and a real item change wakes every kind of token', async (t) => {
  const { port } = await startHub(t, { roleOf: () => 'desktop' })
  const a = agentOf(port, { id: A, key: 'k1' })
  await a.register({ sync: sync(), sessions: { working: 1, open: 2 } })
  const get = (q) => raw({ port, path: P + '/v1/snapshot' + q })
  const first = (await get('')).json
  const started = Date.now()
  const waiting = get('?wait=5000&since=' + encodeURIComponent(first.snapshotId + '|||0|1/2|'))
  const oldToken = get('?wait=5000&since=' + encodeURIComponent(first.snapshotId + '|||0'))
  await new Promise((r) => setTimeout(r, 80))
  await a.send(a.add(1))
  const [x, y] = await Promise.all([waiting, oldToken])
  assert.ok(x.json.open.length === 1 && y.json.open.length === 1)
  assert.ok(Date.now() - started < 3000)
})

// ---- coalescing ------------------------------------------------------------------------------------------------------------------------------

test('the numbers of many apps wake the hub listeners at most once per 3 s, with the final sum (one trailing timer, gone at stop)', async (t) => {
  const clock = fakeClock()
  const { hub, port } = await startHub(t, { clock, timers: clock, roleOf: () => 'desktop' })
  const a = agentOf(port, { id: A, key: 'k1' })
  await a.register({ sync: sync(), sessions: { working: 0, open: 1 } })
  clock.advance(3000) // the register's own wake is over
  let wakes = 0
  hub.onChange(() => { wakes++ })
  const base = clock.pending()
  for (let n = 1; n <= 6; n++) await a.post('presence', { sessions: { working: n, open: 10 } })
  assert.equal(wakes, 0, 'nothing yet')
  assert.equal(clock.pending(), base + 1, 'one timer for all of them')
  clock.advance(2999)
  assert.equal(wakes, 0)
  clock.advance(1)
  assert.equal(wakes, 1)
  assert.deepEqual(hub.snapshot().sessions, { working: 6, open: 10 }, 'the wake carries the final sum')
  assert.equal(clock.pending(), base)
  await a.post('presence', { sessions: { working: 7, open: 10 } })
  assert.equal(clock.pending(), base + 1)
  await hub.stop()
  clock.advance(10_000)
  assert.equal(wakes, 1, 'a stopped hub wakes nobody')
})

test('item changes still wake at once (only the numbers are coalesced)', async (t) => {
  const clock = fakeClock()
  const { hub, port } = await startHub(t, { clock, timers: clock, roleOf: () => 'desktop' })
  const a = agentOf(port, { id: A, key: 'k1' })
  await a.register({ sync: sync() })
  let wakes = 0
  hub.onChange(() => { wakes++ })
  await a.send(a.add(1))
  assert.ok(wakes >= 1)
})
