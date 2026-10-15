// Pieces the adoption fallback relies on: capture remembers the sessions it has seen, a reply to a session this app cannot find says no-session
// (and leaves the item open), and the card has precise words for an item whose session is not available in this app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installCapture } from '../capture.js'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

const fakeAgent = (id) => ({ id, devTitle: 'T', session: { header: { cwd: 'D:/w' }, deriveMessages: () => [{ role: 'assistant', content: 'done' }] } })

test('capture remembers the sessions of the events it has seen and forgets one that is disposed', async () => {
  const store = createStore()
  const summarizer = { summarize: async () => ({ text: 's', source: 'test', title: 'T', actionable: true }) }
  const capture = installCapture({ on() {}, get: () => undefined }, { store, summarizer, log: () => {} })
  assert.deepEqual(capture.seenSessionIds(), [])
  await capture.handlers['agent/turn-stopping']({ agent: fakeAgent('s-one') })
  await capture.handlers['tools/pre-execute']({ name: 'shell', callId: 'c1', arguments: { command: 'ls' }, agent: fakeAgent('s-two') }, async () => ({}))
  assert.deepEqual(capture.seenSessionIds().sort(), ['s-one', 's-two'])
  await capture.handlers['agent/disposed']({ agent: fakeAgent('s-one') })
  assert.deepEqual(capture.seenSessionIds(), ['s-two'])
})

test('a reply to a session the controller cannot find answers no-session and leaves the item open', async () => {
  const store = createStore()
  const notFound = Object.assign(new Error('session "s1" not found'), { code: 'session/not-found' })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({ prompt: async () => { throw notFound } }) })
  const c = store.add({ type: 'completed', sessionId: 's1', payload: { reply: 'r' } })
  assert.deepEqual(await queue.reply(c.id, 'hi'), { ok: false, error: 'no-session' })
  assert.equal(store.get(c.id).status, 'open')
})
