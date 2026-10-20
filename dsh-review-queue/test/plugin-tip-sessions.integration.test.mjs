import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeLlm } from './todo-tune-helpers.mjs'
import { makeWorld, startPlugin, waitFor } from './plugin-helpers.mjs'

// The real plugin wiring (index.js + agent/wire.js): the session numbers and the tip, standalone and in hub mode.
const GOOD = JSON.stringify({ title: 'Hash tables', body: 'A hash table maps a key to a slot with a hash function. Example: a phone book indexed by the hash of each name finds an entry without scanning. Collisions are handled by chaining or probing.', category: 'algorithms' })
const list = (counts) => async () => ({ items: counts() })
const sess = (id, running = false, over = {}) => ({ sessionId: id, running, blank: false, updatedAt: 1, ...over })
const FAST = { sessionCounter: { ttlMs: 10, minEmitMs: 10 }, sessionsRefreshMs: 30 }
// What the desktop overlay sends while it is open (tip=1): the tip is asked for and somebody is looking at the numbers.
const looked = async (app) => (await app.get('/v1/snapshot?tip=1')).json
const speaker = (spoken) => ({ speak: (chunks) => { spoken.push(chunks); return { ok: true } }, stop() {} })

test('standalone: the snapshot carries sessions once the controller answered, and nothing while it is unknown', async (t) => {
  const world = await makeWorld(t)
  const items = [sess('a', true), sess('b'), sess('c', false, { parentSessionId: 'a' })]
  const app = await startPlugin(t, world, { label: 'S', webPort: 12001, config: { hub: false, ...FAST }, services: { sessionController: { list: list(() => items) } } })
  await waitFor(async () => (await looked(app)).sessions, 5000, 'sessions in the snapshot')
  assert.deepEqual((await looked(app)).sessions, { working: 1, open: 2 })
  items.push(sess('d', true))
  await waitFor(async () => (await looked(app)).sessions?.open === 3, 5000, 'the new session counted')
  assert.deepEqual((await looked(app)).sessions, { working: 2, open: 3 })
})

test('standalone without a session controller: no sessions field at all', async (t) => {
  const world = await makeWorld(t)
  const app = await startPlugin(t, world, { label: 'S', webPort: 12002, config: { hub: false, ...FAST } })
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(!('sessions' in (await looked(app))))
})

test('standalone: the empty list gets a model tip that can be read aloud; an item hides it', async (t) => {
  const world = await makeWorld(t)
  const spoken = []
  const app = await startPlugin(t, world, { label: 'S', webPort: 12003, config: { hub: false, speaker: speaker(spoken), ...FAST }, services: { llm: fakeLlm({ answer: GOOD }) } })
  const snap = await waitFor(async () => { const s = await looked(app); return s.tip && s }, 5000, 'the tip')
  assert.equal(snap.tip.source, 'model')
  assert.equal(snap.tip.title, 'Hash tables')
  assert.deepEqual((await app.post('/v1/read-tip', { id: snap.tip.id })).json, { ok: true })
  assert.match(spoken[0].join(' '), /Hash tables/)
  assert.equal((await app.snapshot()).reading, 'tip:' + snap.tip.id)
  await app.completed('s1', 'done')
  assert.ok(!('tip' in (await looked(app))))
})

test('standalone without a model: a built-in tip at once', async (t) => {
  const world = await makeWorld(t)
  const app = await startPlugin(t, world, { label: 'S', webPort: 12004, config: { hub: false, ...FAST } })
  const snap = await looked(app)
  assert.equal(snap.tip.source, 'builtin')
  assert.ok(!('tip' in (await app.snapshot())), 'a plain poll (overlay closed) gets none')
})

test('hub mode: the sessions of both apps are summed, an app that left adds nothing, and each desktop carries its own tip', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const a = await startPlugin(t, world, { label: 'DSH :1', webPort: 12011, config: FAST, hub: { agent: { backoff: { minMs: 10, maxMs: 40 }, waitMs: 400, sessionReportMs: 30 } }, services: { sessionController: { list: list(() => [sess('a1', true), sess('a2')]) } } })
  const b = await startPlugin(t, world, { label: 'DSH :2', webPort: 12012, config: FAST, hub: { agent: { backoff: { minMs: 10, maxMs: 40 }, waitMs: 400, sessionReportMs: 30 } }, services: { sessionController: { list: list(() => [sess('b1', true), sess('b2', true), sess('b3')]) } } })
  await Promise.all([a.inState('hub'), b.inState('hub')])
  const both = async (app) => { const s = await looked(app); return s.sessions?.open === 5 && s }
  const sa = await waitFor(() => both(a), 8000, 'sum at A')
  assert.deepEqual(sa.sessions, { working: 3, open: 5 })
  assert.deepEqual((await waitFor(() => both(b), 8000, 'sum at B')).sessions, { working: 3, open: 5 })
  assert.ok(sa.tip && sa.tip.source === 'builtin', 'the empty merged list shows the local tip')
  await b.stop()
  const left = await waitFor(async () => { const s = await looked(a); return s.sessions?.open === 2 && s }, 8000, 'B gone from the sum')
  assert.deepEqual(left.sessions, { working: 1, open: 2 })
})

test('hub mode: nobody looks (overlay closed), nobody asks the controller; the first look wakes the numbers', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  let asked = 0
  const a = await startPlugin(t, world, { label: 'DSH :1', webPort: 12031, config: FAST, hub: { agent: { backoff: { minMs: 10, maxMs: 40 }, waitMs: 400, sessionReportMs: 30 } }, services: { sessionController: { list: async () => { asked++; return { items: [sess('a1', true)] } } } } })
  await a.inState('hub')
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(asked, 0, 'no snapshot asked for the numbers yet')
  await a.snapshot()
  assert.equal(asked, 0, 'a plain poll does not count')
  const snap = await waitFor(async () => { const s = await looked(a); return s.sessions && s }, 8000, 'numbers after the first look')
  assert.deepEqual(snap.sessions, { working: 1, open: 1 })
  assert.ok(asked > 0)
})

test('hub mode: a merged list with an item has no tip', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const a = await startPlugin(t, world, { label: 'DSH :1', webPort: 12021, config: FAST })
  await a.inState('hub')
  const id = await a.completed('s1', 'done')
  await waitFor(() => a.mirrored(id), 5000, 'mirror')
  assert.ok(!('tip' in (await looked(a))))
})
