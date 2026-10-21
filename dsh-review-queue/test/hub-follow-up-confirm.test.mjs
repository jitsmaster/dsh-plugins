import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AWAY_MS } from '../hub/instances.js'
import { REF_REASON } from '../follow-up-shared.js'
import { act, autopilot, followItem, nothingQueued, twoApps } from './hub-follow-up-helpers.mjs'

// Follow-up todo, hub side: confirm (todo-confirm with a sessionId) goes to the app the session lives in (the candidate's owner). Same app as the
// item: followup-send there. Another app: the item moves there exactly as a todo moves to another app's workspace, and is rolled back on failure.

const cands = (a, b) => [{ sessionId: 'sa1', title: 'PR review', owner: a.id }, { sessionId: 'sb1', title: 'Orca tuning', workspaceTitle: 'beta', owner: b.id }]

async function withItem(t, over = {}) {
  const ctx = await twoApps(t)
  const { a, b } = ctx
  await a.send(followItem(a, 1, { candidates: cands(a, b), suggested: { sessionId: 'sb1', title: 'Orca tuning', reason: 'x', owner: b.id }, ...over }))
  return { ...ctx, id: a.itemId(1) }
}
/** Post the confirm, let one app fetch its first command and answer it. */
async function viaAgent(agent, port, body, result, headers) {
  const pending = act(port, 'todo-confirm', body, headers)
  const got = await agent.poll(0, 3000)
  const cmd = got.json.commands[0]
  if (cmd && result) await agent.result(cmd.cid, result)
  return { res: await pending, cmd }
}

test('a session of the app that holds the item: followup-send goes there with the session id only', async (t) => {
  const { hub, port, a, b, id } = await withItem(t)
  const { res, cmd } = await viaAgent(a, port, { id, sessionId: 'sa1' }, { ok: true, state: 'starting' })
  assert.deepEqual([res.status, res.json], [200, { ok: true, state: 'starting' }])
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args], ['followup-send', id, { sessionId: 'sa1' }])
  assert.equal(hub.store.get(id).owner, a.id)
  await nothingQueued(b)
})

test('without a session in the body the suggested one is sent, to the app named in the suggestion', async (t) => {
  const { hub, port, a, b, id } = await withItem(t)
  const pending = act(port, 'todo-confirm', { id })
  const cmd = (await b.poll(0, 3000)).json.commands[0]
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args.sessionId], ['followup-send', id, 'sb1'])
  await b.result(cmd.cid, { ok: true, state: 'starting' })
  assert.equal((await pending).status, 200)
  assert.equal(hub.store.get(id).owner, b.id)
  assert.deepEqual((await a.poll(0, 0)).json.commands.map((c) => [c.kind, c.args.change]), [['apply', { op: 'drop', id }]], 'the app that held it lets go')
})

test('a session of another app moves the item there: the new owner gets it with the command, the old owner drops it', async (t) => {
  const { hub, port, a, b, id } = await withItem(t)
  const pending = act(port, 'todo-confirm', { id, sessionId: 'sb1' })
  const cmd = (await b.poll(0, 3000)).json.commands[0]
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args.sessionId], ['followup-send', id, 'sb1'])
  assert.deepEqual([cmd.args.item.id, cmd.args.item.kind, cmd.args.item.text, cmd.args.item.candidates.length], [id, 'followup', 'also the null case', 2])
  assert.equal(hub.store.get(id).owner, b.id, 'the new owner is the owner before it reports what it does with the item')
  await b.result(cmd.cid, { ok: true, state: 'starting' })
  const res = await pending
  assert.deepEqual([res.status, res.json.state], [200, 'starting'])
  const drop = (await a.poll(0, 0)).json.commands
  assert.deepEqual(drop.map((c) => [c.kind, c.args.change]), [['apply', { op: 'drop', id }]])
  assert.equal(hub.store.get(id).owner, b.id)
})

test('a move that the new owner refuses is undone: the item is the old owner\'s again, the new owner is told to drop its copy, the refusal is the answer', async (t) => {
  const { hub, port, a, b, id } = await withItem(t)
  const pending = act(port, 'todo-confirm', { id, sessionId: 'sb1' })
  const cmd = (await b.poll(0, 3000)).json.commands[0]
  await b.result(cmd.cid, { ok: false, error: 'not-confirmable' })
  const res = await pending
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'not-confirmable' }])
  assert.equal(hub.store.get(id).owner, a.id)
  assert.deepEqual((await b.poll(cmd.seq, 0)).json.commands.map((c) => [c.kind, c.args.change]), [['apply', { op: 'drop', id }]])
  await nothingQueued(a)
})

test('an unknown session is 400 unknown-session, also one that only another item lists; nothing is sent', async (t) => {
  const { port, a, b, id } = await withItem(t)
  await a.send(followItem(a, 2, { candidates: [{ sessionId: 'other-only', title: 'T', owner: a.id }] }))
  for (const sessionId of ['nope', 'other-only', 'SA1', ['sa1'], { sessionId: 'sa1' }]) {
    const res = await act(port, 'todo-confirm', { id, sessionId })
    assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'unknown-session' }], JSON.stringify(sessionId))
  }
  await nothingQueued(a)
  await nothingQueued(b)
})

test('no session in the body and no suggestion: 400 no-session', async (t) => {
  const ctx = await twoApps(t)
  const { port, a, b } = ctx
  await a.send(followItem(a, 1, { candidates: cands(a, b) }))
  const res = await act(port, 'todo-confirm', { id: a.itemId(1) })
  assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'no-session' }])
  await nothingQueued(a)
})

test('the app of the session is gone: 409 owner-offline, the item stays where it is, nothing is sent', async (t) => {
  const { hub, port, a, id } = await withItem(t)
  hub.instances.bye(hub.instances.list().find((i) => i.id !== a.id).id)
  const res = await act(port, 'todo-confirm', { id, sessionId: 'sb1' })
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'owner-offline' }])
  assert.equal(hub.store.get(id).owner, a.id)
  await nothingQueued(a)
})

test('the item\'s own app is gone and the session is its: 409 owner-offline', async (t) => {
  const { hub, port, a, b, id } = await withItem(t)
  hub.instances.bye(a.id)
  const res = await act(port, 'todo-confirm', { id, sessionId: 'sa1' })
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'owner-offline' }])
  await nothingQueued(b)
})

test('the app of the session missed its polls: 409 owner-away', async (t) => {
  const { hub, port, a, b, id, clock } = await withItem(t)
  clock.advance(AWAY_MS + 1000)
  hub.instances.tick()
  await a.poll(0, 0) // the item's app is back, b is still away
  const res = await act(port, 'todo-confirm', { id, sessionId: 'sb1' })
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'owner-away' }])
  assert.equal(hub.store.get(id).owner, a.id)
  await nothingQueued(a)
  assert.equal(hub.instances.get(b.id).state, 'away')
})

test('a candidate whose app the hub does not know (an app that was restarted since) is 409 owner-offline, not sent anywhere else', async (t) => {
  const { hub, port, a, b, id } = await withItem(t, { candidates: [{ sessionId: 'old1', title: 'Old', owner: 'dead0000' }] })
  const res = await act(port, 'todo-confirm', { id, sessionId: 'old1' })
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'owner-offline' }])
  assert.equal(hub.store.get(id).owner, a.id)
  await nothingQueued(a)
  await nothingQueued(b)
})

test('a candidate without an owner tag belongs to the app that holds the item', async (t) => {
  const { port, a, b, id } = await withItem(t, { candidates: [{ sessionId: 'sx', title: 'Untagged' }], suggested: undefined })
  const { res, cmd } = await viaAgent(a, port, { id, sessionId: 'sx' }, { ok: true, state: 'starting' })
  assert.equal(res.status, 200)
  assert.deepEqual([cmd.kind, cmd.args], ['followup-send', { sessionId: 'sx' }])
  await nothingQueued(b)
})

test('the card of a follow-up that failed is confirmed again like any retry, to the session it names', async (t) => {
  const { port, a, id } = await withItem(t, { state: 'failed', error: 'the session is busy' })
  const { res, cmd } = await viaAgent(a, port, { id, sessionId: 'sa1' }, { ok: true, state: 'starting' })
  assert.equal(res.status, 200)
  assert.deepEqual([cmd.kind, cmd.itemId], ['followup-send', id])
})

test('a closed or cancelled follow-up is 409 not-open and nothing is sent', async (t) => {
  const { port, a, b, id } = await withItem(t)
  await a.send({ op: 'resolve', id, resolution: { kind: 'cancelled', by: 'card' } })
  assert.deepEqual((await act(port, 'todo-confirm', { id, sessionId: 'sa1' })).json, { ok: false, error: 'not-open' })
  await nothingQueued(a)
  await nothingQueued(b)
})

test('an ordinary todo confirm is unchanged: a stray sessionId is ignored and todo-start goes to the workspace', async (t) => {
  const { port, b } = await twoApps(t)
  await b.send(b.add(1, { type: 'todo', text: 'fix it', state: 'awaiting-confirm', suggested: { workspaceId: 'bbbb/w1', title: 'beta' } }))
  const { res, cmd } = await viaAgent(b, port, { id: b.itemId(1), sessionId: 'sb1' }, { ok: true, state: 'starting' })
  assert.equal(res.status, 200)
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args], ['todo-start', b.itemId(1), { workspaceId: 'w1' }])
})

// ---- an owner that took the command and never answered: the message may have been sent ------------------------------------------------

const MAY_HAVE_BEEN_SENT = 'May have been sent: check the session before retrying.'
async function slowOwner(t) {
  const ctx = await twoApps(t, { commandTimeoutsMs: { 'followup-send': 150 } })
  const { a, b } = ctx
  await a.send(followItem(a, 1, { candidates: cands(a, b), suggested: { sessionId: 'sa1', title: 'PR review', reason: 'x', owner: a.id } }))
  return { ...ctx, id: a.itemId(1) }
}

test('the app that holds the item takes followup-send and never answers: 504 unknown-outcome with the warning; the item stays open and its own but now shows failed with the warning in every UI', async (t) => {
  const { hub, port, a, id } = await slowOwner(t)
  const seen = autopilot(t, a, () => undefined)
  const res = await act(port, 'todo-confirm', { id, sessionId: 'sa1' })
  assert.deepEqual([res.status, res.json], [504, { ok: false, error: 'unknown-outcome', warning: MAY_HAVE_BEEN_SENT }])
  assert.deepEqual(seen.map((c) => c.kind), ['followup-send'])
  const item = hub.store.get(id)
  assert.deepEqual([item.status, item.owner, item.state, item.error], ['open', a.id, 'failed', MAY_HAVE_BEEN_SENT])
  assert.deepEqual(hub.store.snapshot().open.find((i) => i.id === id).error, MAY_HAVE_BEEN_SENT, 'it is in the snapshot every UI reads')
})

test('a move to another app whose owner took the command and never answered: the item is NOT silently put back to awaiting-confirm; it stays open with the app that may have sent it, failed, with the warning', async (t) => {
  const { hub, port, a, b, id } = await slowOwner(t)
  const seen = autopilot(t, b, () => undefined)
  const res = await act(port, 'todo-confirm', { id, sessionId: 'sb1' })
  assert.deepEqual([res.status, res.json], [504, { ok: false, error: 'unknown-outcome', warning: MAY_HAVE_BEEN_SENT }])
  assert.deepEqual(seen.map((c) => c.kind), ['followup-send'], 'the app that took it keeps the item: it may have adopted it and sent the message')
  const item = hub.store.get(id)
  assert.deepEqual([item.status, item.owner, item.state, item.error], ['open', b.id, 'failed', MAY_HAVE_BEEN_SENT])
  const told = (await a.poll(0, 0)).json.commands
  assert.deepEqual(told.map((c) => [c.kind, c.args.change]), [['apply', { op: 'drop', id }]], 'the old owner drops its copy, as after a move that worked')
})

test('Retry of that failed card goes to the app that has the item (followup-send, same item id: the apps derive the same requestId from it); a refusal of an ordinary move still puts the owner back', async (t) => {
  const { hub, port, a, b, id } = await slowOwner(t)
  autopilot(t, b, () => undefined)
  await act(port, 'todo-confirm', { id, sessionId: 'sb1' })
  const retry = act(port, 'todo-confirm', { id, sessionId: 'sb1' })
  const cmd = (await b.poll(0, 3000)).json.commands.find((c) => c.kind === 'followup-send' && c.args.sessionId === 'sb1' && c.seq > 1)
  assert.ok(cmd, 'the second followup-send reached b')
  assert.equal(cmd.itemId, id)
  await b.result(cmd.cid, { ok: true, state: 'starting' })
  assert.equal((await retry).status, 200)
  assert.equal(hub.store.get(id).owner, b.id)
  const refused = await twoApps(t)
  await refused.a.send(followItem(refused.a, 1, { candidates: cands(refused.a, refused.b) }))
  autopilot(t, refused.b, () => ({ ok: false, error: 'no-session' }))
  await act(refused.port, 'todo-confirm', { id: refused.a.itemId(1), sessionId: 'sb1' })
  assert.deepEqual([refused.hub.store.get(refused.a.itemId(1)).owner, refused.hub.store.get(refused.a.itemId(1)).state], [refused.a.id, 'awaiting-confirm'])
})

test('a command nobody fetched in time is owner-timeout: nothing was sent, so no warning', async (t) => {
  const { hub, port, a, id } = await slowOwner(t)
  const res = await act(port, 'todo-confirm', { id, sessionId: 'sb1' }) // b never polls
  assert.deepEqual([res.status, res.json], [504, { ok: false, error: 'owner-timeout' }])
  assert.equal(hub.store.get(id).owner, a.id)
})

// One confirm of an item at a time: a second one that arrives while the first is waiting for its app would send the message twice (possibly to two sessions of two apps).
test('a second confirm of the same item while the first is in flight is not-confirmable: one followup-send only, none to the other app', async (t) => {
  const { hub, port, a, b, id } = await withItem(t)
  const first = act(port, 'todo-confirm', { id, sessionId: 'sa1' })
  const cmd = (await a.poll(0, 3000)).json.commands[0]
  assert.deepEqual([cmd.kind, cmd.args.sessionId], ['followup-send', 'sa1'])
  const second = await act(port, 'todo-confirm', { id, sessionId: 'sb1' })
  assert.deepEqual([second.status, second.json], [409, { ok: false, error: 'not-confirmable' }])
  await nothingQueued(b)
  assert.equal(hub.store.get(id).owner, a.id, 'the second did not move the item')
  await a.result(cmd.cid, { ok: true, state: 'starting' })
  assert.deepEqual([(await first).status, (await first).json], [200, { ok: true, state: 'starting' }])
  await nothingQueued(a)
})

test('the guard is released when the first confirm ends, whether it failed or not: the retry is sent', async (t) => {
  const { port, a, b, id } = await withItem(t)
  const { res } = await viaAgent(a, port, { id, sessionId: 'sa1' }, { ok: false, error: 'not-confirmable' })
  assert.equal(res.status, 409)
  const retry = await viaAgent(b, port, { id, sessionId: 'sb1' }, { ok: true, state: 'starting' })
  assert.deepEqual([retry.res.status, retry.cmd.kind, retry.cmd.args.sessionId], [200, 'followup-send', 'sb1'])
})

// Ownership only moves for an item that waits for a confirm (or a failed one, for the retry): an item an app is already sending ('starting') is nobody's to move.
test('an item that is already starting is not-confirmable: the second confirm names the other app and moves nothing', async (t) => {
  const { hub, port, a, b, id } = await withItem(t, { state: 'starting' })
  const res = await act(port, 'todo-confirm', { id, sessionId: 'sb1' })
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'not-confirmable' }])
  assert.equal(hub.store.get(id).owner, a.id, 'ownership did not move')
  await nothingQueued(a)
  await nothingQueued(b)
})

test('a failed item is confirmable again (Retry), an awaiting one too; any other state is not', async (t) => {
  for (const state of ['started', 'cancelled', 'suggesting', 'weird']) {
    const { port, a, b, id } = await withItem(t, { state })
    const res = await act(port, 'todo-confirm', { id, sessionId: 'sb1' })
    assert.deepEqual([state, res.status, res.json.error], [state, 409, 'not-confirmable'])
    await nothingQueued(a)
    await nothingQueued(b)
  }
  const { port, b, id } = await withItem(t, { state: 'failed', error: 'x' })
  assert.equal((await viaAgent(b, port, { id, sessionId: 'sb1' }, { ok: true, state: 'starting' })).res.status, 200)
})

// A session that is running right now may be in the middle of a task: a MODEL's pick of it is never confirmed without the user choosing a session. The deterministic number match and an explicit choice are.
const runningCands = (a, b) => [{ sessionId: 'sa1', title: 'PR review', running: true, owner: a.id }, { sessionId: 'sb1', title: 'Orca tuning', running: false, owner: b.id }]

test('a model pick of a running session is not confirmed without a session in the body: 400 no-session, nothing is sent or moved', async (t) => {
  const { hub, port, a, b, id } = await withItem(t, { candidates: runningCands({ id: 'aaaa1111' }, { id: 'bbbb2222' }), suggested: { sessionId: 'sb1', title: 'Orca tuning', reason: 'looks right', running: true, owner: 'bbbb2222' } })
  const res = await act(port, 'todo-confirm', { id })
  assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'no-session' }])
  assert.equal(hub.store.get(id).owner, a.id)
  await nothingQueued(a)
  await nothingQueued(b)
})

test('an explicit session in the body is sent even when it is the running one the model suggested', async (t) => {
  const { port, a, id } = await withItem(t, { candidates: runningCands({ id: 'aaaa1111' }, { id: 'bbbb2222' }), suggested: { sessionId: 'sa1', title: 'PR review', reason: 'looks right', running: true, owner: 'aaaa1111' } })
  const { res, cmd } = await viaAgent(a, port, { id, sessionId: 'sa1' }, { ok: true, state: 'starting' })
  assert.deepEqual([res.status, cmd.args.sessionId], [200, 'sa1'])
})

test('a deterministic ticket / PR number pick of a running session is confirmed without a session in the body', async (t) => {
  const { port, a, id } = await withItem(t, { candidates: runningCands({ id: 'aaaa1111' }, { id: 'bbbb2222' }), suggested: { sessionId: 'sa1', title: 'PR review', reason: REF_REASON, running: true, owner: 'aaaa1111' } })
  const { res, cmd } = await viaAgent(a, port, { id }, { ok: true, state: 'starting' })
  assert.deepEqual([res.status, cmd.args.sessionId], [200, 'sa1'])
})

test('a model pick of a session that is not running is still confirmed without a session in the body', async (t) => {
  const { port, b, id } = await withItem(t, { candidates: runningCands({ id: 'aaaa1111' }, { id: 'bbbb2222' }), suggested: { sessionId: 'sb1', title: 'Orca tuning', reason: 'looks right', running: false, owner: 'bbbb2222' } })
  const { res, cmd } = await viaAgent(b, port, { id }, { ok: true, state: 'starting' })
  assert.deepEqual([res.status, cmd.args.sessionId], [200, 'sb1'])
})
