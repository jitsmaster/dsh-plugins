import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createOnHold } from '../onhold.js'

// The on-hold queue: a session parked on purpose (item type 'onhold'), watched against its Azure DevOps ticket, continued by the plugin itself when the ticket changes.
const T0 = { state: 'Active', assignee: 'Arnold Wang', descriptionHash: 'aaaa', commentCount: 2 }

function setup({ states = [{ ok: true, state: T0 }], controller, now = () => 1000 } = {}) {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const prompts = []
  const calls = { state: [] }
  const queueOfStates = [...states]
  const ctl = controller ?? { prompt: async (request, signal) => { prompts.push({ request, signal }) } }
  const ticketStateOf = async (ref) => { calls.state.push(ref); return queueOfStates.length > 1 ? queueOfStates.shift() : queueOfStates[0] }
  const hold = createOnHold({ store, controllerOf: () => ctl, ticketStateOf, now, log: () => {} })
  return { store, hold, prompts, calls, push: (s) => { queueOfStates.length = 0; queueOfStates.push(s) } }
}
const open = (store) => store.snapshot().open.filter((i) => i.type === 'onhold')
const SESSION = { sessionId: 's1', sessionTitle: 'Fix: Actions do not display - 25751', workspace: 'D:/dev/CTnP-Final', reason: 'waiting for the CMS URL' }

test('hold adds one open onhold item with the reason, the time and the ticket found in the session title, and notes the ticket state as the baseline', async () => {
  const { store, hold, calls } = setup()
  const r = await hold.hold(SESSION)
  assert.equal(r.ok, true)
  const [item] = open(store)
  assert.deepEqual([item.type, item.sessionId, item.sessionTitle, item.workspace], ['onhold', 's1', SESSION.sessionTitle, 'D:/dev/CTnP-Final'])
  assert.deepEqual([item.payload.reason, item.payload.heldAt, item.payload.ticket.id], ['waiting for the CMS URL', 1000, '25751'])
  assert.deepEqual(item.payload.baseline, T0)
  assert.equal(calls.state.length, 1)
})

test('the ticket can come from the words typed with the command (AB#n, a work item URL) and wins over the title', async () => {
  const { store, hold } = setup()
  await hold.hold({ ...SESSION, text: 'on hold until AB#30001 is answered' })
  assert.equal(open(store)[0].payload.ticket.id, '30001')
})

test('no ticket: the item has none, a failing baseline read still holds the session, and the check leaves it alone', async () => {
  const none = setup()
  await none.hold.hold({ sessionId: 's2', sessionTitle: 'Untitled', reason: 'waiting on a person' })
  assert.equal(open(none.store)[0].payload.ticket, null)
  assert.deepEqual(await none.hold.check(), { ok: true, checked: 0, continued: 0 })
  assert.equal(none.calls.state.length, 0)
  const bad = setup({ states: [{ ok: false, error: 'no-pat' }] })
  assert.equal((await bad.hold.hold(SESSION)).ok, true)
  assert.deepEqual([open(bad.store)[0].payload.baseline, open(bad.store)[0].payload.checkError], [null, 'no-pat'])
})

test('holding a session that is already held updates the reason and adds no second item; a missing session id is refused', async () => {
  const { store, hold } = setup()
  await hold.hold(SESSION)
  const again = await hold.hold({ ...SESSION, reason: 'new reason' })
  assert.deepEqual([again.ok, again.updated], [true, true])
  assert.equal(open(store).length, 1)
  assert.equal(open(store)[0].payload.reason, 'new reason')
  assert.deepEqual(await hold.hold({ reason: 'x' }), { ok: false, error: 'no-session' })
  assert.deepEqual([...hold.heldSessionIds()], ['s1'])
})

test('release resolves the item as released and the session is no longer held', async () => {
  const { store, hold } = setup()
  const { id } = await hold.hold(SESSION)
  assert.deepEqual(hold.release(id), { ok: true })
  assert.deepEqual(store.get(id).resolution, { kind: 'released', by: 'card' })
  assert.equal(hold.heldSessionIds().size, 0)
  assert.deepEqual(hold.release(id), { ok: false, error: 'not-open' })
  assert.deepEqual(hold.release('nope'), { ok: false, error: 'not-open' })
})

test('check: an unchanged ticket does nothing but record the check; a changed one continues the session itself with the changes and closes the item as continued', async () => {
  const { store, hold, prompts, push } = setup()
  const { id } = await hold.hold(SESSION)
  assert.deepEqual(await hold.check(), { ok: true, checked: 1, continued: 0 })
  assert.equal(prompts.length, 0)
  assert.equal(store.get(id).payload.lastCheckedAt, 1000)
  push({ ok: true, state: { ...T0, commentCount: 3, state: 'Resolved' } })
  assert.deepEqual(await hold.check(), { ok: true, checked: 1, continued: 1 })
  assert.equal(prompts.length, 1)
  const { request, signal } = prompts[0]
  assert.deepEqual([request.sessionId, request.mode], ['s1', 'queue'])
  const text = request.content[0].text
  assert.match(text, /25751/)
  assert.match(text, /1 new comment/)
  assert.match(text, /state Active -> Resolved/)
  assert.match(text, /waiting for the CMS URL/)
  assert.ok(signal)
  assert.deepEqual(store.get(id).resolution, { kind: 'continued', by: 'ticket', changes: ['1 new comment', 'state Active -> Resolved'] })
  assert.equal(hold.heldSessionIds().size, 0)
})

test('a hold made while the baseline was unreadable takes the first good read as its baseline instead of continuing', async () => {
  const { store, hold, prompts } = setup({ states: [{ ok: false, error: 'unreachable' }, { ok: true, state: T0 }] })
  const { id } = await hold.hold(SESSION)
  assert.deepEqual(await hold.check(), { ok: true, checked: 1, continued: 0 })
  assert.deepEqual([store.get(id).payload.baseline, store.get(id).payload.checkError, prompts.length], [T0, null, 0])
})

test('a ticket that cannot be read keeps the item and says why on it; the next good read clears the message', async () => {
  const { store, hold, prompts, push } = setup()
  const { id } = await hold.hold(SESSION)
  push({ ok: false, error: 'http-401' })
  await hold.check()
  assert.equal(store.get(id).payload.checkError, 'http-401')
  assert.equal(prompts.length, 0)
  push({ ok: true, state: T0 })
  await hold.check()
  assert.equal(store.get(id).payload.checkError, null)
})

test('when the prompt fails the item stays held and the same change is tried again at the next check', async () => {
  let fail = true
  const prompts = []
  const controller = { prompt: async (request) => { if (fail) throw Object.assign(new Error('busy'), { code: 'host/busy' }); prompts.push(request) } }
  const { store, hold, push } = setup({ controller })
  const { id } = await hold.hold(SESSION)
  push({ ok: true, state: { ...T0, descriptionHash: 'bbbb' } })
  assert.deepEqual(await hold.check(), { ok: true, checked: 1, continued: 0 })
  assert.equal(store.get(id).status, 'open')
  assert.equal(store.get(id).payload.continueError, 'host/busy')
  fail = false
  assert.deepEqual(await hold.check(), { ok: true, checked: 1, continued: 1 })
  assert.match(prompts[0].content[0].text, /description changed/)
})

test('a session DSH no longer has closes its hold as session-ended', async () => {
  const controller = { prompt: async () => { throw Object.assign(new Error('gone'), { code: 'session/not-found' }) } }
  const { store, hold, push } = setup({ controller })
  const { id } = await hold.hold(SESSION)
  push({ ok: true, state: { ...T0, commentCount: 9 } })
  await hold.check()
  assert.deepEqual(store.get(id).resolution, { kind: 'session-ended' })
})

test('two checks at once share one run', async () => {
  const { hold, calls } = setup()
  await hold.hold(SESSION)
  calls.state.length = 0
  const [a, b] = await Promise.all([hold.check(), hold.check()])
  assert.deepEqual(a, b)
  assert.equal(calls.state.length, 1)
})

test('continueNow prompts the session with a plain continue message and closes the item as continued by the card', async () => {
  const { store, hold, prompts } = setup()
  const { id } = await hold.hold({ sessionId: 's9', sessionTitle: 'Other', reason: 'parked' })
  assert.deepEqual(await hold.continueNow(id), { ok: true })
  assert.match(prompts[0].request.content[0].text, /parked/)
  assert.deepEqual(store.get(id).resolution, { kind: 'continued', by: 'card' })
  assert.deepEqual(await hold.continueNow(id), { ok: false, error: 'not-open' })
})
