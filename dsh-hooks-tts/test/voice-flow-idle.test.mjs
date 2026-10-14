// The flow reports when a conversation ends (back to IDLE), so held alerts can be replayed at once instead of on the next 5 s tick.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceFlow } from '../voice/flow.js'

const make = (extra = {}) => createVoiceFlow({
  speak: async () => ({ status: 'done' }), listen: async () => ({ started: true }), decide: async () => ({ ok: false, error: 'llm' }),
  validate: () => ({ ok: false }), readBack: () => '', resultText: () => '', execute: async () => ({}), classify: () => ({}),
  uuid: () => 'id', ...extra,
})

test('FI1 abort() returns the flow to IDLE and reports it through onIdle', () => {
  let idles = 0
  const flow = make({ onIdle: () => { idles++ } })
  flow.abort('stop')
  assert.equal(flow.active(), false)
  assert.ok(idles >= 1, 'onIdle was called')
})

test('FI2 a throwing onIdle never breaks the flow', () => {
  const flow = make({ onIdle: () => { throw new Error('boom') } })
  assert.doesNotThrow(() => flow.abort('stop'))
  assert.equal(flow.active(), false)
})

const until = async (cond, what) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(cond(), 'timed out waiting for ' + what)
}

test('FI3 a conversation that ends reports onIdle exactly when the flow is no longer active', async () => {
  const seen = []
  const spoken = []
  let flow
  flow = make({
    speak: async (line) => { spoken.push(line); return { status: 'done' } },
    classify: () => 'yes',
    onIdle: () => seen.push(flow.active()),
    decide: async () => ({ ok: false, error: 'llm' }), // the decider is down: the flow says so and ends
  })
  flow.handle({ type: 'transcript', text: 'fix the parser', revision: 1, context: null })
  await until(() => flow.snapshot().state === 'ECHO_LISTEN', 'the echo listen')
  const { id, turn, step } = flow.snapshot()
  flow.handle({ type: 'transcript', text: 'yes', revision: 1, context: { flow: 'voice', id, turn, step } })
  await until(() => spoken.includes('The LLM is not available. Cancelled.'), 'the llm-error end line')
  await until(() => seen.length >= 1 || !flow.active(), 'the conversation to finish')
  // Asserted BEFORE any cleanup abort: abort() itself calls onIdle and would make these pass vacuously.
  assert.ok(seen.length >= 1, 'a conversation that finished on its own reported idle')
  assert.equal(flow.active(), false)
  assert.ok(seen.every((active) => active === false), 'onIdle only runs once the state is IDLE')
  flow.abort('test cleanup')
})
