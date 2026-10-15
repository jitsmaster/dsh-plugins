// Headline test of slice H3: two REAL plugins (createReviewQueuePlugin: real capture, service, store adapter, agent client, launcher,
// proxy) on fake DSH hosts against ONE real hub in this process. Only the DSH host (ctx, sessions) and the process spawn are faked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listOf, makeWorld, startPlugin, waitFor } from './plugin-helpers.mjs'

const NOTICE_DOWN = /^Phone sync is off: hub unreachable\./

async function twoApps(t, world) {
  const A = await startPlugin(t, world, { label: 'DSH :1', webPort: 11001 })
  const B = await startPlugin(t, world, { label: 'DSH :2', webPort: 11002 })
  await Promise.all([A.inState('hub'), B.inState('hub')])
  return { A, B }
}
const sameList = async (A, B, n) => {
  await waitFor(async () => (await A.snapshot()).open.length === n && (await B.snapshot()).open.length === n, 8000, 'both overlays show ' + n + ' items')
  const [a, b] = [await A.snapshot(), await B.snapshot()]
  assert.deepEqual(listOf(a), listOf(b))
  return a
}

test('two apps on one hub: both overlays show the same global list, and an approve from B reaches the owner A', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const { A, B } = await twoApps(t, world)
  const a1 = await A.completed('sa1', 'A did the first task')
  const q = B.question('sb1')
  const p = await A.permission('sa2')
  const snap = await sameList(A, B, 3)
  assert.deepEqual(listOf(snap), [[a1, 1], [q.id, 2], [p.id, 3]])
  assert.deepEqual(snap.open.map((i) => i.ownerLabel), ['DSH :1', 'DSH :2', 'DSH :1'])
  const res = await B.post('/v1/approve', { id: p.id })
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  assert.equal(await p.outcome, 'allowed-once', 'the promise DSH waits on in app A was settled')
  assert.equal(snap.notice, undefined)
  assert.deepEqual((await B.get('/v1/workspaces')).json, { workspaces: [] })
})

test('focus, reading and ui stay with the overlay of their own app; the other overlay does not see them', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const { A, B } = await twoApps(t, world)
  const a1 = await A.completed('sa1', 'A did the first task')
  await sameList(A, B, 1)
  assert.equal((await B.post('/v1/focus', { id: a1 })).status, 200)
  assert.equal((await B.snapshot()).focusId, a1)
  assert.equal((await A.snapshot()).focusId, undefined)
  assert.equal((await B.post('/v1/ui', { cmd: 'show' })).status, 200)
  assert.equal((await B.snapshot()).ui.cmd, 'show')
  assert.equal((await A.snapshot()).ui.cmd, undefined, 'B shows its overlay, A is not asked to')
})

test('the hub is killed: both apps say so, keep their items and run their own actions; a restarted hub brings both back with a resync and nothing lost', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const { A, B } = await twoApps(t, world)
  const a1 = await A.completed('sa1', 'A did the first task')
  const p = await A.permission('sa2')
  const b1 = await B.completed('sb1', 'B did something')
  await sameList(A, B, 3)

  world.holdSpawn() // the launcher asks for a new hub at once; it comes up when this test says so
  await world.killHub()
  await Promise.all([A.inState('degraded'), B.inState('degraded')])
  const downA = await A.snapshot()
  const downB = await B.snapshot()
  assert.match(downA.notice.text, NOTICE_DOWN)
  assert.equal(downA.notice.level, 'warn')
  assert.match(downB.notice.text, NOTICE_DOWN)
  assert.deepEqual(downA.open.map((i) => i.id).sort(), [a1, p.id, b1].sort(), 'the last known list of the other app is still shown')
  const offline = await A.completed('sa3', 'written while the hub was down')
  const foreign = await B.post('/v1/approve', { id: p.id })
  assert.deepEqual([foreign.status, foreign.json.error], [409, 'owner-offline'], 'an item of another app is read-only while the hub is down')
  const own = await A.post('/v1/approve', { id: p.id })
  assert.deepEqual([own.status, own.json], [200, { ok: true }], 'an own item runs locally')
  assert.equal(await p.outcome, 'allowed-once')

  world.releaseSpawn()
  await Promise.all([A.inState('hub'), B.inState('hub')])
  assert.ok(world.spawned.length >= 1, 'the launcher started a hub again')
  const snap = await sameList(A, B, 3)
  assert.equal(snap.notice, undefined)
  assert.deepEqual(snap.open.map((i) => i.id).sort(), [a1, b1, offline].sort())
  assert.equal(snap.resolved.find((i) => i.id === p.id).resolution.kind, 'approved', 'the offline decision reached the hub')
})

test('two apps racing to start the hub spawn exactly one; both end up connected', async (t) => {
  const world = await makeWorld(t, { spawnDelayMs: 150 })
  const [A, B] = await Promise.all([startPlugin(t, world, { label: 'DSH :1', webPort: 11001 }), startPlugin(t, world, { label: 'DSH :2', webPort: 11002 })])
  await Promise.all([A.inState('hub'), B.inState('hub')])
  assert.equal(world.spawned.length, 1)
  assert.match(world.spawned[0].args.join(' '), /hub[\\/]main\.js/)
})

test('no hub can be started: standalone with the reason in the notice, own items work; when the hub finally starts the app is promoted', async (t) => {
  const world = await makeWorld(t)
  world.spawnFails = true
  const A = await startPlugin(t, world, { label: 'DSH :1', webPort: 11001 })
  await A.inState('standalone')
  const a1 = await A.completed('sa1', 'A did the first task')
  const snap = await A.snapshot()
  assert.match(snap.notice.text, /^Phone sync is off: hub not running \(.+\)\. This app shows only its own items\.$/)
  assert.deepEqual(snap.open.map((i) => i.id), [a1])
  world.spawnFails = false
  await A.inState('hub')
  await waitFor(async () => (await A.snapshot()).notice === undefined, 8000, 'notice gone')
  assert.equal(world.hub.store.get(a1).owner, A.agent.instanceId, 'the item captured meanwhile reached the hub')
})

test('no secret, reply text or title reaches review-queue.log or the hub log in a full run', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const { A, B } = await twoApps(t, world)
  const done = await A.completed('SENTINEL-SESSION', 'SENTINEL-REPLY-TEXT of the task')
  const p = await B.permission('sb1', 'echo SENTINEL-COMMAND')
  await sameList(A, B, 2)
  await A.post('/v1/reviewed', { id: done })
  await B.post('/v1/approve', { id: p.id })
  await Promise.all([A.stop(), B.stop()])
  await world.killHub()
  const secret = readFileSync(join(world.dir, 'hub.secret'), 'utf8').trim()
  const logs = [readFileSync(join(world.dir, 'review-queue.log'), 'utf8'), readFileSync(join(world.dir, 'hub', 'hub.log'), 'utf8')].join('\n')
  assert.match(logs, /hub/)
  for (const needle of [secret, 'SENTINEL', 'Bearer']) assert.equal(logs.includes(needle), false, 'a log contains ' + needle.slice(0, 8))
})

// ---- the live bug: a "Done" card of the legacy import answered "That app is not running" to a reply -----------------------------------------------------

const LIVE = '0808d66c-91a'
const LIVE_SESSION = 'session-018f784c-live'
const NOW = 1_800_000_000_000
const legacyItem = (id, over = {}) => ({ id, seq: 1, type: 'completed', status: 'open', createdAt: NOW, sessionId: 's-' + id, payload: { reply: 'r' }, ...over })
/** The legacy queue.json of the real machine: 347 resolved items and the open Done card of a session that is alive in this process. */
function seedLegacy(world) {
  const resolved = Array.from({ length: 347 }, (_, i) => legacyItem('old' + i, { seq: i + 1, status: 'resolved', resolvedAt: NOW, resolution: { kind: 'reviewed', by: 'card' } }))
  const open = [legacyItem(LIVE, { seq: 348, sessionId: LIVE_SESSION, sessionTitle: 'PWA - 2' }), legacyItem('nobody1', { seq: 349, sessionId: 'session-nobody-has' })]
  writeFileSync(join(world.dir, 'queue.json'), JSON.stringify({ v: 1, seq: 349, items: [...resolved, ...open] }))
}
/** The DSH services of an app in which LIVE_SESSION lives: the workspace registry lists it, the controller takes prompts for it. */
function liveServices(prompts, { session = LIVE_SESSION } = {}) {
  return {
    workspaceRegistry: { list: () => [{ id: 'w1', title: 'dsh-plugins', path: 'D:\\dev\\ai\\dsh-plugins', sessionIds: [session] }], archivedSessionIds: [] },
    sessionController: { prompt: async (request) => { if (request.sessionId !== session) throw Object.assign(new Error('not found'), { code: 'session/not-found' }); prompts.push(request) } },
  }
}

test('screenshot: a Done card of the legacy import, replied to from the overlay of the live app, is sent to its session', async (t) => {
  const world = await makeWorld(t)
  seedLegacy(world)
  await world.startHub()
  const prompts = []
  const A = await startPlugin(t, world, { label: 'DSH :1', webPort: 13001, services: liveServices(prompts) })
  await A.inState('hub')
  await waitFor(() => world.hub.store.get(LIVE).owner === A.agent.instanceId, 5000, 'the Done card adopted by the app that has its session')
  const res = await A.post('/v1/reply', { id: LIVE, text: 'restarted' })
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  assert.deepEqual(prompts.map((p) => [p.sessionId, p.content[0].text]), [[LIVE_SESSION, 'restarted']])
  assert.equal(world.hub.store.get(LIVE).resolution.kind, 'replied')
  const card = (await A.snapshot()).resolved.find((i) => i.id === LIVE)
  assert.equal(card.resolution.kind, 'replied')
})

test('screenshot after a restart: the app is replaced by one with another key (another web port); the card moves to the new app and the reply works', async (t) => {
  const world = await makeWorld(t)
  world.hubOptions = { awayMs: 60, graceMs: 120, instanceTickMs: 20 }
  seedLegacy(world)
  await world.startHub()
  const first = await startPlugin(t, world, { label: 'DSH :1', webPort: 13001, services: liveServices([]) })
  await first.inState('hub')
  await waitFor(() => world.hub.store.get(LIVE).owner === first.agent.instanceId, 5000, 'adopted by the first app')
  await first.agent.stop({ bye: false }) // DSH was restarted: the process is gone without a goodbye
  await waitFor(() => world.hub.instances.get(first.agent.instanceId).state === 'gone', 5000, 'the first app is gone')

  const prompts = []
  const second = await startPlugin(t, world, { label: 'DSH :2', webPort: 13002, services: liveServices(prompts) })
  await second.inState('hub')
  assert.notEqual(world.hub.instances.get(second.agent.instanceId).key, world.hub.instances.get(first.agent.instanceId).key)
  await waitFor(() => world.hub.store.get(LIVE).owner === second.agent.instanceId, 5000, 'adopted by the second app')
  const snap = (await second.snapshot()).open.find((i) => i.id === LIVE)
  assert.deepEqual([snap.ownerLabel, snap.ownerState], ['DSH :2', 'online'])
  const res = await second.post('/v1/reply', { id: LIVE, text: 'restarted' })
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  assert.deepEqual(prompts.map((p) => p.sessionId), [LIVE_SESSION])
})

test('a card whose session no app has says session-unavailable (not "app not running"), and the item stays', async (t) => {
  const world = await makeWorld(t)
  seedLegacy(world)
  await world.startHub()
  const A = await startPlugin(t, world, { label: 'DSH :1', webPort: 13001, services: liveServices([]) })
  await A.inState('hub')
  const res = await A.post('/v1/reply', { id: 'nobody1', text: 'hello' })
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'session-unavailable' }])
  assert.equal(world.hub.store.get('nobody1').status, 'open')
  assert.equal(world.hub.store.get('nobody1').owner, undefined)
})

test('the app reports every session it can reach: live agents, workspace sessions and the sessions its capture has seen', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const services = { ...liveServices([], { session: 'ws-session' }), agents: { list: () => [{ id: 'live-agent' }, { id: 'ws-session' }] } }
  const A = await startPlugin(t, world, { label: 'DSH :1', webPort: 13001, services })
  await A.inState('hub')
  await A.completed('captured-session', 'did it') // seen by capture, and now an own open item
  await A.handlers['agent/turn-stopping'][0]({ agent: { id: 'seen-only', devTitle: 'x', session: { header: { cwd: 'D:/w' }, deriveMessages: () => [] } } })
  await A.agent.real.refreshWorkspaces() // a full sync
  const reported = world.hub.instances.get(A.agent.instanceId).sessionIds
  for (const id of ['live-agent', 'ws-session', 'captured-session', 'seen-only']) assert.ok(reported.includes(id), id + ' in ' + reported.join(','))
})
