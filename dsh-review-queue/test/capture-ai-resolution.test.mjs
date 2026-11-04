// Slice 2 of Auto triage: an optional caller-supplied resolution passes through decidePermission / answerQuestion; the default stays unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { installCapture } from '../capture.js'

function setup() {
  const handlers = {}
  const ctx = { on: (name, fn) => { (handlers[name] ??= []).push(fn) }, get: () => undefined, logger: { warn() {}, info() {} } }
  let n = 0
  const store = createStore({ now: () => 1000, uuid: () => 'i' + ++n })
  const capture = installCapture(ctx, { store, summarizer: { summarize: async () => ({ text: 'x', source: 'llm' }) } })
  const agent = () => ({ id: 'a1', session: { id: 'a1', header: { cwd: 'D:/proj' }, deriveMessages: () => [] } })
  const fire = (name, ...args) => handlers[name][0](...args)
  return { store, capture, agent, fire }
}
const QUESTIONS = [{ id: 'q1', question: 'Which port?', options: [{ label: 'A' }, { label: 'B' }] }]
const never = () => new Promise(() => {})
const ANS = [{ id: 'q1', selected: ['B'] }]
const AI = { kind: 'ai-resolved', by: 'ai', ruleId: 'r', action: 'approve' }

test('decidePermission with a resolution stores it instead of the default, once', async () => {
  const { store, capture, agent, fire } = setup()
  const p = fire('approval/request', { agent: agent(), toolName: 'shell', callId: 'c1' }, never)
  const [item] = store.snapshot().open
  assert.deepEqual(capture.decidePermission(item.id, 'approve', { resolution: AI }), { ok: true })
  assert.equal(await p, 'allowed-once')
  assert.deepEqual(store.get(item.id).resolution, AI)
  assert.deepEqual(capture.decidePermission(item.id, 'approve', { resolution: AI }), { ok: false, error: 'not-pending' })
})

test('decidePermission without a resolution keeps the default card resolution', async () => {
  const { store, capture, agent, fire } = setup()
  const p = fire('approval/request', { agent: agent(), toolName: 'shell', callId: 'c1' }, never)
  const [item] = store.snapshot().open
  capture.decidePermission(item.id, 'approve')
  await p
  assert.deepEqual(store.get(item.id).resolution, { kind: 'approved', by: 'card' })
})

test('answerQuestion with a resolution stores it instead of the default, once', async () => {
  const { store, capture, agent, fire } = setup()
  const p = fire('user-questions/request', { agent: agent(), questions: QUESTIONS, wait: { callId: 'c1' } }, never)
  const [item] = store.snapshot().open
  const res = { kind: 'ai-resolved', by: 'ai', ruleId: 'q', answers: ANS }
  assert.deepEqual(capture.answerQuestion(item.id, ANS, { resolution: res }), { ok: true })
  assert.deepEqual(await p, { answers: ANS })
  assert.deepEqual(store.get(item.id).resolution, res)
  assert.deepEqual(capture.answerQuestion(item.id, ANS, { resolution: res }), { ok: false, error: 'not-pending' })
})

test('answerQuestion without a resolution keeps the default answered resolution', async () => {
  const { store, capture, agent, fire } = setup()
  const p = fire('user-questions/request', { agent: agent(), questions: QUESTIONS, wait: { callId: 'c1' } }, never)
  const [item] = store.snapshot().open
  capture.answerQuestion(item.id, ANS)
  await p
  assert.deepEqual(store.get(item.id).resolution, { kind: 'answered', by: 'card', answers: ANS })
})
// store.resolveIf, the guarded resolve used for items without a pending entry (done cards).

test('resolveIf resolves an open item whose test passes and returns the resolve result', () => {
  const store = createStore({ now: () => 5, uuid: () => 'x1' })
  const { id } = store.add({ type: 'completed', payload: { reply: 'ok' } })
  let seen
  assert.equal(store.resolveIf(id, (i) => { seen = i; return true }, { kind: 'ai-resolved' }), true)
  assert.equal(seen.id, id)
  assert.equal(store.get(id).status, 'resolved')
  assert.equal(store.get(id).resolution.kind, 'ai-resolved')
})

test('resolveIf is false for missing, resolved, failing-test and throwing-test cases, and leaves the item open', () => {
  const store = createStore()
  const { id } = store.add({ type: 'completed', payload: {} })
  assert.equal(store.resolveIf('nope', () => true, { kind: 'x' }), false)
  assert.equal(store.resolveIf(id, () => false, { kind: 'x' }), false)
  assert.equal(store.resolveIf(id, () => { throw new Error('boom') }, { kind: 'x' }), false)
  assert.equal(store.get(id).status, 'open')
  store.resolve(id, { kind: 'reviewed' })
  assert.equal(store.resolveIf(id, () => true, { kind: 'x' }), false)
  assert.equal(store.get(id).resolution.kind, 'reviewed')
})


