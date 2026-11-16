// The one place that expires older detached questions (used by capture.js and the question merge).
import test from 'node:test'
import assert from 'node:assert/strict'
import { expireDetachedQuestions, openOfSession } from '../detached-expiry.js'

const item = (id, extra = {}) => ({ id, type: 'question', detached: true, payload: { questions: [{ options: [{ label: 'A (Recommended)' }] }] }, ...extra })

test('expires detached questions with the recommended option as assumed, leaving the rest', () => {
  const resolved = []
  const store = { resolve: (id, r) => resolved.push([id, r]) }
  expireDetachedQuestions(store, [item('a'), item('live', { detached: false }), item('done', { type: 'completed' })])
  assert.deepEqual(resolved, [['a', { kind: 'expired', assumed: ['A (Recommended)'] }]])
})

test('skip() spares an item', () => {
  const resolved = []
  expireDetachedQuestions({ resolve: (id) => resolved.push(id) }, [item('a'), item('b')], { skip: (i) => i.id === 'a' })
  assert.deepEqual(resolved, ['b'])
})

test('onError gets a failing resolve and the loop goes on; without it the error propagates', () => {
  const errors = []
  const store = { resolve: (id) => { if (id === 'a') throw new Error('boom'); resolved.push(id) } }
  const resolved = []
  expireDetachedQuestions(store, [item('a'), item('b')], { onError: (e) => errors.push(e.message) })
  assert.deepEqual([errors, resolved], [['boom'], ['b']])
  assert.throws(() => expireDetachedQuestions(store, [item('a')]), /boom/)
})

test('a truthy non-boolean detached flag counts as detached', () => {
  const resolved = []
  expireDetachedQuestions({ resolve: (id) => resolved.push(id) }, [item('a', { detached: 1 }), item('b', { detached: 0 })])
  assert.deepEqual(resolved, ['a'])
})

test('openOfSession reads the store index when it has one, else filters the open list by session', () => {
  const a = { id: 'a', sessionId: 's1', status: 'open' }
  const stale = { id: 'x', sessionId: 's1', status: 'resolved' }
  const withIndex = { peekOpen: (s) => (s === 's1' ? [a, stale] : []), list: () => assert.fail('list is not used when peekOpen exists') }
  assert.deepEqual(openOfSession(withIndex, 's1'), [a, stale], 'the index is trusted as is by default')
  assert.deepEqual(openOfSession(withIndex, 's1', { onlyOpen: true }), [a], 'onlyOpen drops anything not open')
  const b = { id: 'b', sessionId: 's2', status: 'open' }
  const plain = { list: ({ status }) => { assert.equal(status, 'open'); return [a, b] } }
  assert.deepEqual(openOfSession(plain, 's2'), [b])
  assert.deepEqual(openOfSession(plain, 's2', { onlyOpen: true }), [b])
})
