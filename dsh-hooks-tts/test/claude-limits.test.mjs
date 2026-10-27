// Claude plan limits come from the reading the claude-code LLM provider saves, not from api.anthropic.com.
import assert from 'node:assert/strict'
import test from 'node:test'
import { limitsFromReading } from '../claude-limits.js'

const NOW = Date.parse('2026-10-27T12:00:00Z')
const inHours = h => Math.floor((NOW + h * 3_600_000) / 1000)

test('maps both windows to the widget shape', () => {
  const limits = limitsFromReading({
    updatedAt: '2026-10-27T11:59:00Z',
    fiveHour: { utilization: 0.02, resetsAt: inHours(3) },
    sevenDay: { utilization: 0.534, resetsAt: inHours(30) },
  }, NOW)
  assert.deepEqual(limits.map(l => [l.kind, l.label, l.percent]), [
    ['session', 'Current session', 2],
    ['weekly_all', 'Current week (all models)', 53],
  ])
  assert.equal(limits[0].resetsAt, new Date(inHours(3) * 1000).toISOString())
})

test('a window whose reset passed is shown at 0% without a reset time', () => {
  const [limit] = limitsFromReading({ fiveHour: { utilization: 0.9, resetsAt: inHours(-1) } }, NOW)
  assert.equal(limit.percent, 0)
  assert.equal(limit.resetsAt, undefined)
})

test('marks a window at 90% or more as high and clamps above 100%', () => {
  const [limit] = limitsFromReading({ sevenDay: { utilization: 1.4, resetsAt: inHours(5) } }, NOW)
  assert.equal(limit.percent, 100)
  assert.equal(limit.severity, 'high')
})

test('ignores malformed input', () => {
  assert.deepEqual(limitsFromReading(undefined, NOW), [])
  assert.deepEqual(limitsFromReading('x', NOW), [])
  assert.deepEqual(limitsFromReading({ fiveHour: { utilization: 'a', resetsAt: 1 }, sevenDay: { utilization: 0.1 } }, NOW), [])
})
