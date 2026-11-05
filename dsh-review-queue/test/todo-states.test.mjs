import test from 'node:test'
import assert from 'node:assert/strict'
import { todoStatesOf } from '../todo-states.js'
import { setupFollowUp } from './follow-up-helpers.mjs'

const item = (o) => ({ type: 'todo', kind: 'followup', status: 'open', state: 'awaiting-confirm', text: 't', source: { sessionId: 'me', title: 'Me' }, ...o })
const snap = { open: [item({ id: 'a' }), item({ id: 'b', source: { sessionId: 'other' } }), { type: 'completed', id: 'c' }, item({ id: 'd', state: 'starting', targetSessionId: 's2' })], resolved: [item({ id: 'e', status: 'resolved', state: 'started', sessionId: 's1', sessionTitle: 'One', mode: 'steer' })] }

test('only follow-up items created by this sender, open first then resolved', () => {
  assert.deepEqual(todoStatesOf(snap, { senderId: 'me' }).map((s) => s.id), ['a', 'd', 'e'])
})
test('can be narrowed to one target (sent or chosen)', () => {
  assert.deepEqual(todoStatesOf(snap, { senderId: 'me', targetSessionId: 's1' }).map((s) => s.id), ['e'])
  assert.deepEqual(todoStatesOf(snap, { senderId: 'me', targetSessionId: 's2' }).map((s) => s.id), ['d'])
})
test('an invalid or missing sender gives none; the text is clipped', () => {
  assert.deepEqual(todoStatesOf(snap, {}), [])
  assert.equal(todoStatesOf({ open: [item({ id: 'z', text: 'x'.repeat(9000) })], resolved: [] }, { senderId: 'me' })[0].text.length <= 4000, true)
})
test('mode is steer or queue; fields are the documented ones', () => {
  const [a, , e] = todoStatesOf(snap, { senderId: 'me' })
  assert.equal(a.mode, 'queue')
  assert.equal(e.mode, 'steer')
  assert.deepEqual(e, { id: 'e', kind: 'followup', state: 'started', status: 'resolved', text: 't', mode: 'steer', targetSessionId: undefined, sessionId: 's1', sessionTitle: 'One' })
})
test('the service lists a waiting card created by addTodo with a source', () => {
  const f = setupFollowUp()
  const sessions = [{ sessionId: 's-pr', title: 'PR 6556 review' }]
  const r = f.queue.addTodo('Please look at the engine tuning', { followUp: 'engine', sessions, mode: 'steer', source: { sessionId: 'me', title: 'Me' } })
  assert.equal(r.ok, true)
  const states = f.queue.todoStates({ senderId: 'me' })
  assert.equal(states.length, 1)
  assert.equal(states[0].id, r.id)
  assert.equal(states[0].mode, 'steer')
  assert.equal(states[0].state, 'awaiting-confirm')
  assert.deepEqual(f.queue.todoStates({ senderId: 'someone-else' }), [])
})

test('a waiting one-match card is found by its target through suggested.sessionId', () => {
  const waiting = item({ id: 'w', suggested: { sessionId: 's9', title: 'Nine', reason: 'picked by you' }, candidates: [{ sessionId: 's9', title: 'Nine' }, { sessionId: 's8', title: 'Eight' }] })
  const several = item({ id: 'v', candidates: [{ sessionId: 's9', title: 'Nine' }, { sessionId: 's8', title: 'Eight' }] })
  const s = { open: [waiting, several], resolved: [] }
  assert.deepEqual(todoStatesOf(s, { senderId: 'me', targetSessionId: 's9' }).map((x) => x.id), ['w'])
  assert.deepEqual(todoStatesOf(s, { senderId: 'me', targetSessionId: 's8' }), [])
})

test('todoStatesOf(null) and a missing snapshot give []', () => {
  assert.deepEqual(todoStatesOf(null), [])
  assert.deepEqual(todoStatesOf(null, { senderId: 'me' }), [])
  assert.deepEqual(todoStatesOf(undefined, { senderId: 'me' }), [])
})

const plainTodo = (o) => ({ type: 'todo', status: 'open', state: 'awaiting-confirm', text: 'go', source: { sessionId: 'me', title: 'Me' }, ...o })
test('both card kinds of the sender are listed; a plain todo without source is not', () => {
  const s = { open: [plainTodo({ id: 'n1', suggested: { workspaceId: 'w1', title: 'Alpha', reason: 'r' } }), plainTodo({ id: 'n2', source: undefined }), plainTodo({ id: 'n3', source: { sessionId: 'other' } }), item({ id: 'f1' })], resolved: [plainTodo({ id: 'n4', status: 'resolved', state: 'started', sessionId: 'ns', workspaceTitle: 'Beta' })] }
  const r = todoStatesOf(s, { senderId: 'me' })
  assert.deepEqual(r.map((x) => [x.id, x.kind]), [['n1', 'newsession'], ['f1', 'followup'], ['n4', 'newsession']])
  assert.equal(r[0].workspaceTitle, 'Alpha')
  assert.equal(r[2].workspaceTitle, 'Beta')
  assert.equal(r[2].sessionId, 'ns')
})
test('a send_to_session status query with a targetSessionId lists no new-session cards', () => {
  const s = { open: [plainTodo({ id: 'n1', sessionId: 's1' }), item({ id: 'f1', targetSessionId: 's1' })], resolved: [] }
  assert.deepEqual(todoStatesOf(s, { senderId: 'me', targetSessionId: 's1' }).map((x) => x.id), ['f1'])
  assert.deepEqual(todoStatesOf(s, { senderId: 'me' }).map((x) => x.id), ['n1', 'f1'])
})
