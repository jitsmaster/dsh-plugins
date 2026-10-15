// The task list todo through the REAL plugin wiring: two apps on one hub, the overlay's own requests (GET /v1/workspaces, POST /v1/todo,
// /v1/todo-confirm) with the hub's id format ("<instance short>/<workspace id>"). Only the DSH host (registry, session controller) is faked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld, startPlugin, waitFor } from './plugin-helpers.mjs'

/** The DSH services of one app: a workspace registry that can change, and a session controller that records what was created / prompted. */
function host(workspaces) {
  const registry = { list: () => registry.workspaces, archivedSessionIds: [], workspaces }
  const created = []
  const prompted = []
  const sessionController = {
    create: async ({ workspaceId }) => { created.push(workspaceId); return { sessionId: 'sess-' + workspaceId + '-' + created.length } },
    rename: async () => ({}),
    prompt: async (request) => { prompted.push(request.sessionId); return {} },
  }
  return { services: { workspaceRegistry: registry, sessionController }, registry, created, prompted }
}
const ws = (id, title, sessionIds = []) => ({ id, title, path: 'D:\\dev\\' + title, sessionIds })

async function twoApps(t, { a = [ws('wa1', 'alpha'), ws('wa2', 'beta')], b = [ws('wb1', 'gamma')] } = {}) {
  const world = await makeWorld(t)
  await world.startHub()
  const hostA = host(a)
  const hostB = host(b)
  const A = await startPlugin(t, world, { label: 'DSH :1', webPort: 14001, services: hostA.services })
  const B = await startPlugin(t, world, { label: 'DSH :2', webPort: 14002, services: hostB.services })
  await Promise.all([A.inState('hub'), B.inState('hub')])
  return { world, A, B, hostA, hostB }
}
const optionsOf = async (app) => (await app.get('/v1/workspaces')).json.workspaces
const idOf = (list, title) => list.find((w) => w.title === title)?.id

test('the overlay lists the workspaces of every app, its own first, with hub ids', async (t) => {
  const { A } = await twoApps(t)
  const list = await waitFor(async () => { const l = await optionsOf(A); return l.length === 3 && l }, 5000, 'three workspaces')
  assert.deepEqual(list.map((w) => w.title), ['alpha', 'beta', 'gamma (DSH :2)'])
  assert.ok(list.every((w) => /^[0-9a-f]{4}\/w[ab][0-9]$/.test(w.id)), 'ids are <instance short>/<workspace id>')
})

test('a todo added with a workspace of this app starts at once in that workspace', async (t) => {
  const { A, hostA } = await twoApps(t)
  const list = await waitFor(async () => { const l = await optionsOf(A); return l.length === 3 && l }, 5000, 'workspaces')
  const res = await A.post('/v1/todo', { text: 'do the thing', workspaceId: idOf(list, 'beta') })
  assert.deepEqual([res.status, res.json.ok], [200, true])
  await waitFor(() => hostA.prompted.length === 1, 5000, 'the session was prompted')
  assert.deepEqual(hostA.created, ['wa2'], 'the app got its own workspace id, not the hub id')
  const card = await waitFor(async () => (await A.snapshot()).resolved.find((i) => i.type === 'todo' && i.state === 'started'), 5000, 'the todo started')
  assert.equal(card.workspaceTitle, 'beta')
})

test('a todo added with a workspace of ANOTHER app starts there', async (t) => {
  const { A, hostA, hostB } = await twoApps(t)
  const list = await waitFor(async () => { const l = await optionsOf(A); return l.length === 3 && l }, 5000, 'workspaces')
  const res = await A.post('/v1/todo', { text: 'do the other thing', workspaceId: idOf(list, 'gamma (DSH :2)') })
  assert.deepEqual([res.status, res.json.ok], [200, true])
  await waitFor(() => hostB.prompted.length === 1, 5000, 'the other app prompted the session')
  assert.deepEqual([hostA.created, hostB.created], [[], ['wb1']])
  await waitFor(async () => (await A.snapshot()).resolved.find((i) => i.type === 'todo' && i.state === 'started'), 5000, 'both overlays see it started')
})

test('"Choose for me" names a workspace of another app, the card confirms it with the hub id and the todo moves there', async (t) => {
  const { A, hostA, hostB } = await twoApps(t)
  await waitFor(async () => (await optionsOf(A)).length === 3, 5000, 'workspaces')
  const res = await A.post('/v1/todo', { text: 'fix gamma please' })
  assert.deepEqual([res.status, res.json.ok], [200, true])
  const card = await waitFor(async () => (await A.snapshot()).open.find((i) => i.type === 'todo' && i.suggested), 5000, 'a suggestion')
  const list = await optionsOf(A)
  assert.ok(list.some((w) => w.id === card.suggested.workspaceId), 'the suggestion is one of the dropdown options')
  const confirm = await A.post('/v1/todo-confirm', { id: card.id, workspaceId: card.suggested.workspaceId })
  assert.deepEqual([confirm.status, confirm.json.ok], [200, true])
  await waitFor(() => hostB.prompted.length === 1, 5000, 'the owner of the workspace started it')
  assert.deepEqual([hostA.created, hostB.created], [[], ['wb1']])
})

test('"Choose for me" with no clear fit waits for a pick; the picked hub id starts it', async (t) => {
  const { A, hostA } = await twoApps(t)
  await waitFor(async () => (await optionsOf(A)).length === 3, 5000, 'workspaces')
  const res = await A.post('/v1/todo', { text: 'something unrelated' })
  assert.equal(res.json.ok, true)
  const card = await waitFor(async () => (await A.snapshot()).open.find((i) => i.type === 'todo' && !i.suggesting), 5000, 'a pick card')
  assert.equal(card.state, 'awaiting-confirm')
  const list = await optionsOf(A)
  const confirm = await A.post('/v1/todo-confirm', { id: card.id, workspaceId: idOf(list, 'alpha') })
  assert.deepEqual([confirm.status, confirm.json.ok], [200, true])
  await waitFor(() => hostA.prompted.length === 1, 5000, 'started')
  assert.deepEqual(hostA.created, ['wa1'])
})

test('a workspace that appears in the registry after the app registered is in the very next list the overlay asks for', async (t) => {
  const { A, hostA } = await twoApps(t)
  await waitFor(async () => (await optionsOf(A)).length === 3, 5000, 'workspaces')
  hostA.registry.workspaces = [...hostA.registry.workspaces, ws('wa3', 'delta')]
  assert.ok((await optionsOf(A)).some((w) => w.title === 'delta'))
})

test('an app whose registry was still empty when it registered lists its workspaces as soon as the registry has them', async (t) => {
  const { A, hostA } = await twoApps(t, { a: [], b: [] })
  assert.deepEqual(await optionsOf(A), [])
  hostA.registry.workspaces = [ws('wa1', 'alpha')]
  assert.deepEqual((await optionsOf(A)).map((w) => w.title), ['alpha'])
})

test('a todo that waited for its confirm over a restart of the app is started with the workspace suggested before the restart', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const first = host([ws('wa1', 'alpha'), ws('wa2', 'beta')])
  const A1 = await startPlugin(t, world, { label: 'DSH :1', webPort: 14001, services: first.services })
  await A1.inState('hub')
  await waitFor(async () => (await optionsOf(A1)).length === 2, 5000, 'workspaces')
  assert.equal((await A1.post('/v1/todo', { text: 'fix alpha please' })).json.ok, true)
  const card = await waitFor(async () => (await A1.snapshot()).open.find((i) => i.type === 'todo' && i.suggested), 5000, 'a suggestion')
  await A1.agent.stop({ bye: false }) // DSH is restarted: the same app (same web port) comes back with a new instance id
  const second = host([ws('wa1', 'alpha'), ws('wa2', 'beta')])
  const A2 = await startPlugin(t, world, { label: 'DSH :1', webPort: 14001, services: second.services })
  await A2.inState('hub')
  await waitFor(() => world.hub.store.get(card.id)?.owner === A2.agent.instanceId, 5000, 'the card moved to the new app')
  assert.notEqual(card.suggested.workspaceId.slice(0, 4), world.hub.instances.short(A2.agent.instanceId), 'the suggestion carries the old instance part')
  const confirm = await A2.post('/v1/todo-confirm', { id: card.id, workspaceId: card.suggested.workspaceId })
  assert.deepEqual([confirm.status, confirm.json.ok], [200, true])
  await waitFor(() => second.prompted.length === 1, 5000, 'started')
  assert.deepEqual(second.created, ['wa1'])
})

test('a todo that could not start is retried from its card and starts', async (t) => {
  const { A, hostA } = await twoApps(t)
  await waitFor(async () => (await optionsOf(A)).length === 3, 5000, 'workspaces')
  const create = hostA.services.sessionController.create
  hostA.services.sessionController.create = async () => { throw new Error('no session now') }
  assert.equal((await A.post('/v1/todo', { text: 'will fail', workspaceId: idOf(await optionsOf(A), 'alpha') })).json.ok, true)
  const failed = await waitFor(async () => (await A.snapshot()).open.find((i) => i.type === 'todo' && i.state === 'failed'), 5000, 'a failed todo')
  hostA.services.sessionController.create = create
  const retry = await A.post('/v1/todo-confirm', { id: failed.id, workspaceId: idOf(await optionsOf(A), 'alpha') })
  assert.deepEqual([retry.status, retry.json.ok], [200, true])
  await waitFor(() => hostA.prompted.length === 1, 5000, 'started')
  assert.deepEqual(hostA.created, ['wa1'])
})
