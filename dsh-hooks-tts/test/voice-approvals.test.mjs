import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceApprovals } from '../voice/approvals.js'

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

test('with voice off, the waterfall is passed straight through', async () => {
  const v = createVoiceApprovals({ enabled: () => false })
  assert.equal(await v.intercept({ agent: { id: 'a' }, toolName: 'x' }, async () => 'allowed-once'), 'allowed-once')
  assert.equal(v.pendingCount(), 0)
})

test('approve answers the pending request before the GUI does', async () => {
  const v = createVoiceApprovals({ enabled: () => true })
  const gui = deferred()
  const p = v.intercept({ agent: { id: 'a' }, toolName: 'bash' }, () => gui.promise)
  assert.equal(v.pendingCount(), 1)
  assert.deepEqual(v.answer({ sessionId: 'a', decision: 'approve' }), { answered: true })
  assert.equal(await p, 'allowed-once')
  assert.equal(v.pendingCount(), 0)
})

test('deny maps to rejected', async () => {
  const v = createVoiceApprovals({ enabled: () => true })
  const p = v.intercept({ agent: { id: 'a' }, toolName: 'bash' }, () => new Promise(() => {}))
  v.answer({ sessionId: 'a', decision: 'deny' })
  assert.equal(await p, 'rejected')
})

test('the GUI answering first wins and clears the pending entry', async () => {
  const v = createVoiceApprovals({ enabled: () => true })
  const p = v.intercept({ agent: { id: 'a' }, toolName: 'bash' }, async () => 'rejected')
  assert.equal(await p, 'rejected')
  assert.equal(v.pendingCount(), 0)
  assert.throws(() => v.answer({ sessionId: 'a', decision: 'approve' }), /no pending/i)
})

test('answer targets the newest pending request of that session only', async () => {
  const v = createVoiceApprovals({ enabled: () => true })
  const forever = () => new Promise(() => {})
  const first = v.intercept({ agent: { id: 'a' }, toolName: 't1' }, forever)
  const other = v.intercept({ agent: { id: 'b' }, toolName: 't2' }, forever)
  const second = v.intercept({ agent: { id: 'a' }, toolName: 't3' }, forever)
  v.answer({ sessionId: 'a', decision: 'approve' })
  assert.equal(await second, 'allowed-once')
  assert.equal(v.pendingCount(), 2)
  v.answer({ sessionId: 'b', decision: 'deny' })
  assert.equal(await other, 'rejected')
  v.answer({ sessionId: 'a', decision: 'deny' })
  assert.equal(await first, 'rejected')
})

test('an aborted request is dropped', async () => {
  const v = createVoiceApprovals({ enabled: () => true })
  const ac = new AbortController()
  const p = v.intercept({ agent: { id: 'a' }, toolName: 'x', signal: ac.signal }, () => new Promise(() => {}))
  ac.abort()
  assert.equal(await p, 'cancelled')
  assert.equal(v.pendingCount(), 0)
})

test('option answers are not supported for permission requests', () => {
  const v = createVoiceApprovals({ enabled: () => true })
  v.intercept({ agent: { id: 'a' }, toolName: 'x' }, () => new Promise(() => {}))
  assert.throws(() => v.answer({ sessionId: 'a', decision: 'option', number: 2 }), /not supported/i)
})

test('describe lists what each session is waiting on', async () => {
  const v = createVoiceApprovals({ enabled: () => true })
  v.intercept({ agent: { id: 'a' }, toolName: 'bash' }, () => new Promise(() => {}))
  assert.deepEqual(v.pending(), [{ sessionId: 'a', toolName: 'bash' }])
})
