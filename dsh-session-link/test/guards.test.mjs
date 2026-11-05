import test from 'node:test'
import assert from 'node:assert/strict'
import { createGuards } from '../guards.js'

const LIMITS = { perMinute: 5, windowMs: 60_000 }
const make = () => { const clock = { t: 1_000_000 }; return { clock, g: createGuards({ now: () => clock.t, limits: LIMITS }) } }

test('reserveMinute hands out slots up to the per-minute limit, then null', () => {
  const { g } = make()
  for (let i = 0; i < 5; i++) assert.equal(typeof g.reserveMinute('a'), 'number')
  assert.equal(g.reserveMinute('a'), null)
})

test('the minute window slides with now', () => {
  const { g, clock } = make()
  for (let i = 0; i < 5; i++) g.reserveMinute('a')
  clock.t += 59_999
  assert.equal(g.reserveMinute('a'), null)
  clock.t += 1
  assert.equal(typeof g.reserveMinute('a'), 'number')
})

test('releaseMinute frees a slot', () => {
  const { g, clock } = make()
  const slots = []
  for (let i = 0; i < 5; i++) { slots.push(g.reserveMinute('a')); clock.t += 1 }
  assert.equal(g.reserveMinute('a'), null)
  g.releaseMinute('a', slots[2])
  assert.equal(typeof g.reserveMinute('a'), 'number')
  assert.equal(g.reserveMinute('a'), null)
})

test('releaseMinute of an unknown slot or sender changes nothing', () => {
  const { g } = make()
  g.releaseMinute('nobody', 5)
  const s = g.reserveMinute('a')
  g.releaseMinute('a', s + 1)
  for (let i = 0; i < 4; i++) g.reserveMinute('a')
  assert.equal(g.reserveMinute('a'), null)
})

test('reserveFlight refuses a key already in flight until endFlight', () => {
  const { g } = make()
  assert.equal(g.reserveFlight('k', 'a'), true)
  assert.equal(g.reserveFlight('k', 'a'), false)
  assert.equal(g.reserveFlight('k', 'b'), false)
  g.endFlight('k')
  assert.equal(g.reserveFlight('k', 'a'), true)
})

test('flightsOf counts only that sender flights', () => {
  const { g } = make()
  g.reserveFlight('k1', 'a'); g.reserveFlight('k2', 'a'); g.reserveFlight('k3', 'b')
  assert.equal(g.flightsOf('a'), 2)
  assert.equal(g.flightsOf('b'), 1)
  assert.equal(g.flightsOf('c'), 0)
  g.endFlight('k1')
  assert.equal(g.flightsOf('a'), 1)
})

test('hourly counts marks in the last 60 minutes and slides', () => {
  const { g, clock } = make()
  assert.equal(g.hourly('a'), 0)
  g.markHour('a', clock.t)
  clock.t += 30 * 60_000
  g.markHour('a', clock.t)
  assert.equal(g.hourly('a'), 2)
  clock.t += 30 * 60_000 - 1
  assert.equal(g.hourly('a'), 2)
  clock.t += 1
  assert.equal(g.hourly('a'), 1)
  clock.t += 30 * 60_000
  assert.equal(g.hourly('a'), 0)
})

test('releaseHour removes one mark', () => {
  const { g, clock } = make()
  g.markHour('a', clock.t); g.markHour('a', clock.t + 1)
  g.releaseHour('a', clock.t)
  assert.equal(g.hourly('a'), 1)
  g.releaseHour('a', 12345)
  assert.equal(g.hourly('a'), 1)
})

test('state is independent per sender', () => {
  const { g, clock } = make()
  for (let i = 0; i < 5; i++) g.reserveMinute('a')
  g.markHour('a', clock.t)
  assert.equal(g.reserveMinute('a'), null)
  assert.equal(typeof g.reserveMinute('b'), 'number')
  assert.equal(g.hourly('b'), 0)
})

test('expired marks are pruned when read', () => {
  const { g, clock } = make()
  g.markHour('a', clock.t)
  g.reserveMinute('a')
  clock.t += 3_600_001
  assert.equal(g.hourly('a'), 0)
  assert.equal(typeof g.reserveMinute('a'), 'number')
})

test('pendingCards lists kept card ids for 30 s, then drops them', () => {
  const { g, clock } = make()
  g.keepCard('a', 'c1')
  clock.t += 10_000
  g.keepCard('a', 'c2')
  assert.deepEqual(g.pendingCards('a', new Set()).sort(), ['c1', 'c2'])
  clock.t += 19_999
  assert.deepEqual(g.pendingCards('a', new Set()).sort(), ['c1', 'c2'])
  clock.t += 1
  assert.deepEqual(g.pendingCards('a', new Set()), ['c2'])
  clock.t += 10_000
  assert.deepEqual(g.pendingCards('a', new Set()), [])
})

test('pendingCards drops ids the mirror already shows, permanently', () => {
  const { g } = make()
  g.keepCard('a', 'c1'); g.keepCard('a', 'c2')
  assert.deepEqual(g.pendingCards('a', new Set(['c1'])), ['c2'])
  assert.deepEqual(g.pendingCards('a', new Set()), ['c2'])
})

test('kept cards are independent per sender', () => {
  const { g } = make()
  g.keepCard('a', 'c1')
  assert.deepEqual(g.pendingCards('b', new Set()), [])
  assert.deepEqual(g.pendingCards('a', new Set()), ['c1'])
})

test('senders that never return are swept once a map grows past 256, live ones are kept', () => {
  const { g, clock } = make()
  for (let i = 0; i < 300; i++) { g.reserveMinute('m' + i); g.markHour('h' + i, clock.t); g.keepCard('k' + i, 'c'); g.reserveArchive('a' + i) }
  g.reserveMinute('m-extra')
  assert.deepEqual(g.sizes(), { minutes: 301, hours: 300, kept: 300, flights: 0, archives: 300 }, 'nothing is stale yet')
  clock.t += 3_600_001
  g.reserveMinute('x'); g.markHour('y', clock.t); g.keepCard('z', 'c'); g.reserveArchive('w')
  assert.deepEqual(g.sizes(), { minutes: 1, hours: 1, kept: 1, flights: 0, archives: 1 })
})

test('reserveArchive gives one slot per session per minute; a repeat is null until the window passes', () => {
  const { g, clock } = make()
  assert.equal(typeof g.reserveArchive('s'), 'number')
  assert.equal(g.reserveArchive('s'), null)
  clock.t += 59_999
  assert.equal(g.reserveArchive('s'), null)
  clock.t += 1
  assert.equal(typeof g.reserveArchive('s'), 'number')
})

test('releaseArchive frees the slot; ids are independent; an unknown slot changes nothing', () => {
  const { g } = make()
  const slot = g.reserveArchive('s')
  assert.equal(typeof g.reserveArchive('other'), 'number')
  g.releaseArchive('s', slot + 1)
  assert.equal(g.reserveArchive('s'), null)
  g.releaseArchive('s', slot)
  assert.equal(typeof g.reserveArchive('s'), 'number')
  g.releaseArchive('nobody', 1)
})

test('limits.archiveMs sets the archive window', () => {
  const clock = { t: 1_000_000 }
  const g = createGuards({ now: () => clock.t, limits: { ...LIMITS, archiveMs: 10_000 } })
  assert.equal(typeof g.reserveArchive('s'), 'number')
  clock.t += 10_000
  assert.equal(typeof g.reserveArchive('s'), 'number')
})

test('the sweep leaves a sender whose newest entry is still inside its window', () => {
  const { g, clock } = make()
  for (let i = 0; i < 300; i++) g.reserveMinute('m' + i)
  clock.t += 30_000
  g.reserveMinute('recent')
  clock.t += 30_000
  g.reserveMinute('probe')
  assert.equal(g.sizes().minutes, 2, 'only recent (30s old) and probe remain')
})