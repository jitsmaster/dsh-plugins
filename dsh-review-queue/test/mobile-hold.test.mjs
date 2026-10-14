import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOLD_MS, holdState } from '../lib/mobile/hold.js'

test('the hold takes 1.5 s by default', () => {
  assert.equal(HOLD_MS, 1500)
})

test('progress grows linearly with the time held', () => {
  assert.deepEqual(holdState(1000, 1000), { progress: 0, done: false })
  assert.deepEqual(holdState(1000, 1750), { progress: 0.5, done: false })
})

test('the hold is done exactly when the full time has passed, and progress stops at 1', () => {
  assert.equal(holdState(0, HOLD_MS - 1).done, false)
  assert.deepEqual(holdState(0, HOLD_MS), { progress: 1, done: true })
  assert.deepEqual(holdState(0, HOLD_MS * 10), { progress: 1, done: true })
})

test('a clock that went backwards never gives negative progress', () => {
  assert.deepEqual(holdState(5000, 4000), { progress: 0, done: false })
})

test('a custom duration is honoured', () => {
  assert.deepEqual(holdState(0, 250, 500), { progress: 0.5, done: false })
  assert.equal(holdState(0, 500, 500).done, true)
})
