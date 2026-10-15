import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../hub/ratelimit.js'
import { fakeClock } from './hub-helpers.mjs'

test('the limit-th call in the window passes and the next one is refused with the time to wait', () => {
  const clock = fakeClock()
  const rl = createRateLimiter({ now: clock.now, limit: 3, windowMs: 60_000 })
  for (let i = 0; i < 3; i++) { assert.deepEqual(rl.take('k'), { ok: true }); clock.advance(1000) }
  const refused = rl.take('k')
  assert.equal(refused.ok, false)
  assert.equal(refused.retryAfterMs, 57_000, 'until the oldest call leaves the window')
})

test('calls leave the window one by one (a sliding window, not a fixed minute)', () => {
  const clock = fakeClock()
  const rl = createRateLimiter({ now: clock.now, limit: 2, windowMs: 10_000 })
  rl.take('k'); clock.advance(6000); rl.take('k')
  assert.equal(rl.take('k').ok, false)
  clock.advance(4000)
  assert.equal(rl.take('k').ok, true, 'the first call is 10 s old now')
  assert.equal(rl.take('k').ok, false)
})

test('keys are independent and a refused call does not count against the key', () => {
  const clock = fakeClock()
  const rl = createRateLimiter({ now: clock.now, limit: 1, windowMs: 1000 })
  assert.equal(rl.take('a').ok, true)
  assert.equal(rl.take('b').ok, true)
  for (let i = 0; i < 20; i++) rl.take('a')
  clock.advance(1000)
  assert.equal(rl.take('a').ok, true, 'refusals did not extend the wait')
})

test('the number of remembered keys is bounded: the oldest are forgotten', () => {
  const clock = fakeClock()
  const rl = createRateLimiter({ now: clock.now, limit: 1, windowMs: 60_000, maxKeys: 3 })
  for (const k of ['a', 'b', 'c', 'd']) { rl.take(k); clock.advance(1) }
  assert.equal(rl.size(), 3)
  assert.equal(rl.take('a').ok, true, 'a was forgotten')
  assert.equal(rl.take('d').ok, false, 'd is remembered')
})
