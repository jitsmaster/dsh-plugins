import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrowthTracker, effectiveLimit, handOffAhead } from '../forecast.js'

test('estimate: needs two finished turns, then the largest of the last three growths', () => {
  const g = createGrowthTracker()
  assert.equal(g.estimate('s'), undefined)
  g.turnStart('s', 100); g.turnEnd('s', 150)
  assert.equal(g.estimate('s'), undefined)
  g.turnStart('s', 150); g.turnEnd('s', 170)
  assert.equal(g.estimate('s'), 50)
  g.turnStart('s', 170); g.turnEnd('s', 180)
  g.turnStart('s', 180); g.turnEnd('s', 200)
  assert.equal(g.estimate('s'), 20) // 50 fell out of the window of three: 20, 10, 20
})

test('estimate: sessions are separate, a turn without a start is ignored, a shrinking context resets the history', () => {
  const g = createGrowthTracker()
  g.turnEnd('s', 500)
  g.turnStart('a', 0); g.turnEnd('a', 40)
  g.turnStart('a', 40); g.turnEnd('a', 90)
  assert.equal(g.estimate('a'), 50)
  assert.equal(g.estimate('b'), undefined)
  g.turnStart('a', 90); g.turnEnd('a', 10) // compaction or a new baseline
  assert.equal(g.estimate('a'), undefined)
})

test('effectiveLimit: the cap, lowered to the model window when that is smaller', () => {
  assert.equal(effectiveLimit(400_000, 1_000_000), 400_000)
  assert.equal(effectiveLimit(400_000, 200_000), 200_000)
  assert.equal(effectiveLimit(400_000, undefined), 400_000)
})

test('handOffAhead: the estimate must not fit in what is left, and the cap must not be passed yet', () => {
  assert.equal(handOffAhead({ tokens: 340_000, limit: 400_000, estimate: 60_000 }), true)
  assert.equal(handOffAhead({ tokens: 340_000, limit: 400_000, estimate: 59_999 }), false)
  assert.equal(handOffAhead({ tokens: 340_000, limit: 400_000, estimate: undefined }), false)
  assert.equal(handOffAhead({ tokens: 400_000, limit: 400_000, estimate: 10 }), false) // the normal cap handles it
})
