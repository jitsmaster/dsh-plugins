import { test } from 'node:test'
import assert from 'node:assert/strict'
import { act, answers, autopilot, followItem, kinds, nothingQueued, sess, twoApps } from './hub-follow-up-helpers.mjs'

// Cost of a follow-up on the hub: every add asks every online app for its sessions (a controller list plus log reads on each PC). The union is shared: concurrent adds of one
// caller make one round of questions (single flight), and an answer is reused for 5 s (keyed by the caller, whose own sessions come first); an incomplete answer (an app failed or
// did not answer) is not kept. And only 10 follow-ups may wait for a confirmation at the same time.
const BODY = { text: 'also the null case', followUp: 'the PR review' }
const as = (agent) => ({ 'x-rq-instance': agent.id })
const asks = (seen) => seen.filter((c) => c.kind === 'sessions-list').length

async function apps(t, { sa = [sess('sa1', 100)], sb = [sess('sb1', 200)] } = {}) {
  const ctx = await twoApps(t)
  const seenA = autopilot(t, ctx.a, answers(ctx.a, sa))
  const seenB = autopilot(t, ctx.b, answers(ctx.b, sb))
  return { ...ctx, seenA, seenB }
}

// ---- F1: single flight and a 5 s cache of the union --------------------------------------------------------------------------------------

test('a second add of the same caller within 5 s reuses the union: every app is asked once, the coordinator gets the same sessions twice', async (t) => {
  const { port, a, seenA, seenB } = await apps(t)
  assert.equal((await act(port, 'todo', BODY, as(a))).status, 200)
  assert.equal((await act(port, 'todo', BODY, as(a))).status, 200)
  assert.deepEqual([asks(seenA), asks(seenB)], [1, 1])
  const suggests = seenA.filter((c) => c.kind === 'followup-suggest')
  assert.equal(suggests.length, 2)
  assert.deepEqual(suggests[1].args.sessions, suggests[0].args.sessions)
  assert.deepEqual(suggests[0].args.sessions.map((s) => [s.sessionId, s.owner]), [['sb1', 'bbbb2222'], ['sa1', 'aaaa1111']])
})

test('adds that overlap share one round of questions (single flight)', async (t) => {
  const { port, a, seenA, seenB } = await apps(t)
  const all = await Promise.all([1, 2, 3].map(() => act(port, 'todo', BODY, as(a))))
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200])
  assert.deepEqual([asks(seenA), asks(seenB)], [1, 1])
})

test('after 5 s the union is asked for again', async (t) => {
  const { port, a, clock, seenA, seenB } = await apps(t)
  await act(port, 'todo', BODY, as(a))
  clock.advance(4900)
  await act(port, 'todo', BODY, as(a))
  assert.deepEqual([asks(seenA), asks(seenB)], [1, 1], 'still within 5 s')
  clock.advance(200)
  await act(port, 'todo', BODY, as(a))
  assert.deepEqual([asks(seenA), asks(seenB)], [2, 2], 'over 5 s')
})

test('the union is kept per caller: another caller (its own sessions come first) is a new round', async (t) => {
  const { port, a, b, seenA, seenB } = await apps(t)
  await act(port, 'todo', BODY, as(a))
  await act(port, 'todo', BODY, as(b))
  assert.deepEqual([asks(seenA), asks(seenB)], [2, 2])
  const forB = seenB.find((c) => c.kind === 'followup-suggest')
  assert.deepEqual(forB.args.sessions.map((s) => s.sessionId), ['sb1', 'sa1'])
  await act(port, 'todo', BODY, as(b))
  assert.deepEqual([asks(seenA), asks(seenB)], [2, 2], 'and its own answer is then reused')
})

test('an incomplete union is not kept: an app that failed is asked again by the next add, and once it answers the union is kept', async (t) => {
  const ctx = await twoApps(t)
  const { port, a, b } = ctx
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  let broken = true
  const seenB = autopilot(t, b, (cmd) => (cmd.kind === 'sessions-list' && broken ? { ok: false, error: 'boom' } : answers(b, [sess('sb1', 200)])(cmd)))
  await act(port, 'todo', BODY, as(a))
  await act(port, 'todo', BODY, as(a))
  assert.deepEqual([asks(seenA), asks(seenB)], [2, 2], 'a failed round is not reused')
  assert.equal(seenA.filter((c) => c.kind === 'followup-suggest')[0].args.skippedApps, 1)
  broken = false
  await act(port, 'todo', BODY, as(a))
  await act(port, 'todo', BODY, as(a))
  assert.deepEqual([asks(seenA), asks(seenB)], [3, 3], 'the good round is kept for the next add')
  assert.equal('skippedApps' in seenA.filter((c) => c.kind === 'followup-suggest').at(-1).args, false)
})

test('a request that is refused before any app is asked (empty words) does not start a round', async (t) => {
  const { port, a, seenA, seenB } = await apps(t)
  assert.equal((await act(port, 'todo', { text: 'x', followUp: ' ' }, as(a))).status, 400)
  assert.deepEqual([asks(seenA), asks(seenB)], [0, 0])
})

// ---- F2: at most 10 follow-ups wait for a confirmation -----------------------------------------------------------------------------------

const waitingItems = (agent, from, count, over = {}) => Array.from({ length: count }, (_, i) => followItem(agent, from + i, { candidates: [{ sessionId: 'sa1', title: 'A', owner: agent.id }], ...over }))

test('the 11th follow-up waiting for a confirmation is refused: 409 too-many-follow-ups, and no app is asked', async (t) => {
  const { port, a, b } = await twoApps(t)
  await a.send(...waitingItems(a, 1, 6))
  await b.send(...waitingItems(b, 1, 4)) // the cap is the hub's, whichever app holds the items
  const res = await act(port, 'todo', BODY, as(a))
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'too-many-follow-ups' }])
  await nothingQueued(a)
  await nothingQueued(b)
})

test('only open awaiting-confirm follow-ups count: failed, starting, started, cancelled ones and ordinary todos do not; a confirm or a cancel frees a place', async (t) => {
  const { hub, port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, []))
  autopilot(t, b, answers(b, []))
  await a.send(...waitingItems(a, 1, 9))
  await a.send(
    ...waitingItems(a, 10, 1, { state: 'failed', error: 'x' }), ...waitingItems(a, 11, 1, { state: 'starting' }),
    ...waitingItems(a, 12, 1, { state: 'started', sessionId: 's1' }), ...waitingItems(a, 13, 1, { state: 'cancelled' }),
    a.add(14, { type: 'todo', text: 'fix it', state: 'awaiting-confirm' }), a.add(15, { type: 'todo', text: 'fix it too', state: 'awaiting-confirm' }),
  )
  await a.send({ op: 'resolve', id: a.itemId(13), resolution: { kind: 'cancelled', by: 'card' } })
  assert.equal(hub.store.list({ status: 'open' }).length > 10, true, 'more than 10 open todos, only 9 of them waiting follow-ups')
  const tenth = await act(port, 'todo', BODY, as(a))
  assert.equal(tenth.status, 200, 'the 10th is allowed')
  await a.send(followItem(a, 20, { candidates: [] })) // it is now there
  const eleventh = await act(port, 'todo', BODY, as(a))
  assert.deepEqual([eleventh.status, eleventh.json.error], [409, 'too-many-follow-ups'])
  const askedBefore = seenA.filter((c) => c.kind === 'followup-suggest').length
  await a.send({ op: 'resolve', id: a.itemId(20), resolution: { kind: 'cancelled', by: 'card' } })
  assert.equal((await act(port, 'todo', BODY, as(a))).status, 200, 'a cancelled one frees its place')
  assert.equal(seenA.filter((c) => c.kind === 'followup-suggest').length, askedBefore + 1)
})

test('an ordinary todo is never refused by the follow-up cap', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, (cmd) => ({ ok: true, id: a.itemId(30), state: 'awaiting-confirm' }))
  await a.send(...waitingItems(a, 1, 10))
  const res = await act(port, 'todo', { text: 'fix it' }, as(a))
  assert.equal(res.status, 200)
  assert.deepEqual(kinds(seenA), ['todo-suggest'])
})
