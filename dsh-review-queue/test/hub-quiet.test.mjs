import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quietEndsAt } from '../hub/quiet.js'

const at = (iso) => Date.parse(iso)
const night = { enabled: true, start: '22:00', end: '07:00', tz: 'UTC' }

test('quiet hours off: never quiet', () => {
  assert.equal(quietEndsAt({ ...night, enabled: false }, at('2026-10-15T23:00:00Z')), undefined)
  assert.equal(quietEndsAt(undefined, at('2026-10-15T23:00:00Z')), undefined)
})

test('a window over midnight: quiet in the evening and in the early morning, with the time it ends', () => {
  assert.equal(quietEndsAt(night, at('2026-10-15T23:00:00Z')), at('2026-10-16T07:00:00Z'))
  assert.equal(quietEndsAt(night, at('2026-10-16T03:30:00Z')), at('2026-10-16T07:00:00Z'))
  assert.equal(quietEndsAt(night, at('2026-10-15T22:00:00Z')), at('2026-10-16T07:00:00Z'), 'the start is inside')
})

test('outside the window it is not quiet, and the end itself is outside', () => {
  assert.equal(quietEndsAt(night, at('2026-10-15T12:00:00Z')), undefined)
  assert.equal(quietEndsAt(night, at('2026-10-16T07:00:00Z')), undefined)
  assert.equal(quietEndsAt(night, at('2026-10-15T21:59:59Z')), undefined)
})

test('a window inside one day', () => {
  const lunch = { enabled: true, start: '12:00', end: '13:30', tz: 'UTC' }
  assert.equal(quietEndsAt(lunch, at('2026-10-15T12:10:00Z')), at('2026-10-15T13:30:00Z'))
  assert.equal(quietEndsAt(lunch, at('2026-10-15T13:30:00Z')), undefined)
})

test("the phone's own time zone decides: 22:30 in Berlin is 20:30 UTC", () => {
  const berlin = { ...night, tz: 'Europe/Berlin' }
  assert.equal(quietEndsAt(berlin, at('2026-10-15T20:30:00Z')), at('2026-10-16T05:00:00Z'))
  assert.equal(quietEndsAt(berlin, at('2026-10-15T19:30:00Z')), undefined, '21:30 in Berlin')
})

test('a time zone nobody knows means no quiet hours (a push is better than a lost one)', () => {
  assert.equal(quietEndsAt({ ...night, tz: 'Nowhere/Land' }, at('2026-10-15T23:00:00Z')), undefined)
  assert.equal(quietEndsAt({ ...night, tz: '' }, at('2026-10-15T23:00:00Z')), undefined)
})
