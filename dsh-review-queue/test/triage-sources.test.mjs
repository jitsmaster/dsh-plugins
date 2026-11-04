// Evidence for question triage: what the USER wrote earlier in the session, read from the session thread. Only user messages are ever
// quotable evidence; assistant text never is. Never throws: any problem means no sources (and so no admissible quote).
import test from 'node:test'
import assert from 'node:assert/strict'
import { userSourcesFromThread, sourcesForItem } from '../triage-sources.js'

const thread = (messages, hasMore = false) => ({ ok: true, messages, hasMore })
const MESSAGES = [
  { id: 1, role: 'user', text: 'first request' },
  { id: 2, role: 'assistant', text: 'assistant planted text' },
  { id: 3, role: 'user', text: 'second request' },
  { id: 4, role: 'assistant', text: 'more assistant text' },
  { id: 5, role: 'user', text: 'Please post both replies and resolve the threads.' },
]
const item = { id: 'q', type: 'question', sessionId: 'sess-1' }

test('userSourcesFromThread: only user messages, newest first, as user-authored sources with a user-<id> id', async () => {
  const seen = []
  const sourcesOf = userSourcesFromThread(async (opts) => { seen.push(opts); return thread(MESSAGES) }, { limit: 40 })
  const out = await sourcesOf(item)
  assert.deepEqual(out, [
    { id: 'user-5', text: 'Please post both replies and resolve the threads.', userAuthored: true },
    { id: 'user-3', text: 'second request', userAuthored: true },
    { id: 'user-1', text: 'first request', userAuthored: true },
  ])
  assert.equal(seen[0].sessionId, 'sess-1')
  assert.equal(seen[0].limit, 40)
})

test('userSourcesFromThread: at most 8 sources, the 8 newest', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, role: 'user', text: 'message ' + (i + 1) }))
  const out = await userSourcesFromThread(async () => thread(many))(item)
  assert.equal(out.length, 8)
  assert.deepEqual(out.map((s) => s.id), ['user-12', 'user-11', 'user-10', 'user-9', 'user-8', 'user-7', 'user-6', 'user-5'])
})

test('userSourcesFromThread: a synchronous threadOf works too', async () => {
  const out = await userSourcesFromThread(() => thread(MESSAGES))(item)
  assert.equal(out.length, 3)
})

test('userSourcesFromThread: no session id, no threadOf, a throwing or rejecting threadOf, or a failed read all give no sources', async () => {
  const ok = () => thread(MESSAGES)
  assert.deepEqual(await userSourcesFromThread(ok)({ id: 'q', type: 'question' }), [])
  assert.deepEqual(await userSourcesFromThread(undefined)(item), [])
  assert.deepEqual(await userSourcesFromThread(() => { throw new Error('boom') })(item), [])
  assert.deepEqual(await userSourcesFromThread(async () => { throw new Error('boom') })(item), [])
  assert.deepEqual(await userSourcesFromThread(async () => ({ ok: false, error: 'no-log' }))(item), [])
  assert.deepEqual(await userSourcesFromThread(async () => undefined)(item), [])
})

test('userSourcesFromThread: no threadOf call is made for an item without a session', async () => {
  let called = 0
  await userSourcesFromThread(() => { called++; return thread(MESSAGES) })({ id: 'q', type: 'question' })
  assert.equal(called, 0)
})

test('sourcesForItem: only question items touch the thread; other types get [] with zero reads', async () => {
  let calls = 0
  const threadOf = async () => { calls++; return thread(MESSAGES) }
  const sourcesOf = sourcesForItem(threadOf, { limit: 10 })
  for (const type of ['permission', 'completed', 'paused']) {
    assert.deepEqual(await sourcesOf({ id: 'x', type, sessionId: 'sess-1' }), [])
  }
  assert.equal(calls, 0)
  const out = await sourcesOf(item)
  assert.equal(calls, 1)
  assert.equal(out[0].id, 'user-5')
})