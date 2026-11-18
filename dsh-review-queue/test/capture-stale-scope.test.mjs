import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cancelStalePending, markStaleQuestions } from '../capture.js'
import { createStore } from '../store.js'

// In standalone mode only items captured before this process can be stale; a question this process is waiting on must stay.
test('cancelStalePending with a scope cancels only the listed items', () => {
  const store = createStore()
  const old = store.add({ type: 'question', sessionId: 's1', payload: {} })
  const oldPerm = store.add({ type: 'permission', sessionId: 's1', payload: {} })
  const fresh = store.add({ type: 'question', sessionId: 's2', payload: {} })
  const done = store.add({ type: 'completed', sessionId: 's3', payload: {} })
  assert.equal(cancelStalePending(store, { only: new Set([old.id, oldPerm.id, done.id]) }), 1)
  assert.equal(store.get(old.id).status, 'open', 'a question survives a restart as a detached card')
  assert.equal(store.get(old.id).detached, true)
  assert.equal(store.get(oldPerm.id).resolution.by, 'restart')
  assert.equal(store.get(oldPerm.id).status, 'resolved')
  assert.equal(store.get(fresh.id).status, 'open', 'captured by this process: its promise is alive')
  assert.equal(store.get(done.id).status, 'open', 'finished work always stays')
})

test('cancelStalePending without a scope: every open question turns detached, every permission is cancelled', () => {
  const store = createStore()
  const a = store.add({ type: 'question', sessionId: 's1', payload: {} })
  const b = store.add({ type: 'permission', sessionId: 's2', payload: {} })
  assert.equal(cancelStalePending(store), 1)
  assert.deepEqual([store.get(a.id).status, store.get(b.id).status], ['open', 'resolved'])
  assert.equal(store.get(a.id).detached, true)
})

test('cancelStalePending logs the id and type of every item it ends or detaches, and nothing for the ones it leaves', () => {
  const logs = []
  const store = createStore()
  const q = store.add({ type: 'question', sessionId: 's1', payload: {} })
  const p = store.add({ type: 'permission', sessionId: 's2', payload: {} })
  const d = store.add({ type: 'completed', sessionId: 's3', payload: {} })
  assert.equal(cancelStalePending(store, { log: (line) => logs.push(line) }), 1)
  assert.equal(logs.length, 2, logs.join(' | '))
  assert.ok(logs.some((l) => l.includes(q.id) && l.includes('question') && l.includes('detached')), logs.join(' | '))
  assert.ok(logs.some((l) => l.includes(p.id) && l.includes('permission')), logs.join(' | '))
  assert.ok(!logs.some((l) => l.includes(d.id)))
})

test('an already detached question is left as it is and not logged again', () => {
  const logs = []
  const store = createStore()
  const q = store.add({ type: 'question', sessionId: 's1', payload: {}, detached: true, restarted: true })
  assert.equal(cancelStalePending(store, { log: (line) => logs.push(line) }), 0)
  assert.equal(store.get(q.id).status, 'open')
  assert.equal(logs.length, 0)
})

test('a scoped todo that was starting becomes failed, one outside the scope is left alone', () => {
  const store = createStore()
  const old = store.add({ type: 'todo', state: 'starting', payload: {} })
  const fresh = store.add({ type: 'todo', state: 'starting', payload: {} })
  cancelStalePending(store, { only: new Set([old.id]) })
  assert.equal(store.get(old.id).state, 'failed')
  assert.equal(store.get(fresh.id).state, 'starting')
})

test('a question detached by a restart is marked restarted, so its answer goes out as a new message', () => {
  const store = createStore()
  const q = store.add({ type: 'question', sessionId: 's1', payload: {} })
  cancelStalePending(store)
  assert.equal(store.get(q.id).restarted, true)
})


test('markStaleQuestions flags only the listed open questions (hub mode: before the first sync), leaves permissions alone, and is idempotent', () => {
  const store = createStore()
  const old = store.add({ type: 'question', sessionId: 's1', payload: {} })
  const live = store.add({ type: 'question', sessionId: 's2', payload: {} })
  const perm = store.add({ type: 'permission', sessionId: 's3', payload: {} })
  const only = new Set([old.id, perm.id])
  assert.equal(markStaleQuestions(store, { only }), 1)
  assert.deepEqual([store.get(old.id).detached, store.get(old.id).restarted], [true, true])
  assert.equal(store.get(live.id).detached, undefined)
  assert.equal(store.get(perm.id).status, 'open')
  assert.equal(markStaleQuestions(store, { only }), 0)
})
