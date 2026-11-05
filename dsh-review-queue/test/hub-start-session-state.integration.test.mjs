import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHubApp } from './hub-app-helpers.mjs'
import { makeWorld, waitFor } from './plugin-helpers.mjs'

// start_session (dsh-session-link/starter.js) rejects any answer whose state is not 'awaiting-confirm'. In hub mode the answer travels
// hubQueue.addTodo -> hub todo-link -> coordinator todo-suggest -> the app's own queue, so the state must survive every hop.

const SOURCE = { sessionId: 'sa1', title: 'Requester' }

async function oneApp(t) {
  const world = await makeWorld(t)
  await world.startHub()
  const A = await startHubApp(t, world, { label: 'DSH :1', webPort: 12101, workspaces: () => [{ id: 'w1', title: 'alpha', path: 'D:/a' }] })
  await A.inState('hub')
  await waitFor(() => A.hubQueue.workspaces()?.length === 1, 8000, 'the hub workspace list')
  return { world, A }
}

test('hub mode: addTodo with requireConfirm and a hub workspace answers awaiting-confirm and stores a waiting card, not a started session', async (t) => {
  const { world, A } = await oneApp(t)
  const [workspace] = A.hubQueue.workspaces()
  const res = await A.hubQueue.addTodo('fix the engine', { workspaceId: workspace.id, sparc: true, requireConfirm: true, source: SOURCE })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.state, 'awaiting-confirm')
  const item = await waitFor(() => world.hub.store.get(res.id), 8000, 'the hub copy')
  assert.deepEqual([item.state, item.source], ['awaiting-confirm', SOURCE])
  assert.equal(item.suggested?.title, workspace.title)
})

test('hub mode: addTodo with requireConfirm and no workspace also answers awaiting-confirm', async (t) => {
  const { A } = await oneApp(t)
  const res = await A.hubQueue.addTodo('fix the engine', { requireConfirm: true, source: SOURCE })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.state, 'awaiting-confirm')
})
