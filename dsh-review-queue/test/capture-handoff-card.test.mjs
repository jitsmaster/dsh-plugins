import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { installCapture } from '../capture.js'
import { createHandoffFollow, handoffFollowable } from '../handoff-follow.js'

// A handoff written in the middle of a session (the final reply does not mention it) still gets a done card with a Follow handoff action.
function setup(handoffOf) {
  const handlers = {}
  const ctx = { on: (name, fn) => { handlers[name] = fn }, get: () => undefined, logger: { warn() {}, info() {} } }
  let n = 0
  const store = createStore({ now: () => Date.now(), uuid: () => 'i' + ++n })
  installCapture(ctx, { store, summarizer: { summarize: async () => ({ text: 'Did it.', source: 'llm', actionable: true }) }, handoffOf })
  const agent = (reply) => ({ id: 'a1', session: { id: 'a1', header: { cwd: 'D:/p' }, deriveMessages: () => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: reply }] }] } })
  const done = (reply) => handlers['agent/turn-stopping']({ agent: agent(reply) })
  return { store, done }
}

test('a mid-session handoff note gets a followable card once, even when the reply does not mention it', async () => {
  const x = setup(() => 'D:/h/a-handoff.md')
  await x.done('Finished step one.')
  const open = x.store.list({ status: 'open' })
  const card = open.find((i) => handoffFollowable(i))
  assert.ok(card, 'a followable card exists')
  await x.done('Finished step two.')
  assert.equal(x.store.list({ status: 'open' }).filter((i) => handoffFollowable(i)).length, 1, 'not offered twice for the same note')
})

test('no note, no extra card', async () => {
  const x = setup(() => undefined)
  await x.done('Finished.')
  assert.equal(x.store.list({ status: 'open' }).filter((i) => handoffFollowable(i)).length, 0)
})

test('following a handoff closes every other followable card of that session', async () => {
  const store = createStore({ uuid: (() => { let n = 0; return () => 'z' + ++n })() })
  const reply = 'Handoff written to `D:/h/a-handoff.md`'
  const a = store.add({ type: 'completed', sessionId: 's1', payload: { reply } })
  const b = store.add({ type: 'completed', sessionId: 's1', payload: { reply } })
  const other = store.add({ type: 'completed', sessionId: 's2', payload: { reply } })
  const follow = createHandoffFollow({ serviceOf: () => ({ latest: () => 'p', followUp: async () => ({ status: 200, sessionId: 'n1' }) }), store })
  await follow.follow(a.id)
  assert.equal(store.get(a.id).status, 'resolved')
  assert.equal(store.get(b.id).status, 'resolved')
  assert.equal(store.get(other.id).status, 'open')
})