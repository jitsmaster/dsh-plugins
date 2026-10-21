import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupFollowUp, fakeLlm, prompts, deferred, SESSION_ITEMS } from './follow-up-helpers.mjs'
import { createStore } from '../store.js'
import { createFollowUps } from '../todo-follow-up.js'
import { REF_REASON } from '../follow-up-shared.js'

// The Follow-up todo: the text is a message for an EXISTING session found from plain words; nothing is sent before the user confirms.
const MSG = 'Please also add a regression test'
const names = (calls) => calls.map((c) => c[0])

test('add validates the words: empty-query, too-long (over 300), a non-string; the text still needs to be there', () => {
  const { queue, store } = setupFollowUp()
  assert.deepEqual(queue.addTodo(MSG, { followUp: '   ' }), { ok: false, error: 'empty-query' })
  assert.deepEqual(queue.addTodo(MSG, { followUp: '' }), { ok: false, error: 'empty-query' })
  assert.deepEqual(queue.addTodo(MSG, { followUp: 'x'.repeat(301) }), { ok: false, error: 'too-long' })
  assert.deepEqual(queue.addTodo(MSG, { followUp: 42 }), { ok: false, error: 'empty-query' }, 'a followUp that is not a string never becomes a new session')
  assert.deepEqual(queue.addTodo('  ', { followUp: 'the login one' }), { ok: false, error: 'empty' })
  assert.equal(store.list().length, 0)
  assert.equal(queue.addTodo(MSG, { followUp: 'x'.repeat(300) }).ok, true, '300 is fine')
})

test('at most 10 follow-ups wait for a confirm on the local path too: the 11th add is too-many-follow-ups and creates nothing; a place is free once one is cancelled or sent', async () => {
  const { queue, store } = setupFollowUp()
  const ids = []
  for (let n = 0; n < 10; n++) { const r = queue.addTodo(MSG + ' ' + n, { followUp: 'something ' + n }); assert.equal(r.ok, true, 'add ' + n); ids.push(r.id) }
  assert.deepEqual(queue.addTodo(MSG, { followUp: 'one too many' }), { ok: false, error: 'too-many-follow-ups' })
  assert.equal(store.list().length, 10)
  await queue.todoIdle()
  assert.equal(queue.addTodo('an ordinary todo', { workspaceId: 'w-plug' }).error, undefined, 'only follow-ups waiting for a confirm count')
  assert.equal(queue.cancelTodo(ids[0]).ok, true)
  assert.equal(queue.addTodo(MSG, { followUp: 'now there is room' }).ok, true)
  assert.equal(queue.confirmTodo(ids[1], { sessionId: 's-pr' }).ok, true)
  await queue.todoIdle() // sent: it no longer waits
  assert.equal(queue.addTodo(MSG, { followUp: 'and again' }).ok, true)
  assert.deepEqual(queue.addTodo(MSG, { followUp: 'full again' }), { ok: false, error: 'too-many-follow-ups' })
})

test('add creates the follow-up item at once, looking for sessions in the background, and answers awaiting-confirm', async () => {
  const { queue, store } = setupFollowUp()
  const r = queue.addTodo('  ' + MSG + ' \n', { followUp: '  the login redirect one  ', sparc: true, workspaceId: 'w-plug' })
  assert.deepEqual([r.ok, r.state], [true, 'awaiting-confirm'])
  const first = store.get(r.id)
  assert.equal(first.type, 'todo')
  assert.equal(first.kind, 'followup')
  assert.equal(first.text, MSG)
  assert.equal(first.query, 'the login redirect one')
  assert.equal(first.sparc, false, 'SPARC and a workspace mean nothing for a follow-up')
  assert.equal(first.workspaceId, undefined)
  assert.equal(first.state, 'awaiting-confirm')
  assert.equal(first.suggesting, true)
  await queue.todoIdle()
  const item = store.get(r.id)
  assert.equal(item.status, 'open')
  assert.deepEqual(item.candidates.map((x) => x.sessionId), ['s-pr', 's-orca', 's-old'], 'newest first')
  assert.deepEqual(item.candidates[0], { sessionId: 's-pr', title: 'PR 6556 review', workspaceTitle: 'dsh-plugins', running: true })
  assert.equal(store.snapshot().open.length, 1)
})

test('nothing is sent, created, renamed or focused before the user confirms', async () => {
  const { queue, calls, store } = setupFollowUp({ llm: fakeLlm({ answer: '{"select":"s-orca","reason":"r"}' }) })
  const { id } = queue.addTodo(MSG, { followUp: 'the engine one' })
  await queue.todoIdle()
  assert.equal(store.get(id).suggested.sessionId, 's-orca')
  assert.deepEqual(names(calls).filter((n) => n !== 'list'), [])
})

test("the app's own list is read with the controller's list call when no sessions are given; a failing or empty list leaves a note and a card that can be cancelled", async () => {
  const failing = setupFollowUp({ listError: 'controller down' })
  const a = failing.queue.addTodo(MSG, { followUp: 'anything' })
  await failing.queue.todoIdle()
  assert.equal(failing.store.get(a.id).suggestNote, 'no sessions found')
  assert.equal(failing.store.get(a.id).suggesting, false)
  assert.deepEqual(failing.store.get(a.id).candidates, [])
  assert.equal(failing.store.get(a.id).state, 'awaiting-confirm')
  const empty = setupFollowUp({ items: [] })
  const b = empty.queue.addTodo(MSG, { followUp: 'anything' })
  await empty.queue.todoIdle()
  assert.equal(empty.store.get(b.id).suggestNote, 'no sessions found')
  assert.equal(empty.queue.cancelTodo(b.id).ok, true)
})

test('sessions given by the caller (the hub union of every app) replace this app\'s own list and are never read from the controller', async () => {
  const f = setupFollowUp({ llm: fakeLlm({ answer: '{"select":"remote-1","reason":"r"}' }) })
  const sessions = [
    { sessionId: 'remote-2', title: 'Other thing', workspaceTitle: 'Beta', owner: 'laptop', updatedAt: 1 },
    { sessionId: 'remote-1', title: 'The login thing', workspaceTitle: 'Alpha', owner: 'desktop', updatedAt: 2 },
    { sessionId: '', title: 'no id' }, null,
  ]
  const { id } = f.queue.addTodo(MSG, { followUp: 'login', sessions })
  assert.equal(f.store.get(id).candidates.length, 2, 'the candidates are there at once')
  await f.queue.todoIdle()
  const item = f.store.get(id)
  assert.equal(names(f.calls).includes('list'), false)
  assert.deepEqual(item.candidates, [
    { sessionId: 'remote-1', title: 'The login thing', workspaceTitle: 'Alpha', owner: 'desktop' },
    { sessionId: 'remote-2', title: 'Other thing', workspaceTitle: 'Beta', owner: 'laptop' },
  ])
  assert.equal(item.suggested.sessionId, 'remote-1')
  assert.equal(item.suggested.owner, 'desktop')
})

test('given sessions that are empty: the card exists with the note, no model pass', async () => {
  const seen = {}
  const f = setupFollowUp({ llm: fakeLlm({ answer: '{"select":null}', seen }) })
  const { id } = f.queue.addTodo(MSG, { followUp: 'login', sessions: [] })
  const item = f.store.get(id)
  assert.equal(item.suggestNote, 'no sessions found')
  assert.notEqual(item.suggesting, true)
  assert.deepEqual(item.candidates, [])
  await f.queue.todoIdle()
  assert.equal(seen.calls, undefined)
  assert.deepEqual(f.calls, [])
})

test('confirm sends exactly one queued prompt with the todo text to the chosen session and resolves the card', async () => {
  const f = setupFollowUp({ llm: fakeLlm({ answer: '{"select":"s-orca","reason":"r"}' }) })
  const { id } = f.queue.addTodo(MSG, { followUp: 'the engine one' })
  await f.queue.todoIdle()
  const r = f.queue.confirmTodo(id, {})
  assert.deepEqual(r, { ok: true, state: 'starting' })
  await f.queue.todoIdle()
  const sent = prompts(f.calls)
  assert.equal(sent.length, 1)
  const req = sent[0][1]
  assert.equal(req.sessionId, 's-orca')
  assert.equal(req.mode, 'queue')
  assert.match(req.requestId, /^todo-/)
  assert.deepEqual(req.content, [{ type: 'text', text: MSG }])
  assert.ok(sent[0][2] instanceof AbortSignal, 'the Remote method needs a caller signal')
  assert.deepEqual(names(f.calls).filter((n) => !['list', 'prompt'].includes(n)), [], 'no create, rename, select or focus')
  const item = f.store.get(id)
  assert.equal(item.status, 'resolved')
  assert.equal(item.state, 'started')
  assert.equal(item.sessionId, 's-orca')
  assert.equal(item.sessionTitle, 'Orca engine tuning')
  assert.deepEqual(item.resolution, { kind: 'followed-up', by: 'card', sessionId: 's-orca' })
  assert.equal(f.store.snapshot().open.length, 0)
})

test('confirm with a sessionId overrides the suggestion, and works without a suggestion', async () => {
  const f = setupFollowUp({ llm: fakeLlm({ answer: '{"select":"s-orca"}' }) })
  const { id } = f.queue.addTodo(MSG, { followUp: 'the engine one' })
  await f.queue.todoIdle()
  assert.equal(f.queue.confirmTodo(id, { sessionId: 's-old' }).ok, true)
  await f.queue.todoIdle()
  assert.deepEqual(prompts(f.calls).map((c) => c[1].sessionId), ['s-old'])
  assert.equal(f.store.get(id).sessionTitle, 'Fix: login redirect - 25001')
  const g = setupFollowUp()
  const two = g.queue.addTodo(MSG, { followUp: 'something' })
  await g.queue.todoIdle()
  assert.equal(g.store.get(two.id).suggested, undefined)
  assert.equal(g.queue.confirmTodo(two.id, { sessionId: 's-pr' }).ok, true)
  await g.queue.todoIdle()
  assert.deepEqual(prompts(g.calls).map((c) => c[1].sessionId), ['s-pr'])
})

test('confirm without a session and without a suggestion is no-session; nothing is sent and the card waits', async () => {
  const f = setupFollowUp()
  const { id } = f.queue.addTodo(MSG, { followUp: 'something' })
  await f.queue.todoIdle()
  assert.deepEqual(f.queue.confirmTodo(id, {}), { ok: false, error: 'no-session' })
  assert.deepEqual(f.queue.confirmTodo(id), { ok: false, error: 'no-session' })
  assert.equal(f.store.get(id).state, 'awaiting-confirm')
  assert.deepEqual(prompts(f.calls), [])
})

test('confirm with a session that is not among the candidates is unknown-session and sends nothing', async () => {
  const f = setupFollowUp()
  const { id } = f.queue.addTodo(MSG, { followUp: 'something' })
  await f.queue.todoIdle()
  assert.deepEqual(f.queue.confirmTodo(id, { sessionId: 's-ghost' }), { ok: false, error: 'unknown-session' })
  assert.equal(f.store.get(id).state, 'awaiting-confirm')
  assert.deepEqual(prompts(f.calls), [])
  assert.deepEqual(f.queue.confirmTodo(id, { workspaceId: 'w-plug' }), { ok: false, error: 'no-session' }, 'a workspace is no session')
})

test('while the prompt is on its way the card is starting with targetSessionId, not yet bound to the session; a second confirm is refused', async () => {
  const gate = deferred()
  const f = setupFollowUp({ promptGate: gate })
  const { id } = f.queue.addTodo(MSG, { followUp: 'something' })
  await f.queue.todoIdle()
  assert.equal(f.queue.confirmTodo(id, { sessionId: 's-pr' }).ok, true)
  await new Promise((r) => setTimeout(r, 5))
  const mid = f.store.get(id)
  assert.equal(mid.state, 'starting')
  assert.equal(mid.targetSessionId, 's-pr')
  assert.equal(mid.sessionTitle, 'PR 6556 review')
  assert.equal(mid.sessionId, undefined)
  assert.equal(f.store.peekOpen('s-pr').length, 0, 'the capture of that session does not see the card')
  assert.deepEqual(f.queue.confirmTodo(id, { sessionId: 's-pr' }), { ok: false, error: 'not-confirmable' })
  assert.deepEqual(f.queue.cancelTodo(id), { ok: false, error: 'not-confirmable' })
  gate.resolve()
  await f.queue.todoIdle()
  assert.equal(prompts(f.calls).length, 1)
  assert.equal(f.store.get(id).state, 'started')
})

test('a failing prompt gives a failed card with the error; retry is a confirm again and sends once it works; no double send afterwards', async () => {
  const f = setupFollowUp()
  const { id } = f.queue.addTodo(MSG, { followUp: 'something' })
  await f.queue.todoIdle()
  f.controller.prompt = async (req, signal) => { f.calls.push(['prompt', req, signal]); throw Object.assign(new Error('the host said no'), { code: 'session/not-found' }) }
  assert.equal(f.queue.confirmTodo(id, { sessionId: 's-pr' }).ok, true)
  await f.queue.todoIdle()
  let item = f.store.get(id)
  assert.equal(item.status, 'open')
  assert.equal(item.state, 'failed')
  assert.equal(item.error, 'Could not send the message', 'a fixed text: what the controller said never goes on the card')
  assert.equal(prompts(f.calls).length, 1)
  f.controller.prompt = async (req, signal) => { f.calls.push(['prompt', req, signal]); return {} }
  assert.equal(f.queue.confirmTodo(id, { sessionId: 's-pr' }).ok, true, 'retry')
  await f.queue.todoIdle()
  item = f.store.get(id)
  assert.equal(item.state, 'started')
  assert.equal(item.error, undefined)
  assert.deepEqual(item.resolution, { kind: 'followed-up', by: 'card', sessionId: 's-pr' })
  assert.equal(prompts(f.calls).length, 2)
  assert.deepEqual(f.queue.confirmTodo(id, { sessionId: 's-pr' }), { ok: false, error: 'not-open' }, 'no double send once it succeeded')
  await f.queue.todoIdle()
  assert.equal(prompts(f.calls).length, 2)
})

test('a retry can pick another session', async () => {
  const f = setupFollowUp({ promptError: 'nope' })
  const { id } = f.queue.addTodo(MSG, { followUp: 'something' })
  await f.queue.todoIdle()
  f.queue.confirmTodo(id, { sessionId: 's-pr' })
  await f.queue.todoIdle()
  assert.equal(f.store.get(id).state, 'failed')
  f.controller.prompt = async (req) => { f.calls.push(['prompt', req]); return {} }
  f.queue.confirmTodo(id, { sessionId: 's-old' })
  await f.queue.todoIdle()
  assert.deepEqual(prompts(f.calls).map((c) => c[1].sessionId), ['s-pr', 's-old'])
  assert.equal(f.store.get(id).sessionId, 's-old')
})

test('a session the controller no longer knows fails the card with the error; the message is not sent anywhere else', async () => {
  const f = setupFollowUp({ promptError: { message: 'Session not found: s-pr', code: 'session/not-found' } })
  const { id } = f.queue.addTodo(MSG, { followUp: 'something' })
  await f.queue.todoIdle()
  f.queue.confirmTodo(id, { sessionId: 's-pr' })
  await f.queue.todoIdle()
  const item = f.store.get(id)
  assert.equal(item.state, 'failed')
  assert.equal(item.status, 'open')
  assert.ok(item.error && item.error.length <= 300)
  assert.equal(prompts(f.calls).length, 1)
  assert.equal(item.sessionId, undefined)
})

test('a controller without prompt fails the card instead of throwing', async () => {
  const f = setupFollowUp()
  const { id } = f.queue.addTodo(MSG, { followUp: 'something' })
  await f.queue.todoIdle()
  delete f.controller.prompt
  assert.equal(f.queue.confirmTodo(id, { sessionId: 's-pr' }).ok, true)
  await f.queue.todoIdle()
  assert.equal(f.store.get(id).state, 'failed')
})

test('cancel works for a waiting and for a failed follow-up and sends nothing', async () => {
  const f = setupFollowUp()
  const a = f.queue.addTodo(MSG, { followUp: 'something' })
  await f.queue.todoIdle()
  assert.deepEqual(f.queue.cancelTodo(a.id), { ok: true })
  assert.equal(f.store.get(a.id).status, 'resolved')
  assert.deepEqual(f.store.get(a.id).resolution, { kind: 'cancelled', by: 'card' })
  assert.deepEqual(f.queue.confirmTodo(a.id, { sessionId: 's-pr' }), { ok: false, error: 'not-open' })
  const g = setupFollowUp({ promptError: 'nope' })
  const b = g.queue.addTodo(MSG, { followUp: 'something' })
  await g.queue.todoIdle()
  g.queue.confirmTodo(b.id, { sessionId: 's-pr' })
  await g.queue.todoIdle()
  assert.equal(g.store.get(b.id).state, 'failed')
  assert.deepEqual(g.queue.cancelTodo(b.id), { ok: true })
  assert.equal(prompts(g.calls).length, 1, 'only the failed attempt')
})

test('a follow-up needs no workspace registry, and a model result that arrives after the user cancelled changes nothing', async () => {
  const noReg = setupFollowUp({ noRegistry: true })
  const a = noReg.queue.addTodo(MSG, { followUp: 'something' })
  await noReg.queue.todoIdle()
  assert.equal(noReg.store.get(a.id).candidates.length, 3)
  assert.equal(noReg.queue.confirmTodo(a.id, { sessionId: 's-pr' }).ok, true)
  await noReg.queue.todoIdle()
  assert.equal(noReg.store.get(a.id).state, 'started')
  const f = setupFollowUp({ llm: fakeLlm({ hang: true }) })
  const b = f.queue.addTodo(MSG, { followUp: 'something' })
  await new Promise((r) => setTimeout(r, 5))
  f.queue.cancelTodo(b.id)
  await f.queue.todoIdle()
  assert.equal(f.store.get(b.id).state, 'cancelled')
  assert.equal(f.store.get(b.id).suggestNote, undefined)
})

test('workspace todos are unchanged: no kind, a workspace is still required to confirm, and a followUp-less add ignores sessions', async () => {
  const f = setupFollowUp()
  const r = f.queue.addTodo('Do the thing', { workspaceId: 'w-plug' })
  await f.queue.todoIdle()
  assert.equal(f.store.get(r.id).kind, undefined)
  assert.deepEqual(names(f.calls), ['create', 'rename', 'prompt'])
  const g = setupFollowUp()
  const w = g.queue.addTodo('Nobody named here', { sessions: [{ sessionId: 'x', title: 'X' }] })
  await g.queue.todoIdle()
  assert.equal(g.store.get(w.id).kind, undefined)
  assert.equal(g.store.get(w.id).candidates, undefined)
  assert.deepEqual(g.queue.confirmTodo(w.id, { sessionId: 'x' }), { ok: false, error: 'no-workspace' })
})

test('queue.followUpSessions gives this app\'s candidates (with snippets from the optional reader), [] when it fails', async () => {
  const snippetsOf = async (ids) => new Map(ids.map((id) => [id, 'said ' + id]))
  const f = setupFollowUp({ snippetsOf })
  const list = await f.queue.followUpSessions()
  assert.deepEqual(list.map((c) => c.sessionId), ['s-pr', 's-orca', 's-old'])
  assert.equal(list[0].title, 'PR 6556 review')
  assert.equal(list[0].workspaceTitle, 'dsh-plugins')
  assert.equal(list[0].running, true)
  assert.equal(list[0].snippet, 'said s-pr')
  const plain = setupFollowUp()
  assert.equal((await plain.queue.followUpSessions())[0].snippet, undefined)
  assert.deepEqual(await setupFollowUp({ listError: 'down' }).queue.followUpSessions(), [])
  assert.equal(SESSION_ITEMS.length, 3)
})

test('a follow-up card counts as waiting for the user while it waits and not while it is sending', async () => {
  const gate = deferred()
  const f = setupFollowUp({ promptGate: gate })
  const { id } = f.queue.addTodo(MSG, { followUp: 'something' })
  await f.queue.todoIdle()
  assert.equal(f.queue.count().total, 1)
  f.queue.confirmTodo(id, { sessionId: 's-pr' })
  assert.equal(f.queue.count().total, 0)
  gate.resolve()
  await f.queue.todoIdle()
})

// ---- apps that did not answer the hub ------------------------------------------------------------------------------------------------

test('skippedApps (apps the hub could not ask) goes on the item; an empty result says how many did not answer', async () => {
  const f = setupFollowUp({ llm: fakeLlm({ answer: '{"select":null}' }) })
  const none = f.queue.addTodo(MSG, { followUp: 'login', sessions: [], skippedApps: 2 })
  assert.equal(f.store.get(none.id).suggestNote, 'no sessions found (2 app(s) did not answer)')
  assert.equal(f.store.get(none.id).skippedApps, 2)
  const some = f.queue.addTodo(MSG, { followUp: 'login', sessions: [{ sessionId: 'x', title: 'X' }], skippedApps: 1 })
  await f.queue.todoIdle()
  assert.equal(f.store.get(some.id).skippedApps, 1)
  assert.deepEqual(f.store.get(some.id).candidates.map((c) => c.sessionId), ['x'])
  const clean = f.queue.addTodo(MSG, { followUp: 'login', sessions: [], skippedApps: 0 })
  assert.equal(f.store.get(clean.id).suggestNote, 'no sessions found')
  assert.equal('skippedApps' in f.store.get(clean.id), false)
  for (const odd of [-1, 1.5, 'two', null, NaN, {}]) {
    const r = f.queue.addTodo(MSG, { followUp: 'login', sessions: [], skippedApps: odd })
    assert.equal(f.store.get(r.id).suggestNote, 'no sessions found', String(odd))
    assert.equal('skippedApps' in f.store.get(r.id), false, String(odd))
  }
})

// ---- a send whose outcome is unknown ---------------------------------------------------------------------------------------------------

const MAY = 'May have been sent: check the session before retrying.'
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
async function waiting() {
  const f = setupFollowUp()
  const { id } = f.queue.addTodo(MSG, { followUp: 'something' })
  await f.queue.todoIdle()
  return { ...f, id }
}
const failWith = (f, error) => { f.controller.prompt = async (req, signal) => { f.calls.push(['prompt', req, signal]); throw error } }
const succeed = (f) => { f.controller.prompt = async (req, signal) => { f.calls.push(['prompt', req, signal]); return {} } }

test('a timeout or an abort of the prompt call fails the card with a warning that the message may have been sent', async () => {
  for (const error of [timeoutError(), Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }), Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' })]) {
    const f = await waiting()
    failWith(f, error)
    f.queue.confirmTodo(f.id, { sessionId: 's-pr' })
    await f.queue.todoIdle()
    const item = f.store.get(f.id)
    assert.equal(item.state, 'failed', error.name + error.code)
    assert.equal(item.status, 'open')
    assert.equal(item.error, MAY, 'exactly the fixed warning: the text of the error never goes on the card')
  }
})

test('a failure known to happen BEFORE delivery is not given the warning: the controller does not know the session, nothing was sent', async () => {
  for (const error of [Object.assign(new Error('Session not found: s-pr'), { code: 'session/not-found' })]) {
    const f = await waiting()
    failWith(f, error)
    f.queue.confirmTodo(f.id, { sessionId: 's-pr' })
    await f.queue.todoIdle()
    assert.equal(f.store.get(f.id).error, 'Could not send the message')
  }
})

test('a controller that is not there is a plain failure too: our own check threw before anything was sent', async () => {
  const store = createStore()
  const tracked = []
  const followUps = createFollowUps({ store, controllerOf: () => undefined, timeoutMs: 40, track: (p) => tracked.push(p) })
  const { id } = followUps.add(MSG, 'AB#7', [{ sessionId: 's1', title: 'AB#7 thing' }])
  assert.equal(followUps.confirm(store.get(id), 's1').ok, true)
  await Promise.all(tracked)
  assert.equal(store.get(id).state, 'failed')
  assert.equal(store.get(id).error, 'Could not send the message')
})

test('every other rejection may have been delivered: a generic error, a reset connection or a closed transport gets the warning and no one-click plain failure', async () => {
  const errors = [
    new Error('the host said no'),
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    new Error('transport closed'),
    Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    'plain string rejection',
  ]
  for (const error of errors) {
    const f = await waiting()
    failWith(f, error)
    f.queue.confirmTodo(f.id, { sessionId: 's-pr' })
    await f.queue.todoIdle()
    const item = f.store.get(f.id)
    assert.equal(item.state, 'failed', String(error?.code ?? error?.message ?? error))
    assert.equal(item.status, 'open')
    assert.equal(item.error, MAY, String(error?.code ?? error?.message ?? error))
  }
})

// ---- what the controller says (a path, content, a token) stays out of the card, the speech and the log ----

test('the controller error text reaches neither the card nor the log: the log has the code or the name only, the card a fixed text', async () => {
  const secret = 'C:/Users/arnold/.secrets/token-ABC123 refused'
  const cases = [
    [Object.assign(new Error(secret), { code: 'session/not-found' }), 'session/not-found', 'Could not send the message'],
    [Object.assign(new Error(secret), { code: 'EACCES' }), 'EACCES', MAY],
    [new TypeError(secret), 'TypeError', MAY],
    [Object.assign(new Error(secret), { name: 'TimeoutError' }), 'TimeoutError', MAY],
  ]
  for (const [error, label, card] of cases) {
    const f = await waiting()
    failWith(f, error)
    f.queue.confirmTodo(f.id, { sessionId: 's-pr' })
    await f.queue.todoIdle()
    const line = f.logs.find((l) => l.startsWith('todo: follow-up failed'))
    assert.ok(line, JSON.stringify(f.logs))
    assert.ok(line.endsWith(label), line)
    assert.equal(f.logs.join('\n').includes('secrets'), false, 'no controller text in any log line')
    assert.equal(f.store.get(f.id).error, card)
    assert.equal(JSON.stringify(f.store.get(f.id)).includes('token-ABC123'), false)
  }
})

test('the requestId is made of the item id and the session: a retry reuses it, another session or another item gets its own', async () => {
  const f = await waiting()
  failWith(f, timeoutError())
  f.queue.confirmTodo(f.id, { sessionId: 's-pr' })
  await f.queue.todoIdle()
  f.queue.confirmTodo(f.id, { sessionId: 's-pr' }) // Retry
  await f.queue.todoIdle()
  succeed(f)
  f.queue.confirmTodo(f.id, { sessionId: 's-pr' })
  await f.queue.todoIdle()
  const [first, second, third] = prompts(f.calls).map((c) => c[1].requestId)
  assert.equal(first, 'todo-' + f.id + '-s-pr', 'derived from the item id (the same in every app that holds the item) and the session')
  assert.equal(second, first)
  assert.equal(third, first, 'the retry that works carries the id of the attempt whose outcome was unknown')
  assert.equal('sendKey' in f.store.get(f.id), false, 'no per-app random key on the item any more')
  // another session is another message: it must not be taken for the first one
  const g = await waiting()
  failWith(g, timeoutError())
  g.queue.confirmTodo(g.id, { sessionId: 's-pr' })
  await g.queue.todoIdle()
  succeed(g)
  g.queue.confirmTodo(g.id, { sessionId: 's-old' })
  await g.queue.todoIdle()
  const ids = prompts(g.calls).map((c) => c[1].requestId)
  assert.deepEqual(ids, ['todo-' + g.id + '-s-pr', 'todo-' + g.id + '-s-old'])
  // another item of the same app never shares it
  const other = f.queue.addTodo(MSG, { followUp: 'something else' })
  await f.queue.todoIdle()
  f.queue.confirmTodo(other.id, { sessionId: 's-pr' })
  await f.queue.todoIdle()
  assert.equal(prompts(f.calls).at(-1)[1].requestId, 'todo-' + other.id + '-s-pr')
  assert.notEqual(other.id, f.id)
})

test('an item that moves to another app keeps its requestId: the id is the hub-stable item id, not a per-app key', async () => {
  const f = await waiting()
  failWith(f, timeoutError())
  f.queue.confirmTodo(f.id, { sessionId: 's-pr' })
  await f.queue.todoIdle()
  const moved = { ...f.store.get(f.id) } // what an app that adopts the item is handed
  const other = setupFollowUp()
  other.store.restore({ items: [moved], resolved: [], seq: 10 })
  succeed(other)
  other.queue.confirmTodo(f.id, { sessionId: 's-pr' })
  await other.queue.todoIdle()
  assert.equal(prompts(other.calls)[0][1].requestId, prompts(f.calls)[0][1].requestId)
})

// A session that is running now may be in the middle of a task: a MODEL's pick of it is never confirmed without the user choosing a session. The deterministic number match and an explicit choice are.
function waitingWith(store, suggested) {
  return store.add({
    type: 'todo', kind: 'followup', text: MSG, query: 'the PR review', sparc: false, state: 'awaiting-confirm', suggesting: false,
    candidates: [{ sessionId: 's-pr', title: 'PR 6556 review', running: true }, { sessionId: 's-old', title: 'Old', running: false }], suggested,
  }).id
}

test('confirm without a session: a model pick of a running session is no-session and nothing is sent; an explicit session, a number pick and a quiet session go through', async () => {
  const f = setupFollowUp()
  const model = waitingWith(f.store, { sessionId: 's-pr', title: 'PR 6556 review', reason: 'looks right', running: true })
  assert.deepEqual(f.queue.confirmTodo(model, {}), { ok: false, error: 'no-session' })
  assert.deepEqual(f.queue.confirmTodo(model, { sessionId: '' }), { ok: false, error: 'no-session' })
  assert.equal(f.store.get(model).state, 'awaiting-confirm', 'nothing changed')
  await f.queue.todoIdle()
  assert.deepEqual(names(f.calls).filter((n) => n === 'prompt'), [], 'nothing was sent')
  assert.deepEqual(f.queue.confirmTodo(model, { sessionId: 's-pr' }), { ok: true, state: 'starting' }, 'the user chose it')
  const ref = waitingWith(f.store, { sessionId: 's-pr', title: 'PR 6556 review', reason: REF_REASON, running: true })
  assert.deepEqual(f.queue.confirmTodo(ref, {}), { ok: true, state: 'starting' }, 'the number match is deterministic')
  const quiet = waitingWith(f.store, { sessionId: 's-old', title: 'Old', reason: 'looks right', running: false })
  assert.deepEqual(f.queue.confirmTodo(quiet, {}), { ok: true, state: 'starting' })
  const unknown = waitingWith(f.store, { sessionId: 's-old', title: 'Old', reason: 'looks right' })
  assert.deepEqual(f.queue.confirmTodo(unknown, {}), { ok: true, state: 'starting' }, 'no running flag: not a running session')
  await f.queue.todoIdle()
})
