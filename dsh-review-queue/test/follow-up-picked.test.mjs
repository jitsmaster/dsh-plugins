import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { PICKED_REASON, REF_REASON, isSessionIdWords, isTrustedReason, suggestSessionByRef } from '../follow-up-shared.js'
import { P } from './hub-agent-helpers.mjs'
import { raw } from './hub-helpers.mjs'
import { answers, autopilot, sess, twoApps } from './hub-follow-up-helpers.mjs'

// The Follow up form of the Task list picks the session in a dropdown: GET /v1/follow-up-sessions lists the sessions (no snippets), and the form sends the
// chosen session id as the "words" of POST /v1/todo, which is then a deterministic pick (reason PICKED_REASON, trusted like a ticket / PR number match).

test('suggestSessionByRef: the words that are exactly one listed session id pick that session, with the reason the user picked it', () => {
  const list = [{ sessionId: 'session-aaa', title: 'One' }, { sessionId: 'session-bbb', title: 'Two' }]
  assert.deepEqual(suggestSessionByRef('session-bbb', list), { sessionId: 'session-bbb', title: 'Two', reason: PICKED_REASON })
  assert.deepEqual(suggestSessionByRef('  session-aaa  ', list), { sessionId: 'session-aaa', title: 'One', reason: PICKED_REASON })
  assert.equal(suggestSessionByRef('session-ccc', list), undefined, 'an id that is not listed picks nothing')
  assert.equal(suggestSessionByRef('the PR review session', list), undefined, 'words are not an id')
})

test('the id pick wins over a ticket number in a title, and the number match still works for words', () => {
  const list = [{ sessionId: 's1', title: 'PR 6563 review' }, { sessionId: 's2', title: 'Other' }]
  assert.equal(suggestSessionByRef('s2', list).sessionId, 's2')
  assert.equal(suggestSessionByRef('PR 6563', list).reason, REF_REASON)
})

test('isSessionIdWords and isTrustedReason: one id-like word; the two marks no model writes', () => {
  assert.equal(isSessionIdWords('session-91622541-1f08'), true)
  assert.equal(isSessionIdWords(' s1 '), true)
  assert.equal(isSessionIdWords('the PR review'), false)
  assert.equal(isSessionIdWords(''), false)
  assert.equal(isSessionIdWords(undefined), false)
  assert.equal(isTrustedReason(PICKED_REASON), true)
  assert.equal(isTrustedReason(REF_REASON), true)
  assert.equal(isTrustedReason('suggested by the model'), false)
  assert.equal(isTrustedReason(undefined), false)
})

// ---- this app alone -----------------------------------------------------------------------------------------------

async function app(t) {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const prompts = []
  const items = [
    { sessionId: 'sa', updatedAt: 3000, running: false, blank: false, agentAvailable: true },
    { sessionId: 'sb', updatedAt: 2000, running: true, blank: false, agentAvailable: true },
  ]
  const controller = { list: async () => ({ items }), prompt: async (req) => { prompts.push(req); return {} } }
  const registry = { list: () => [{ id: 'w1', title: 'Alpha', path: 'D:/a', sessionIds: ['sa'] }], archivedSessionIds: [] }
  const titlesOf = async (ids) => new Map(ids.map((id) => [id, 'Title ' + id]))
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, registryOf: () => registry, titlesOf })
  const serve = createRouter({ queue, dev: undefined })
  const server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const base = 'http://127.0.0.1:' + server.address().port
  return { base, store, queue, prompts, post: (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
}

test('GET /v1/follow-up-sessions lists this app\'s sessions newest first with title, workspace and running; other methods are 405', async (t) => {
  const a = await app(t)
  const res = await fetch(a.base + '/v1/follow-up-sessions')
  assert.equal(res.status, 200)
  const { sessions } = await res.json()
  assert.deepEqual(sessions.map((s) => [s.sessionId, s.title, s.workspaceTitle, s.running]), [['sa', 'Title sa', 'Alpha', false], ['sb', 'Title sb', undefined, true]])
  assert.ok(sessions.every((s) => s.snippet === undefined), 'no snippet: the list is for a dropdown')
  assert.equal((await a.post('/v1/follow-up-sessions', {})).status, 405)
})

test('POST /v1/todo with a followUp that is a session id: the item waits for the confirm with that session picked, even a running one, without asking a model', async (t) => {
  const a = await app(t)
  const body = await (await a.post('/v1/todo', { text: 'Do the next thing', followUp: 'sb' })).json()
  assert.equal(body.ok, true)
  await a.queue.todoIdle()
  const item = a.store.get(body.id)
  assert.equal(item.state, 'awaiting-confirm')
  assert.equal(item.suggested.sessionId, 'sb')
  assert.equal(item.suggested.reason, PICKED_REASON)
  assert.deepEqual(a.prompts, [], 'nothing is sent before the confirm')
  const ok = await a.post('/v1/todo-confirm', { id: body.id })
  assert.equal(ok.status, 200, 'the pick of a running session is not refused: the user chose it')
  await a.queue.todoIdle()
  assert.equal(a.prompts.length, 1)
  assert.equal(a.prompts[0].sessionId, 'sb')
})

// ---- the hub ------------------------------------------------------------------------------------------------------

test('hub: GET /v1/follow-up-sessions is the union of every online app, no snippets asked for, the caller\'s own first', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100, { workspaceTitle: 'alpha' })]))
  autopilot(t, b, answers(b, [sess('sb1', 200)]))
  const res = await raw({ port, path: P + '/v1/follow-up-sessions', headers: { 'x-rq-instance': a.id } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.sessions.map((s) => [s.sessionId, s.owner]), [['sb1', b.id], ['sa1', a.id]])
  assert.equal(res.json.skippedApps, 0)
  assert.deepEqual(seenA.find((c) => c.kind === 'sessions-list').args, { snippets: false })
})

test('hub: a picked session id is decided on the titles alone (no snippet round) and a wrong method is 405', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  autopilot(t, b, answers(b, [sess('sb1', 200)]))
  const res = await raw({ port, method: 'POST', path: P + '/v1/follow-up-sessions', headers: { 'x-rq-instance': a.id, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(res.status, 405)
  const { act } = await import('./hub-follow-up-helpers.mjs')
  const added = await act(port, 'todo', { text: 'next', followUp: 'sb1' }, { 'x-rq-instance': a.id })
  assert.equal(added.status, 200)
  assert.deepEqual(seenA.filter((c) => c.kind === 'sessions-list').map((c) => c.args), [{ snippets: false }])
})
