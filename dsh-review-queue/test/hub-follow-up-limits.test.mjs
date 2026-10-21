import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { act, answers, autopilot, followItem, sess, twoApps } from './hub-follow-up-helpers.mjs'

// Hub follow-up: the cap of 10 waiting follow-ups holds for adds that overlap, counting the waiting ones does not copy every open item, and the cache of the union is keyed by a
// registered instance id only (the header is client input).
const BODY = { text: 'also the null case', followUp: 'the PR review' }
const as = (agent) => ({ 'x-rq-instance': agent.id })
const asks = (seen) => seen.filter((c) => c.kind === 'sessions-list').length
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waiting = (agent, from, count) => Array.from({ length: count }, (_, i) => followItem(agent, from + i, { candidates: [{ sessionId: 'sa1', title: 'A', owner: agent.id }] }))

test('adds that overlap cannot all pass the cap: with 9 waiting and 3 adds at once only one is let in, and a place is free again when it ends', async (t) => {
  const { port, a, b } = await twoApps(t)
  await a.send(...waiting(a, 1, 9))
  const gate = deferred()
  const slow = (agent, sessions) => async (cmd) => { if (cmd.kind === 'sessions-list') await gate.promise; return answers(agent, sessions)(cmd) }
  autopilot(t, a, slow(a, [sess('sa1', 100)]))
  autopilot(t, b, slow(b, []))
  const adds = [1, 2, 3].map(() => act(port, 'todo', BODY, as(a)))
  await sleep(150) // all three have been looked at; the one let in waits for the apps
  gate.resolve()
  const results = await Promise.all(adds)
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409])
  assert.deepEqual(results.filter((r) => r.status === 409).map((r) => r.json.error), ['too-many-follow-ups', 'too-many-follow-ups'])
  assert.equal((await act(port, 'todo', BODY, as(a))).status, 200, 'the add that finished left no place taken')
})

test('an add that fails (the coordinator refuses) gives its place back', async (t) => {
  const { port, a, b } = await twoApps(t)
  await a.send(...waiting(a, 1, 9))
  let refuse = true
  autopilot(t, a, (cmd) => (cmd.kind === 'followup-suggest' && refuse ? { ok: false, error: 'failed' } : answers(a, [sess('sa1', 100)])(cmd)))
  autopilot(t, b, answers(b, []))
  assert.equal((await act(port, 'todo', BODY, as(a))).status, 409)
  refuse = false
  for (let n = 0; n < 3; n++) assert.equal((await act(port, 'todo', BODY, as(a))).status, 200, 'try ' + n)
})

test('counting the waiting follow-ups does not copy the open items (no store.list of the open ones)', async (t) => {
  const { hub, port, a, b } = await twoApps(t)
  autopilot(t, a, answers(a, [sess('sa1', 100)]))
  autopilot(t, b, answers(b, []))
  await a.send(...waiting(a, 1, 3))
  const original = hub.store.list
  const listed = []
  hub.store.list = (filter) => { listed.push(filter); return original(filter) }
  t.after(() => { hub.store.list = original })
  assert.equal((await act(port, 'todo', BODY, as(a))).status, 200)
  assert.deepEqual(listed.filter((f) => f?.status === 'open'), [])
})

test('store.count(predicate) counts the items a test accepts, on the live items, without copying them', () => {
  const store = createStore()
  const one = store.add({ type: 'todo', kind: 'followup', state: 'awaiting-confirm', big: 'x'.repeat(1000) })
  store.add({ type: 'todo', kind: 'followup', state: 'failed' })
  store.add({ type: 'completed' })
  store.resolve(one.id, { kind: 'cancelled' })
  const seen = []
  assert.equal(store.count((i) => { seen.push(i); return i.status === 'open' && i.type === 'todo' }), 1)
  assert.equal(seen.length, 3, 'every item was looked at once')
  assert.equal(store.count(() => true), 3)
  assert.equal(store.count(() => false), 0)
  const live = store.dump().items
  assert.ok(seen.every((i, n) => live.includes(i)), 'the live items, not clones')
})

test('the union cache is keyed by a registered instance id: caller headers that name no app share one entry (one round of questions)', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  const seenB = autopilot(t, b, answers(b, [sess('sb1', 200)]))
  for (const name of ['nobody-1', 'nobody-2', 'nobody-3', 'x'.repeat(500), '']) assert.equal((await act(port, 'todo', BODY, { 'x-rq-instance': name })).status, 200, name.slice(0, 10))
  assert.deepEqual([asks(seenA), asks(seenB)], [1, 1])
})

test('a registered caller still has its own entry, its own sessions first', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  const seenB = autopilot(t, b, answers(b, [sess('sb1', 200)]))
  await act(port, 'todo', BODY, as(a))
  await act(port, 'todo', BODY, as(b))
  assert.deepEqual([asks(seenA), asks(seenB)], [2, 2])
  assert.deepEqual(seenB.find((c) => c.kind === 'followup-suggest').args.sessions.map((s) => s.sessionId), ['sb1', 'sa1'])
})

test('a followUp that is false or 0 is refused as empty-query (the hub treats any present value as a follow-up)', async (t) => {
  const { port, a } = await twoApps(t)
  for (const followUp of [false, 0, true, []]) {
    const res = await act(port, 'todo', { text: 'x', followUp }, as(a))
    assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'empty-query' }], JSON.stringify(followUp))
  }
})
