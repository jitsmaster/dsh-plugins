import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notificationStatus } from '../lib/mobile/push-client.js'

// What the Settings tab says about notifications; found in a browser where a subscription outlived a revoked permission.
test('notificationStatus: a browser without push says so', () => {
  assert.equal(notificationStatus({ supported: false, permission: 'unsupported', subscribed: false }).state, 'unsupported')
})

test('notificationStatus: subscribed and allowed is on', () => {
  const s = notificationStatus({ supported: true, permission: 'granted', subscribed: true })
  assert.equal(s.state, 'on')
  assert.equal(s.text, 'On for this phone.')
})

test('notificationStatus: a subscription whose permission was revoked is blocked, not on', () => {
  const s = notificationStatus({ supported: true, permission: 'denied', subscribed: true })
  assert.equal(s.state, 'blocked')
  assert.match(s.text, /Blocked in the browser settings/)
  assert.match(s.text, /still registered/)
})

test('notificationStatus: not subscribed and denied is blocked; otherwise off with the privacy note', () => {
  assert.equal(notificationStatus({ supported: true, permission: 'denied', subscribed: false }).state, 'blocked')
  const off = notificationStatus({ supported: true, permission: 'default', subscribed: false })
  assert.equal(off.state, 'off')
  assert.match(off.text, /only the type and how many items wait/)
})
