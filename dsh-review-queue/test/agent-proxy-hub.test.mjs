// The proxy against a real hub with two apps (real pieces, test/hub-app-helpers.mjs): the workspace union, D7 focus on an item of the other app,
// and the hub being killed and coming back (degraded notice, read-only foreign items, promotion back to hub mode).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHubApp } from './hub-app-helpers.mjs'
import { makeWorld, waitFor } from './plugin-helpers.mjs'

async function twoApps(t) {
  const world = await makeWorld(t)
  await world.startHub()
  const A = await startHubApp(t, world, { label: 'DSH :1', webPort: 11001, workspaces: () => [{ id: 'w1', title: 'alpha', path: 'D:/a' }] })
  const B = await startHubApp(t, world, { label: 'DSH :2', webPort: 11002, workspaces: () => [{ id: 'w1', title: 'beta', path: 'D:/b' }] })
  await Promise.all([A.inState('hub'), B.inState('hub')])
  return { world, A, B }
}
const done = (app, sessionId) => app.store.add({ type: 'completed', sessionId, sessionTitle: sessionId, summary: 'Did ' + sessionId, payload: { reply: 'r' } })
const get = async (app, path) => (await fetch(app.base + path)).json()
const post = async (app, path, body) => { const r = await fetch(app.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }

test('workspaces: each app gets the union of both, its own first', async (t) => {
  const { A, B } = await twoApps(t)
  await waitFor(async () => (await get(A, '/v1/workspaces')).workspaces.length === 2, 5000, 'union at A')
  assert.deepEqual((await get(A, '/v1/workspaces')).workspaces.map((w) => w.title), ['alpha', 'beta (DSH :2)'])
  assert.deepEqual((await get(B, '/v1/workspaces')).workspaces.map((w) => w.title), ['beta', 'alpha (DSH :1)'])
})

test('both overlays list the same items; focus on an item of the other app works and stays in this app', async (t) => {
  const { A, B } = await twoApps(t)
  const a1 = done(A, 'sa1')
  await waitFor(() => B.mirrored(a1.id) && A.mirrored(a1.id), 5000, 'mirrors')
  const [sa, sb] = [await get(A, '/v1/snapshot'), await get(B, '/v1/snapshot')]
  assert.deepEqual(sa.open.map((i) => [i.id, i.position]), sb.open.map((i) => [i.id, i.position]))
  assert.equal((await post(B, '/v1/focus', { id: a1.id })).status, 200)
  assert.equal((await get(B, '/v1/snapshot')).focusId, a1.id)
  assert.equal((await get(A, '/v1/snapshot')).focusId, undefined)
})

test('the hub is killed: the notice, the last list of the other app read-only, own items local; a restarted hub brings hub mode back', async (t) => {
  const { world, A, B } = await twoApps(t)
  const a1 = done(A, 'sa1')
  const b1 = done(B, 'sb1')
  await waitFor(() => A.mirrored(b1.id) && B.mirrored(a1.id), 5000, 'mirrors')
  await world.killHub()
  await Promise.all([A.inState('degraded'), B.inState('degraded')])
  const down = await get(B, '/v1/snapshot')
  assert.match(down.notice.text, /^Phone sync is off: hub unreachable\./)
  assert.deepEqual(down.open.map((i) => i.id).sort(), [a1.id, b1.id].sort())
  assert.equal(down.open.find((i) => i.id === a1.id).ownerState, 'gone')
  const foreign = await post(B, '/v1/reviewed', { id: a1.id })
  assert.deepEqual([foreign.status, foreign.json.error], [409, 'owner-offline'])
  assert.equal((await post(B, '/v1/reviewed', { id: b1.id })).status, 200)
  await world.startHub()
  await Promise.all([A.inState('hub'), B.inState('hub')])
  await waitFor(async () => (await get(B, '/v1/snapshot')).notice === undefined, 5000, 'notice gone')
  await waitFor(() => world.hub.store.get(b1.id)?.status === 'resolved', 8000, 'the offline decision reached the hub')
  assert.equal((await get(A, '/v1/snapshot')).open.some((i) => i.id === a1.id), true)
})
