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

test('peek returns the latest pending request of a session with an identity token', () => {
  const a = createVoiceApprovals({ enabled: () => true })
  a.intercept({ agent: { id: 's' }, toolName: 'Bash' }, () => new Promise(() => {}))
  const p1 = a.peek({ sessionId: 's' })
  assert.equal(p1.toolName, 'Bash')
  a.intercept({ agent: { id: 's' }, toolName: 'Write' }, () => new Promise(() => {}))
  const p2 = a.peek({ sessionId: 's' })
  assert.equal(p2.toolName, 'Write')
  assert.notEqual(p1.token, p2.token)
  assert.equal(a.peek({ sessionId: 'none' }), undefined)
})

test('peek carries the bounded summary of the request (from summaryOf) and how many requests the session has pending', () => {
  const seen = []
  const a = createVoiceApprovals({ enabled: () => true, summaryOf: (req) => { seen.push(req.callId); return 'rm -rf build' } })
  const forever = () => new Promise(() => {})
  a.intercept({ agent: { id: 's' }, toolName: 'pwsh', callId: 'c1' }, forever)
  assert.deepEqual(seen, ['c1'])
  assert.equal(a.peek({ sessionId: 's' }).summary, 'rm -rf build')
  assert.equal(a.peek({ sessionId: 's' }).count, 1)
  a.intercept({ agent: { id: 's' }, toolName: 'pwsh', callId: 'c2' }, forever)
  a.intercept({ agent: { id: 'other' }, toolName: 'pwsh', callId: 'c3' }, forever)
  assert.equal(a.peek({ sessionId: 's' }).count, 2, 'only requests of that session are counted')
  assert.equal(a.peek({ sessionId: 'other' }).count, 1)
})

test('peek has no summary when the tool input is unknown, and a throwing summaryOf never breaks the request', async () => {
  const none = createVoiceApprovals({ enabled: () => true })
  none.intercept({ agent: { id: 's' }, toolName: 'pwsh' }, () => new Promise(() => {}))
  assert.equal(none.peek({ sessionId: 's' }).summary, undefined)
  const bad = createVoiceApprovals({ enabled: () => true, summaryOf: () => { throw new Error('boom') } })
  const p = bad.intercept({ agent: { id: 's' }, toolName: 'pwsh' }, () => new Promise(() => {}))
  assert.equal(bad.peek({ sessionId: 's' }).summary, undefined)
  bad.answer({ sessionId: 's', decision: 'approve' })
  assert.equal(await p, 'allowed-once')
})

test('F2c peek carries whether the summary is complete: only an explicit { text, complete: true } counts', () => {
  const forever = () => new Promise(() => {})
  const make = (result) => { const a = createVoiceApprovals({ enabled: () => true, summaryOf: () => result }); a.intercept({ agent: { id: 's' }, toolName: 'pwsh' }, forever); return a.peek({ sessionId: 's' }) }
  assert.deepEqual([make({ text: 'npm test', complete: true }).summary, make({ text: 'npm test', complete: true }).complete], ['npm test', true])
  assert.equal(make({ text: 'npm test and more', complete: false }).complete, false)
  assert.equal(make({ text: 'npm test' }).complete, false)
  assert.equal(make('npm test').summary, 'npm test')
  assert.equal(make('npm test').complete, false, 'a bare string says nothing about completeness')
  assert.equal(make(undefined).complete, false)
  assert.equal(make({ complete: true }).complete, false, 'no text, nothing to approve')
  assert.equal(make({ complete: true }).summary, undefined)
})
