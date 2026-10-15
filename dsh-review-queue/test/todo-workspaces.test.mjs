import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// In hub mode the coordinator suggests from the union of every instance's workspaces, not from its own registry.
const UNION = [{ id: 'aaaa/w1', title: 'dsh-plugins', path: 'D:/dev/ai/dsh-plugins', sessionIds: [] }, { id: 'bbbb/w1', title: 'Orca', path: 'D:/dev/ai/orca', sessionIds: [] }]
function setup(registry) {
  const store = createStore({ uuid: (() => { let n = 0; return () => 'i' + ++n })() })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), registryOf: () => registry, now: () => 5000 })
  return { store, queue }
}

test('a todo added with a workspace list names a workspace of that list, even with no registry of its own', () => {
  const { store, queue } = setup(undefined)
  const added = queue.addTodo('fix the dsh-plugins hub', { workspaces: UNION })
  assert.equal(added.state, 'awaiting-confirm')
  assert.deepEqual(store.get(added.id).suggested, { workspaceId: 'aaaa/w1', title: 'dsh-plugins', reason: 'named in the text' })
})

test('the list wins over the registry of the instance, which may know other workspaces', () => {
  const { store, queue } = setup({ list: () => [{ id: 'local', title: 'Orca', path: 'D:/o' }], archivedSessionIds: [] })
  const added = queue.addTodo('look at orca', { workspaces: UNION })
  assert.equal(store.get(added.id).suggested.workspaceId, 'bbbb/w1')
})
