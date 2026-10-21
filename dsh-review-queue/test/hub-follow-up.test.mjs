import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AWAY_MS } from '../hub/instances.js'
import { startHub } from './hub-agent-helpers.mjs'
import * as hubFollowUp from '../hub/follow-up.js'
import { act, answers, autopilot, kinds, nothingQueued, sess, twoApps } from './hub-follow-up-helpers.mjs'

// Follow-up todo, hub side (docs/hub.md 6.4a): POST /v1/todo {text, followUp} asks every online app for its sessions (sessions-list), tags each with
// the app it came from, and hands the union to the coordinator as followup-suggest. These tests speak raw agent HTTP to a real hub.

const BODY = { text: 'also the null case', followUp: 'the PR review' }
const suggestOf = (seen) => seen.find((c) => c.kind === 'followup-suggest')

test('both apps are asked for their sessions; the union, tagged with the app each session lives in and newest first, goes to the coordinator', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100, { workspaceTitle: 'alpha', snippet: 'hi there' }), sess('sa2', 300)]))
  const seenB = autopilot(t, b, answers(b, [sess('sb1', 200, { owner: 'cccc3333' })])) // an app cannot name another owner for its sessions
  const res = await act(port, 'todo', BODY, { 'x-rq-instance': a.id })
  assert.deepEqual([res.status, res.json], [200, { ok: true, id: a.itemId(9), state: 'awaiting-confirm' }])
  const suggest = suggestOf(seenA)
  assert.deepEqual(suggest.args, {
    text: 'also the null case', followUp: 'the PR review',
    sessions: [
      { sessionId: 'sa2', title: 'Title sa2', updatedAt: 300, running: false, owner: a.id },
      { sessionId: 'sb1', title: 'Title sb1', updatedAt: 200, running: false, owner: b.id },
      { sessionId: 'sa1', title: 'Title sa1', updatedAt: 100, running: false, workspaceTitle: 'alpha', snippet: 'hi there', owner: a.id },
    ],
  })
  assert.equal(suggest.itemId, undefined, 'a new item: nothing to adopt yet')
  assert.deepEqual([kinds(seenA), kinds(seenB)], [['sessions-list', 'followup-suggest'], ['sessions-list']])
})

test('the coordinator is the calling app, so the same follow-up from b is suggested by b', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  const seenB = autopilot(t, b, answers(b, [sess('sb1', 200)]))
  const res = await act(port, 'todo', BODY, { 'x-rq-instance': b.id })
  assert.equal(res.status, 200)
  assert.deepEqual([kinds(seenA), kinds(seenB)], [['sessions-list'], ['sessions-list', 'followup-suggest']])
})

test('a session both apps list is taken once, from the app that lists it first: the caller before the others', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('dup', 50, { title: 'from a' })]))
  const seenB = autopilot(t, b, answers(b, [sess('dup', 90, { title: 'from b' }), sess('only-b', 10)]))
  await act(port, 'todo', BODY, { 'x-rq-instance': a.id })
  assert.deepEqual(suggestOf(seenA).args.sessions.map((s) => [s.sessionId, s.title, s.owner]), [['dup', 'from a', a.id], ['only-b', 'Title only-b', b.id]])
  await act(port, 'todo', BODY, { 'x-rq-instance': b.id })
  assert.deepEqual(suggestOf(seenB).args.sessions.map((s) => [s.sessionId, s.title, s.owner]), [['dup', 'from b', b.id], ['only-b', 'Title only-b', b.id]])
  assert.deepEqual(suggestOf(seenB).args.sessions.map((s) => s.sessionId).sort(), ['dup', 'only-b'], 'once each')
})

test('the union is cut to the 60 newest sessions of all apps', async (t) => {
  const { port, a, b } = await twoApps(t)
  const mine = Array.from({ length: 50 }, (_, i) => sess('a' + i, 2 * i)) // even times 0..98
  const theirs = Array.from({ length: 50 }, (_, i) => sess('b' + i, 2 * i + 1)) // odd times 1..99
  const seenA = autopilot(t, a, answers(a, mine))
  autopilot(t, b, answers(b, theirs))
  const res = await act(port, 'todo', BODY, { 'x-rq-instance': a.id })
  assert.equal(res.status, 200)
  const sessions = suggestOf(seenA).args.sessions
  const expected = []
  for (let time = 99; time >= 40; time--) expected.push((time % 2 === 0 ? 'a' + time / 2 : 'b' + (time - 1) / 2))
  assert.deepEqual(sessions.map((s) => s.sessionId), expected)
  assert.deepEqual(sessions.map((s) => s.owner), expected.map((id) => (id[0] === 'a' ? a.id : b.id)))
})

test('an app that answers an error contributes nothing, and the follow-up still reaches the coordinator', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  autopilot(t, b, () => ({ ok: false, error: 'boom' }))
  const res = await act(port, 'todo', BODY, { 'x-rq-instance': a.id })
  assert.equal(res.status, 200)
  assert.deepEqual(suggestOf(seenA).args.sessions.map((s) => s.sessionId), ['sa1'])
})

test('an app that does not answer in time contributes nothing, and the add does not wait for the default 10 s', async (t) => {
  const { port, a, b } = await twoApps(t, { commandTimeoutsMs: { 'sessions-list': 150 } })
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  const seenB = autopilot(t, b, () => undefined) // fetches the command and never answers
  const started = Date.now()
  const res = await act(port, 'todo', BODY, { 'x-rq-instance': a.id })
  assert.equal(res.status, 200)
  assert.ok(Date.now() - started < 3000, 'took ' + (Date.now() - started) + ' ms')
  assert.deepEqual(kinds(seenB), ['sessions-list'])
  assert.deepEqual(suggestOf(seenA).args.sessions.map((s) => s.sessionId), ['sa1'])
})

test('an unusable list is ignored entry by entry: no array, entries without a session id, extra fields', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  autopilot(t, b, () => ({ ok: true, sessions: [null, 5, 'x', { title: 'no id' }, { sessionId: '' }, { sessionId: 7 }, { sessionId: 'sb-ok', title: 'ok', updatedAt: 'later', evil: { deep: true }, running: 'yes' }] }))
  await act(port, 'todo', BODY, { 'x-rq-instance': a.id })
  assert.deepEqual(suggestOf(seenA).args.sessions.map((s) => s.sessionId), ['sa1', 'sb-ok'])
  assert.deepEqual(suggestOf(seenA).args.sessions[1], { sessionId: 'sb-ok', title: 'ok', owner: b.id }, 'only the known fields, with the right types')
  const odd = await twoApps(t)
  const seen = autopilot(t, odd.a, answers(odd.a, []))
  autopilot(t, odd.b, () => ({ ok: true, sessions: 'nope' }))
  assert.equal((await act(odd.port, 'todo', BODY, { 'x-rq-instance': odd.a.id })).status, 200)
  assert.deepEqual(suggestOf(seen).args.sessions, [])
})

test('an app that is away or gone is not asked, and nothing is queued for it', async (t) => {
  const { hub, port, a, b, clock } = await twoApps(t)
  clock.advance(AWAY_MS + 1000)
  hub.instances.tick() // both are away now
  await a.poll(0, 0) // a polls again: online
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  const res = await act(port, 'todo', BODY, { 'x-rq-instance': a.id })
  assert.equal(res.status, 200)
  assert.deepEqual(suggestOf(seenA).args.sessions.map((s) => s.sessionId), ['sa1'])
  await nothingQueued(b)
  const gone = await twoApps(t)
  gone.hub.instances.bye(gone.b.id)
  const seenGone = autopilot(t, gone.a, answers(gone.a, [sess('sa1', 100)]))
  assert.equal((await act(gone.port, 'todo', BODY, { 'x-rq-instance': gone.a.id })).status, 200)
  assert.deepEqual(kinds(seenGone), ['sessions-list', 'followup-suggest'])
  assert.equal(gone.hub.commands.pending(gone.b.id), 0, 'nothing waits for the app that is gone')
})

test('with no app online the follow-up is 409 no-registry; with one that lists nothing the coordinator is told so (an empty list)', async (t) => {
  const empty = await startHub(t)
  assert.deepEqual((await act(empty.port, 'todo', BODY)).json, { ok: false, error: 'no-registry' })
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, []))
  autopilot(t, b, answers(b, []))
  assert.equal((await act(port, 'todo', BODY, { 'x-rq-instance': a.id })).status, 200)
  assert.deepEqual(suggestOf(seenA).args.sessions, [])
})

test('the words and the message are checked before any app is asked: 400 empty-query / empty / too-long, nothing queued', async (t) => {
  const { port, a, b } = await twoApps(t)
  const cases = [
    [{ text: 'x', followUp: '   ' }, 'empty-query'],
    [{ text: 'x', followUp: '' }, 'empty-query'],
    [{ text: 'x', followUp: 5 }, 'empty-query'],
    [{ text: 'x', followUp: { a: 1 } }, 'empty-query'],
    [{ text: '  ', followUp: 'words' }, 'empty'],
    [{ followUp: 'words' }, 'empty'],
    [{ text: 'x', followUp: 'w'.repeat(301) }, 'too-long'],
    [{ text: 'x'.repeat(4001), followUp: 'words' }, 'too-long'],
  ]
  for (const [body, error] of cases) {
    const res = await act(port, 'todo', body, { 'x-rq-instance': a.id })
    assert.deepEqual([res.status, res.json], [400, { ok: false, error }], JSON.stringify(body).slice(0, 60))
  }
  await nothingQueued(a)
  await nothingQueued(b)
})

test('a follow-up never takes a workspace: workspaceId and sparc in the body change nothing', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  autopilot(t, b, answers(b, []))
  const res = await act(port, 'todo', { ...BODY, workspaceId: 'bbbb/w1', sparc: true }, { 'x-rq-instance': a.id })
  assert.equal(res.status, 200)
  assert.deepEqual(kinds(seenA), ['sessions-list', 'followup-suggest'])
  assert.deepEqual(Object.keys(suggestOf(seenA).args).sort(), ['followUp', 'sessions', 'text'])
})

test('the candidates are the apps\' own: a sessions list in the body is never passed on', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  autopilot(t, b, answers(b, []))
  const evil = [{ sessionId: 'evil', title: 'Not mine', owner: b.id, updatedAt: 9_999_999 }]
  await act(port, 'todo', { ...BODY, sessions: evil }, { 'x-rq-instance': a.id })
  assert.deepEqual(suggestOf(seenA).args.sessions.map((s) => s.sessionId), ['sa1'])
})

test('what the coordinator answers is the answer: its refusals are mapped like the rest (400 empty-query, 409 for a refusal)', async (t) => {
  const { port, a, b } = await twoApps(t)
  autopilot(t, b, answers(b, [])) // an app that does not answer would hold every add for the command timeout
  let refusal = { ok: false, error: 'empty-query' }
  autopilot(t, a, (cmd) => (cmd.kind === 'sessions-list' ? { ok: true, sessions: [] } : refusal))
  assert.deepEqual([(await act(port, 'todo', BODY, { 'x-rq-instance': a.id })).status], [400])
  refusal = { ok: false, error: 'failed' }
  assert.deepEqual([(await act(port, 'todo', BODY, { 'x-rq-instance': a.id })).status], [409])
})

test('a todo without followUp is untouched: no sessions-list, todo-suggest as before', async (t) => {
  const { port, a } = await twoApps(t)
  const seen = autopilot(t, a, () => ({ ok: true, id: a.itemId(1), state: 'awaiting-confirm' }))
  assert.equal((await act(port, 'todo', { text: 'fix it', followUp: undefined }, { 'x-rq-instance': a.id })).status, 200)
  assert.equal((await act(port, 'todo', { text: 'fix it again', followUp: null }, { 'x-rq-instance': a.id })).status, 200)
  assert.deepEqual(kinds(seen), ['todo-suggest', 'todo-suggest'])
})

// ---- an app that is asked and does not answer is logged and counted --------------------------------------------------------------------

test('an app that answers an error is logged (hub log) and counted: the coordinator is told skippedApps 1', async (t) => {
  const { port, a, b, logs } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  autopilot(t, b, () => ({ ok: false, error: 'boom' }))
  assert.equal((await act(port, 'todo', BODY, { 'x-rq-instance': a.id })).status, 200)
  assert.equal(suggestOf(seenA).args.skippedApps, 1)
  assert.deepEqual(logs.filter((l) => l.startsWith('follow-up: ')), ['follow-up: app ' + b.id + ' skipped (boom)'])
})

test('an app that does not answer in time is logged with the hub\'s code and counted', async (t) => {
  const { port, a, b, logs } = await twoApps(t, { commandTimeoutsMs: { 'sessions-list': 120 } })
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  autopilot(t, b, () => undefined)
  assert.equal((await act(port, 'todo', BODY, { 'x-rq-instance': a.id })).status, 200)
  assert.equal(suggestOf(seenA).args.skippedApps, 1)
  assert.deepEqual(logs.filter((l) => l.startsWith('follow-up: ')), ['follow-up: app ' + b.id + ' skipped (unknown-outcome)'])
})

test('every app failing is counted per app; an app that answered with no sessions is not skipped', async (t) => {
  const both = await twoApps(t)
  const seen = autopilot(t, both.a, (cmd) => (cmd.kind === 'sessions-list' ? { ok: false, error: 'busy' } : { ok: true, id: both.a.itemId(9), state: 'awaiting-confirm' }))
  autopilot(t, both.b, () => ({ ok: false, error: 'busy' }))
  assert.equal((await act(both.port, 'todo', BODY, { 'x-rq-instance': both.a.id })).status, 200)
  assert.equal(suggestOf(seen).args.skippedApps, 2)
  assert.equal(both.logs.filter((l) => l.startsWith('follow-up: ')).length, 2)
  const fine = await twoApps(t)
  const seenFine = autopilot(t, fine.a, answers(fine.a, []))
  autopilot(t, fine.b, answers(fine.b, []))
  await act(fine.port, 'todo', BODY, { 'x-rq-instance': fine.a.id })
  assert.equal('skippedApps' in suggestOf(seenFine).args, false)
  assert.deepEqual(fine.logs.filter((l) => l.startsWith('follow-up: ')), [])
})

test('a hostile error text from an app cannot forge or flood a log line', async (t) => {
  const { port, a, b, logs } = await twoApps(t)
  autopilot(t, a, answers(a, []))
  autopilot(t, b, () => ({ ok: false, error: 'x\nforged: line ' + 'y'.repeat(300) }))
  await act(port, 'todo', BODY, { 'x-rq-instance': a.id })
  const lines = logs.filter((l) => l.startsWith('follow-up: '))
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0], /[\r\n]/)
  assert.ok(lines[0].length < 120, 'bounded: ' + lines[0].length)
})

test('the hub half is createHubFollowUps (not the name of the app half)', () => {
  assert.equal(typeof hubFollowUp.createHubFollowUps, 'function')
  assert.equal(hubFollowUp.createFollowUps, undefined)
})
