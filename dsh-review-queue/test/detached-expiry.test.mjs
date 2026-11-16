// The one place that expires older detached questions (used by capture.js and the question merge).
import test from 'node:test'
import assert from 'node:assert/strict'
import { expireDetachedQuestions } from '../detached-expiry.js'

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