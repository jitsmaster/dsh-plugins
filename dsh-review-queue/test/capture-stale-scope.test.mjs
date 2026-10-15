import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cancelStalePending } from '../capture.js'
import { createStore } from '../store.js'

// In standalone mode only items captured before this process can be stale; a question this process is waiting on must stay.
test('cancelStalePending with a scope cancels only the listed items', () => {
  const store = createStore()
  const old = store.add({ type: 'question', sessionId: 's1', payload: {} })
  const oldPerm = store.add({ type: 'permission', sessionId: 's1', payload: {} })
  const fresh = store.add({ type: 'question', sessionId: 's2', payload: {} })
  const done = store.add({ type: 'completed', sessionId: 's3', payload: {} })
  assert.equal(cancelStalePending(store, { only: new Set([old.id, oldPerm.id, done.id]) }), 2)
  assert.equal(store.get(old.id).resolution.by, 'restart')
  assert.equal(store.get(oldPerm.id).status, 'resolved')
  assert.equal(store.get(fresh.id).status, 'open', 'captured by this process: its promise is alive')
  assert.equal(store.get(done.id).status, 'open', 'finished work always stays')
})

test('cancelStalePending without a scope is unchanged: every open question and permission', () => {
  const store = createStore()
  const a = store.add({ type: 'question', sessionId: 's1', payload: {} })
  const b = store.add({ type: 'permission', sessionId: 's2', payload: {} })
  assert.equal(cancelStalePending(store), 2)
  assert.deepEqual([store.get(a.id).status, store.get(b.id).status], ['resolved', 'resolved'])
})

test('a scoped todo that was starting becomes failed, one outside the scope is left alone', () => {
  const store = createStore()
  const old = store.add({ type: 'todo', state: 'starting', payload: {} })
  const fresh = store.add({ type: 'todo', state: 'starting', payload: {} })
  cancelStalePending(store, { only: new Set([old.id]) })
  assert.equal(store.get(old.id).state, 'failed')
  assert.equal(store.get(fresh.id).state, 'starting')
})
