// What the plugin wiring promises around the hub: off means today's behaviour, apply never throws or waits on the hub, stale requests of an
// earlier run end in the right place, the app's end never takes the hub down, and the hub learns a key and a label for the app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { instanceKeyOf } from '../agent/config.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { makeWorld, startPlugin, waitFor } from './plugin-helpers.mjs'

const dshHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')
const localFile = (world, port) => join(world.dir, 'local', instanceKeyOf({ dshHome: dshHome(), port }) + '.json')

/** An app that died with a question open: its local file as the next run finds it. */
function leaveStaleQuestion(world, port) {
  mkdirSync(join(world.dir, 'local'), { recursive: true })
  const file = localFile(world, port)
  const adapter = createStoreAdapter({ instanceId: 'dead0000', io: { read: () => undefined, write: (text) => writeFileSync(file, text) } })
  return adapter.add({ type: 'question', sessionId: 'old-session', key: 'old-call', payload: { questions: [] } }).id
}

test('hub:false is today: no agent, no proxy, no launcher, the old queue.json, the service is what other plugins get', async (t) => {
  const world = await makeWorld(t)
  const p = await startPlugin(t, world, { label: 'T', webPort: 12101, config: { hub: false } })
  assert.equal(p.agent, undefined)
  assert.equal(p.proxy, undefined)
  assert.equal(p.provided.reviewQueue, p.queue)
  assert.equal(p.queue, p.local)
  await p.completed('s1', 'did it')
  assert.equal((await p.snapshot()).open.length, 1, 'served straight from the local service')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(world.spawned.length, 0)
  assert.equal(existsSync(join(world.dir, 'local')), false)
  assert.equal(existsSync(join(world.dir, 'queue.json')), true)
})

test('DSH_RQ_HUB=0 switches the hub off like hub:false', async (t) => {
  const world = await makeWorld(t)
  const before = process.env.DSH_RQ_HUB
  process.env.DSH_RQ_HUB = '0'
  try {
    const p = await startPlugin(t, world, { label: 'T', webPort: 12102 })
    assert.equal(p.agent, undefined)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(world.spawned.length, 0)
  } finally { if (before === undefined) delete process.env.DSH_RQ_HUB; else process.env.DSH_RQ_HUB = before }
})

test('with the hub on, what other plugins get is the hub queue: its actions answer with promises', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const p = await startPlugin(t, world, { label: 'T', webPort: 12103 })
  await p.inState('hub')
  assert.notEqual(p.provided.reviewQueue, p.local)
  const c = await p.completed('s1', 'done')
  await waitFor(() => p.mirrored(c), 5000, 'in the mirror')
  const pending = p.provided.reviewQueue.markReviewed(c)
  assert.equal(typeof pending.then, 'function')
  assert.deepEqual(await pending, { ok: true })
})

test('stale requests of an earlier run: with no hub, only what was there before this process ends; a request of this process stays', async (t) => {
  const world = await makeWorld(t)
  world.spawnFails = true
  const stale = leaveStaleQuestion(world, 12104)
  const p = await startPlugin(t, world, { label: 'T', webPort: 12104 })
  await p.inState('standalone')
  assert.equal(p.store.get(stale).status, 'resolved')
  assert.equal(p.store.get(stale).resolution.by, 'restart')
  const fresh = p.question('s-new')
  assert.equal(p.store.get(fresh.id).status, 'open')
  await new Promise((r) => setTimeout(r, 250)) // later retries do not cancel it
  assert.equal(p.store.get(fresh.id).status, 'open')
})

test('stale requests of an earlier run: with the hub it is the hub that ends them, not this app', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const first = await startPlugin(t, world, { label: 'T', webPort: 12105 })
  await first.inState('hub')
  const q = first.question('s-old')
  await waitFor(() => world.hub.store.get(q.id), 5000, 'the question at the hub')
  await first.agent.stop({ bye: false }) // the app died: no goodbye
  const second = await startPlugin(t, world, { label: 'T', webPort: 12105 })
  await second.inState('hub')
  await waitFor(() => world.hub.store.get(q.id).status === 'resolved', 5000, 'ended by the hub')
  assert.deepEqual([world.hub.store.get(q.id).resolution.by, world.hub.store.get(q.id).resolution.reason], ['hub', 'restarted'])
  assert.notEqual(second.store.get(q.id)?.resolution?.by, 'restart', 'this app did not cancel it itself')
})

test('apply never throws and never waits on the hub: a failing spawn is a notice, an unusable state directory switches the hub off', async (t) => {
  const world = await makeWorld(t)
  world.spawnFails = true
  const p = await startPlugin(t, world, { label: 'T', webPort: 12106 })
  assert.ok(p.queue.snapshot())
  const blocker = join(world.dir, 'a-file')
  writeFileSync(blocker, 'x')
  const broken = await startPlugin(t, world, { label: 'U', webPort: 12107, config: { stateDir: join(blocker, 'sub') } })
  assert.equal(broken.agent, undefined, 'no state directory, no hub')
  assert.ok(broken.queue.snapshot())
})

test('the end of the app says bye and stops the retries, and never touches the hub process', async (t) => {
  const world = await makeWorld(t)
  const p = await startPlugin(t, world, { label: 'T', webPort: 12108 })
  await p.inState('hub')
  const hub = world.hub
  await p.stop()
  assert.equal(p.agent.state, 'stopped')
  assert.equal(world.hub, hub, 'the hub keeps running')
  assert.equal(existsSync(join(world.dir, 'hub.json')), true)
  const spawned = world.spawned.length
  await world.killHub()
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(world.spawned.length, spawned, 'a stopped app does not ask for a new hub')
  await waitFor(() => !world.hub, 1000, 'no hub')
})

test('the hub learns the key of the app (home and web port) and its label; without a port the key is pid based and nothing is adopted', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const a = await startPlugin(t, world, { label: 'Work', webPort: 12109 })
  const b = await startPlugin(t, world, { label: undefined, webPort: undefined })
  await Promise.all([a.inState('hub'), b.inState('hub')])
  const byId = (id) => world.hub.instances.get(id)
  assert.equal(byId(a.agent.instanceId).key, instanceKeyOf({ dshHome: dshHome(), port: 12109 }))
  assert.equal(byId(a.agent.instanceId).label, 'Work')
  assert.match(byId(b.agent.instanceId).key, /^pid-/)
  assert.equal(byId(b.agent.instanceId).label, 'DSH')
  assert.equal(readFileSync(localFile(world, 12109), 'utf8').includes('"agent"'), true, 'own items live in local/<key>.json')
})

test('the key does not depend on the web port being known when the plugin is applied: the host reports it later, or the web server service has it', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const late = await startPlugin(t, world, { label: 'Late', webPort: 12201, injectDelayMs: 60 })
  const viaService = await startPlugin(t, world, { label: 'Service', webPort: undefined, services: { webServer: { port: 12202 } } })
  await Promise.all([late.inState('hub'), viaService.inState('hub')])
  assert.equal(world.hub.instances.get(late.agent.instanceId).key, instanceKeyOf({ dshHome: dshHome(), port: 12201 }))
  assert.equal(world.hub.instances.get(late.agent.instanceId).label, 'Late')
  assert.equal(world.hub.instances.get(viaService.agent.instanceId).key, instanceKeyOf({ dshHome: dshHome(), port: 12202 }))
  assert.equal(world.hub.instances.get(viaService.agent.instanceId).label, 'Service')
})

test('a port that never shows up costs a bounded wait, then the pid key is used (never the missing port)', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const started = Date.now()
  const p = await startPlugin(t, world, { label: undefined, webPort: undefined, hub: { portWaitMs: 300 } })
  await p.inState('hub')
  assert.ok(Date.now() - started >= 280, 'the agent waited for the port first')
  assert.match(world.hub.instances.get(p.agent.instanceId).key, /^pid-/)
  assert.equal(world.hub.instances.get(p.agent.instanceId).label, 'DSH')
})
