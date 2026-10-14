// Which ask_user_question calls are pending: noted before the alert hooks run, released at the tool's result.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPendingQuestions } from '../voice/pending-questions.js'

test('PQ1 only ask tools are tracked, under both spellings', () => {
  const pq = createPendingQuestions()
  pq.note({ sessionId: 'a', callId: '1', name: 'ask_user_question' })
  pq.note({ sessionId: 'a', callId: '2', name: 'AskUserQuestion' })
  pq.note({ sessionId: 'a', callId: '3', name: 'pwsh' })
  assert.deepEqual(pq.list(), [{ sessionId: 'a', callId: '1' }, { sessionId: 'a', callId: '2' }])
})

test('PQ2 release() by session + call id and the returned releaser both drop only that call', () => {
  const pq = createPendingQuestions()
  const done = pq.note({ sessionId: 'a', callId: '1', name: 'ask_user_question' })
  pq.note({ sessionId: 'a', callId: '2', name: 'ask_user_question' })
  pq.note({ sessionId: 'b', callId: '1', name: 'ask_user_question' })
  pq.release({ sessionId: 'a', callId: '2' })
  assert.deepEqual(pq.list(), [{ sessionId: 'a', callId: '1' }, { sessionId: 'b', callId: '1' }])
  done(); done() // idempotent
  assert.deepEqual(pq.list(), [{ sessionId: 'b', callId: '1' }])
})

test('PQ3 a call that never settles does not stay pending: its signal aborts, its session closes, or it ages out', () => {
  let t = 0
  const pq = createPendingQuestions({ now: () => t, maxAgeMs: 1000 })
  const ac = new AbortController()
  pq.note({ sessionId: 'a', callId: '1', name: 'ask_user_question', signal: ac.signal })
  pq.note({ sessionId: 'b', callId: '1', name: 'ask_user_question' })
  pq.note({ sessionId: 'c', callId: '1', name: 'ask_user_question' })
  ac.abort()
  assert.deepEqual(pq.list().map((q) => q.sessionId), ['b', 'c'])
  pq.dropSession('b')
  assert.deepEqual(pq.list().map((q) => q.sessionId), ['c'])
  t = 1001
  assert.deepEqual(pq.list(), [])
})

test('PQ3 an already aborted signal is not tracked', () => {
  const pq = createPendingQuestions()
  pq.note({ sessionId: 'a', callId: '1', name: 'ask_user_question', signal: AbortSignal.abort() })
  assert.deepEqual(pq.list(), [])
})
