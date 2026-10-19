import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installActionItemFormatting, ACTION_ITEM_GUIDANCE } from '../action-items.js'

function harness({ skipAll = false, skipIds = [] } = {}) {
  const handlers = {}
  const ctx = { on: (event, fn) => { handlers[event] = fn } }
  installActionItemFormatting(ctx, { skip: (agent) => skipAll || skipIds.includes(agent?.id), makeMessage: (text) => ({ text }) })
  const step = async (agent = { id: 'a' }, downstream = { kind: 'enter', messages: [] }) => handlers['agent/pre-step']({ agent }, async () => downstream)
  return { step }
}

test('the guidance asks for bold and underline, in its own paragraph, for action items directed at the user', () => {
  assert.match(ACTION_ITEM_GUIDANCE, /action item/i)
  assert.match(ACTION_ITEM_GUIDANCE, /<u>\*\*/)
  assert.match(ACTION_ITEM_GUIDANCE, /\*\*<\/u>/)
  assert.match(ACTION_ITEM_GUIDANCE, /own paragraph/i)
  assert.match(ACTION_ITEM_GUIDANCE, /confirmation|answer|clarification/i)
})

test('the first step of a session gets the guidance once', async () => {
  const h = harness()
  const first = await h.step()
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].text, ACTION_ITEM_GUIDANCE)
  assert.equal((await h.step()).messages.length, 0)
})

test('each session is guided once, independently', async () => {
  const h = harness()
  assert.equal((await h.step({ id: 'a' })).messages.length, 1)
  assert.equal((await h.step({ id: 'b' })).messages.length, 1)
  assert.equal((await h.step({ id: 'a' })).messages.length, 0)
})

test('skipped agents (subagents) are not guided, and a step that does not enter is left alone', async () => {
  const h = harness({ skipIds: ['sub'] })
  assert.equal((await h.step({ id: 'sub' })).messages.length, 0)
  const rejected = await h.step({ id: 'c' }, { kind: 'reject' })
  assert.deepEqual(rejected, { kind: 'reject' })
  // The rejected step did not use up the one-time guidance.
  assert.equal((await h.step({ id: 'c' })).messages.length, 1)
})
