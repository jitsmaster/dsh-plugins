import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installAskUserTuning } from '../ask.js'

function harness({ skipAll = false } = {}) {
  const handlers = {}
  const ctx = { on: (event, fn) => { handlers[event] = fn } }
  installAskUserTuning(ctx, { skip: () => skipAll, makeMessage: (text) => ({ text }) })
  const agent = { id: 'a' }
  const pending = { content: [{ type: 'text', text: '{"pending":true,"callId":"c1","message":"No answer batch arrived before the timeout."}' }] }
  const answered = { content: [{ type: 'text', text: '{"answers":[{"id":"x","selected":["A"]}]}' }] }
  const post = (name, result) => handlers['tools/post-execute']({ name, agent }, result, async () => ({ kind: 'accept' }))
  const step = async () => (await handlers['agent/pre-step']({ agent }, async () => ({ kind: 'enter', messages: [] })))
  return { post, step }
}

test('a pending ask_user_question result adds the combine-and-continue instruction', async () => {
  const h = harness()
  const out = await h.post('ask_user_question', { content: [{ type: 'text', text: '{"pending":true,"callId":"c1"}' }] })
  assert.equal(out.kind, 'accept')
  const text = out.additionalContexts[0].text
  assert.match(text, /already confirmed/i)
  assert.match(text, /recommended/i)
  assert.match(text, /continue/i)
})

test('answered, other tools, and skipped agents are untouched', async () => {
  const h = harness()
  const answered = await h.post('ask_user_question', { content: [{ type: 'text', text: '{"answers":[]}' }] })
  assert.equal(answered.additionalContexts, undefined)
  const other = await h.post('read', { content: [{ type: 'text', text: '{"pending":true}' }] })
  assert.equal(other.additionalContexts, undefined)
  const s = harness({ skipAll: true })
  assert.equal((await s.post('ask_user_question', { content: [{ type: 'text', text: '{"pending":true}' }] })).additionalContexts, undefined)
})

test('the first step of a session gets the timeout guidance once', async () => {
  const h = harness()
  const first = await h.step()
  assert.match(first.messages[0].text, /timeout/)
  assert.match(first.messages[0].text, /120/)
  assert.equal((await h.step()).messages.length, 0)
})
