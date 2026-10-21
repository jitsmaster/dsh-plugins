import { test } from 'node:test'
import assert from 'node:assert/strict'
import { act, autopilot, kinds, sess, twoApps } from './hub-follow-up-helpers.mjs'
import { MAY_HAVE_BEEN_SENT, REF_REASON, refNumbersOf, suggestSessionByRef } from '../follow-up-shared.js'

// The snippets of the sessions (the last message of each, which costs a log read on the app's PC) are only for the model. When the words of a follow-up hold a ticket / PR number, the hub
// asks the apps for their sessions WITHOUT snippets first (args.snippets false); if a title decides, that is the only round; if not, it asks again, for the snippets.
const as = (agent) => ({ 'x-rq-instance': agent.id })
const REF = { text: 'also the null case', followUp: 'the one for ticket 25001' }
const lists = (seen) => seen.filter((c) => c.kind === 'sessions-list')
const suggestOf = (seen) => seen.find((c) => c.kind === 'followup-suggest')
/** An app that answers sessions-list with or without snippets as it is asked, and the suggestion with an accepted item. */
const lister = (agent, sessions) => (cmd) => {
  if (cmd.kind === 'sessions-list') return { ok: true, sessions: cmd.args.snippets === false ? sessions.map(({ snippet, ...rest }) => rest) : sessions }
  if (cmd.kind === 'followup-suggest') return { ok: true, id: agent.itemId(9), state: 'awaiting-confirm' }
  return { ok: false, error: 'unexpected-' + cmd.kind }
}

test('the shared leaf module has the ticket / PR number matcher the hub uses, with the reason the cards trust', () => {
  assert.equal(REF_REASON, 'ticket or PR number in the words')
  assert.deepEqual([...refNumbersOf('AB#12 and #34, ticket 56, PR 78, pull request #90, work item 11; bare 12345')].sort(), ['11', '12', '34', '56', '78', '90'])
  assert.deepEqual(suggestSessionByRef('ticket 25001', [{ sessionId: 'a', title: 'Fix - 25001' }, { sessionId: 'b', title: 'x' }]), { sessionId: 'a', title: 'Fix - 25001', reason: REF_REASON })
  assert.equal(suggestSessionByRef('ticket 25001', [{ sessionId: 'a', title: 'Fix - 25001' }, { sessionId: 'b', title: '250011' }, { sessionId: 'c', title: 'also 25001' }]), undefined)
  assert.equal(MAY_HAVE_BEEN_SENT, 'May have been sent: check the session before retrying.')
})

test('a number that decides one title: every app is asked once, without snippets, and the coordinator gets that union', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, lister(a, [sess('sa1', 100, { title: 'Fix login - 25001', snippet: 'secret last words' })]))
  const seenB = autopilot(t, b, lister(b, [sess('sb1', 200, { snippet: 'other words' })]))
  assert.equal((await act(port, 'todo', REF, as(a))).status, 200)
  assert.deepEqual([lists(seenA).length, lists(seenB).length], [1, 1])
  assert.deepEqual([lists(seenA)[0].args, lists(seenB)[0].args], [{ snippets: false }, { snippets: false }])
  const sessions = suggestOf(seenA).args.sessions
  assert.deepEqual(sessions.map((s) => s.sessionId), ['sb1', 'sa1'])
  assert.ok(sessions.every((s) => !('snippet' in s)))
})

test('a number that decides nothing: the apps are asked again, this time for the snippets, and the coordinator gets those', async (t) => {
  for (const [title, other] of [['Other work', 'Third thing'], ['Fix - 25001', 'Also 25001']]) { // no title has the number / two sessions have it
    const { port, a, b } = await twoApps(t)
    const seenA = autopilot(t, a, lister(a, [sess('sa1', 100, { title, snippet: 'last words of a' }), sess('sa2', 50, { title: other })]))
    const seenB = autopilot(t, b, lister(b, [sess('sb1', 200, { snippet: 'last words of b' })]))
    assert.equal((await act(port, 'todo', REF, as(a))).status, 200)
    assert.deepEqual(lists(seenA).map((c) => c.args), [{ snippets: false }, {}], title)
    assert.deepEqual(lists(seenB).map((c) => c.args), [{ snippets: false }, {}])
    const sessions = suggestOf(seenA).args.sessions
    assert.deepEqual(sessions.map((s) => s.snippet), ['last words of b', 'last words of a', undefined])
  }
})

test('words without a ticket or PR number: one round with the snippets, as before', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, lister(a, [sess('sa1', 100, { snippet: 'words' })]))
  const seenB = autopilot(t, b, lister(b, []))
  assert.equal((await act(port, 'todo', { text: 'x', followUp: 'the PR review with 25001' }, as(a))).status, 200)
  assert.deepEqual([lists(seenA).map((c) => c.args), lists(seenB).map((c) => c.args)], [[{}], [{}]])
  assert.deepEqual(kinds(seenA), ['sessions-list', 'followup-suggest'])
})

test('each round is kept for 5 s on its own: a second add with the same words asks nobody again; the plain union is not mistaken for the full one', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, lister(a, [sess('sa1', 100, { title: 'Other', snippet: 'words of a' })]))
  const seenB = autopilot(t, b, lister(b, []))
  await act(port, 'todo', REF, as(a))
  await act(port, 'todo', REF, as(a))
  assert.deepEqual([lists(seenA).length, lists(seenB).length], [2, 2], 'two rounds in all, both kept')
  await act(port, 'todo', { text: 'x', followUp: 'the review' }, as(a)) // no number: wants the full union, which the first add already made
  assert.deepEqual([lists(seenA).length, lists(seenB).length], [2, 2])
  assert.equal(suggestOf(seenA) && seenA.filter((c) => c.kind === 'followup-suggest').at(-1).args.sessions[0].snippet, 'words of a')
})
