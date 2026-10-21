import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHubApp } from './hub-app-helpers.mjs'
import { makeWorld, waitFor } from './plugin-helpers.mjs'

// Two real apps (store adapter, service, executor, agent client, hub queue, router, proxy) on a real hub, each with its own fake session controller:
// "+ New todo" in Follow-up mode on app A finds a session of app B, and the message is queued as a prompt of that session in B.

const TITLES = { sa1: 'Orca engine tuning', sb1: 'PR 6556 review', sb2: 'Docs cleanup' }
const titlesOf = async (ids) => new Map(ids.filter((id) => TITLES[id]).map((id) => [id, TITLES[id]]))

function controller(items, { failFirst = false } = {}) {
  const prompts = []
  let failed = false
  return {
    prompts,
    list: async () => ({ items }),
    prompt: async (req) => {
      if (failFirst && !failed) { failed = true; throw new Error('the session is busy') }
      prompts.push(req)
      return {}
    },
  }
}
const session = (sessionId, updatedAt) => ({ sessionId, updatedAt, running: false, blank: false })

async function twoApps(t, { failFirstB = false } = {}) {
  const world = await makeWorld(t)
  await world.startHub()
  const ca = controller([session('sa1', 1000)])
  const cb = controller([session('sb1', 3000), session('sb2', 2000)], { failFirst: failFirstB })
  const A = await startHubApp(t, world, { label: 'DSH :1', webPort: 12001, services: { sessionController: ca }, config: { queue: { titlesOf } }, workspaces: () => [] })
  const B = await startHubApp(t, world, { label: 'DSH :2', webPort: 12002, services: { sessionController: cb }, config: { queue: { titlesOf } }, workspaces: () => [] })
  await Promise.all([A.inState('hub'), B.inState('hub')])
  return { world, A, B, ca, cb }
}
const get = async (app, path) => { const r = await fetch(app.base + path); return { status: r.status, json: await r.json() } }
const post = async (app, path, body) => { const r = await fetch(app.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
const added = async (A, text, followUp) => {
  const res = await post(A, '/v1/todo', { text, followUp })
  assert.deepEqual([res.status, res.json.ok, res.json.state], [200, true, 'awaiting-confirm'], JSON.stringify(res.json))
  return res.json.id
}

test('the follow-up item of app A lists the sessions of both apps, each with the app it lives in, and suggests the one named by number', async (t) => {
  const { world, A, B } = await twoApps(t)
  const id = await added(A, 'add a null check', 'the PR 6556 one')
  const item = await waitFor(() => { const i = A.store.get(id); return i?.suggested && i }, 8000, 'the suggestion')
  assert.deepEqual(item.candidates.map((c) => [c.sessionId, c.title, c.owner]).sort(), [['sa1', 'Orca engine tuning', A.agent.instanceId], ['sb1', 'PR 6556 review', B.agent.instanceId], ['sb2', 'Docs cleanup', B.agent.instanceId]].sort())
  assert.deepEqual([item.suggested.sessionId, item.suggested.owner], ['sb1', B.agent.instanceId])
  assert.equal(world.hub.store.get(id).owner, A.agent.instanceId)
  assert.deepEqual([item.kind, item.state, item.query], ['followup', 'awaiting-confirm', 'the PR 6556 one'])
})

test('confirming the suggestion sends the message to the session of app B, where the item moves and ends followed-up; app A lets go of it', async (t) => {
  const { world, A, B, ca, cb } = await twoApps(t)
  const id = await added(A, 'add a null check', 'the PR 6556 one')
  await waitFor(() => A.store.get(id)?.suggested, 8000, 'the suggestion')
  const res = await post(A, '/v1/todo-confirm', { id })
  assert.deepEqual([res.status, res.json.ok], [200, true], JSON.stringify(res.json))
  await waitFor(() => world.hub.store.get(id)?.status === 'resolved', 8000, 'the item ended')
  assert.deepEqual(world.hub.store.get(id).resolution, { kind: 'followed-up', by: 'card', sessionId: 'sb1' })
  assert.equal(world.hub.store.get(id).owner, B.agent.instanceId)
  assert.deepEqual(cb.prompts.map((p) => [p.sessionId, p.mode, p.content]), [['sb1', 'queue', [{ type: 'text', text: 'add a null check' }]]])
  assert.deepEqual(ca.prompts, [], 'nothing was sent in app A')
  await waitFor(() => A.store.get(id) === undefined, 5000, 'app A dropped its copy')
})

test('a session of app A\'s own is sent to by app A, and the item stays there', async (t) => {
  const { world, A, B, ca, cb } = await twoApps(t)
  const id = await added(A, 'tune it', 'the orca thing')
  await waitFor(() => A.store.get(id)?.candidates?.length === 3, 8000, 'candidates')
  assert.equal((await post(A, '/v1/todo-confirm', { id, sessionId: 'sa1' })).status, 200)
  await waitFor(() => world.hub.store.get(id)?.status === 'resolved', 8000, 'the item ended')
  assert.deepEqual(ca.prompts.map((p) => [p.sessionId, p.content[0].text]), [['sa1', 'tune it']])
  assert.deepEqual(cb.prompts, [])
  assert.equal(world.hub.store.get(id).owner, A.agent.instanceId)
  assert.equal(B.store.get(id), undefined)
})

test('a send that fails in app B shows on the card as failed, and Retry (a second confirm) sends it once', async (t) => {
  const { world, A, cb } = await twoApps(t, { failFirstB: true })
  const id = await added(A, 'add a null check', 'the PR 6556 one')
  await waitFor(() => A.store.get(id)?.suggested, 8000, 'the suggestion')
  assert.equal((await post(A, '/v1/todo-confirm', { id, sessionId: 'sb2' })).status, 200)
  const failed = await waitFor(() => { const i = world.hub.store.get(id); return i?.state === 'failed' && i }, 8000, 'failed on the hub')
  assert.equal(failed.error, 'May have been sent: check the session before retrying.', 'a fixed text: the controller\'s own words (here "busy") stay in app B; an unclassified rejection may have been delivered')
  assert.equal(failed.status, 'open')
  assert.deepEqual(cb.prompts, [])
  assert.equal((await post(A, '/v1/todo-confirm', { id, sessionId: 'sb2' })).status, 200)
  await waitFor(() => world.hub.store.get(id)?.status === 'resolved', 8000, 'the retry ended it')
  assert.deepEqual(cb.prompts.map((p) => [p.sessionId, p.content[0].text]), [['sb2', 'add a null check']])
})

test('a session nobody lists is 400 unknown-session at the hub and nothing is sent', async (t) => {
  const { A, ca, cb } = await twoApps(t)
  const id = await added(A, 'x', 'words')
  await waitFor(() => A.store.get(id)?.candidates?.length === 3, 8000, 'candidates')
  const res = await post(A, '/v1/todo-confirm', { id, sessionId: 'nope' })
  assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'unknown-session' }])
  assert.deepEqual([ca.prompts, cb.prompts], [[], []])
})

test('there is no session list route: the union is made inside the hub for a follow-up, nobody reads it from outside', async (t) => {
  const { A } = await twoApps(t)
  const res = await get(A, '/v1/followup-sessions')
  assert.deepEqual([res.status, res.json], [404, { error: 'unknown-action' }])
})
