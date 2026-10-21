import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listFollowUpSessions } from '../follow-up.js'

// The session list of the host can be slow or fail while the host is busy (the dropdown then said "No session is listed yet"): the last good list is given instead, for a while.

const item = (sessionId, updatedAt) => ({ sessionId, updatedAt, running: false, blank: false })
const okController = (items) => ({ list: async () => ({ items }) })
const failing = (error = new Error('timed out')) => ({ list: async () => { throw error } })

test('a failed list gives the last good one, and the log says so', async () => {
  const memory = {}
  const logs = []
  let t = 1000
  const deps = { memory, now: () => t, log: (l) => logs.push(l) }
  const first = await listFollowUpSessions({ controller: okController([item('a', 2), item('b', 1)]), ...deps })
  assert.deepEqual(first.map((s) => s.sessionId), ['a', 'b'])
  t += 60_000
  const second = await listFollowUpSessions({ controller: failing(), ...deps })
  assert.deepEqual(second.map((s) => s.sessionId), ['a', 'b'])
  assert.match(logs.join('\n'), /follow-up: session list failed: Error; the list of 60 s ago is given/)
})

test('a list that is older than the stale ttl is not given, and without a memory a failed list is empty', async () => {
  const memory = {}
  let t = 0
  await listFollowUpSessions({ controller: okController([item('a', 1)]), memory, now: () => t, staleMs: 1000 })
  t += 1500
  assert.deepEqual(await listFollowUpSessions({ controller: failing(), memory, now: () => t, staleMs: 1000 }), [])
  assert.deepEqual(await listFollowUpSessions({ controller: failing() }), [])
})

test('a list that answered empty is the truth: it replaces the memory, nothing stale is given', async () => {
  const memory = {}
  await listFollowUpSessions({ controller: okController([item('a', 1)]), memory })
  assert.deepEqual(await listFollowUpSessions({ controller: okController([]), memory }), [])
  assert.deepEqual(await listFollowUpSessions({ controller: failing(), memory }), [])
})

test('the stale list is a copy: changing what was given does not change the memory', async () => {
  const memory = {}
  await listFollowUpSessions({ controller: okController([item('a', 1)]), memory })
  const stale = await listFollowUpSessions({ controller: failing(), memory })
  stale[0].title = 'changed'
  stale.push({ sessionId: 'x' })
  const again = await listFollowUpSessions({ controller: failing(), memory })
  assert.deepEqual(again.map((s) => [s.sessionId, s.title]), [['a', 'Untitled session']])
})
