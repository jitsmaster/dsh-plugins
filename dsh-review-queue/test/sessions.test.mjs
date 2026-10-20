import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createSessionCounter, SESSIONS_TTL_MS, SESSIONS_INTEREST_MS, sessionsKey } from '../sessions.js'
import { stampOf, fullStampOf, parseSince, stampMatches } from '../server.js'

// "N working / M open": the sessions of this app, from the session controller (userpause.js uses the same list), cached for 2 s.
const item = (id, over = {}) => ({ sessionId: id, running: false, updatedAt: 1, blank: false, ...over })
function setup({ items = [item('a', { running: true }), item('b'), item('c')], archived = [], now0 = 10_000, over = {}, touched = true } = {}) {
  let t = now0
  const calls = []
  const state = { items, fail: false, hang: undefined }
  const controller = { list: async (req, signal) => { calls.push(signal instanceof AbortSignal); if (state.hang) await state.hang; if (state.fail) { const e = new Error('SECRET path C:\\x'); e.code = 'boom'; throw e } return { items: state.items } } }
  const registry = { archivedSessionIds: archived }
  const logs = []
  const counter = createSessionCounter({ controllerOf: () => state.controller === null ? undefined : controller, registryOf: () => registry, now: () => t, log: (l) => logs.push(l), ...over })
  if (touched) counter.touch() // somebody looks: the numbers are kept fresh
  return { counter, calls, state, registry, logs, advance: (ms) => { t += ms }, controller }
}
const settle = async (counter) => { await counter.refresh() }

test('the cache time is 2 s and somebody must have looked in the last 60 s', () => {
  assert.equal(SESSIONS_TTL_MS, 2000)
  assert.equal(SESSIONS_INTEREST_MS, 60_000)
})

test('nobody looks, nothing is asked: neither current() nor refresh() calls the controller until touch()', async () => {
  const { counter, calls } = setup({ touched: false })
  assert.equal(counter.current(), undefined)
  await counter.refresh()
  assert.equal(calls.length, 0)
  counter.touch()
  counter.current()
  await counter.refresh()
  assert.equal(calls.length, 1)
  assert.deepEqual(counter.current(), { working: 1, open: 3 })
})

test('the interest ends 60 s after the last touch and a new touch brings it back (the last numbers stay)', async () => {
  const { counter, calls, advance } = setup()
  await counter.refresh()
  const n = calls.length
  advance(59_000)
  await counter.refresh()
  assert.equal(calls.length, n + 1, 'still interested')
  advance(59_000)
  await counter.refresh()
  assert.equal(calls.length, n + 1, '59 s after the last look the touch is a minute old, so no call')
  assert.deepEqual(counter.current(), { working: 1, open: 3 }, 'the last numbers stay')
  counter.touch()
  await counter.refresh()
  assert.equal(calls.length, n + 2)
})

test('working counts the sessions with a turn running, open counts every top-level session', async () => {
  const { counter } = setup({ items: [item('a', { running: true }), item('b', { running: true }), item('c'), item('d')] })
  assert.equal(counter.current(), undefined, 'unknown until the first answer')
  await settle(counter)
  assert.deepEqual(counter.current(), { working: 2, open: 4 })
})

test('a blank session is not open, and a null or malformed entry is ignored instead of stalling the count', async () => {
  const items = [item('a', { running: true }), item('b', { blank: true }), null, undefined, 5, 'x', {}, item('c')]
  const { counter } = setup({ items })
  await settle(counter)
  assert.deepEqual(counter.current(), { working: 1, open: 2 }, 'a and c: the blank one and everything that is not a session entry are left out')
})

test('a session running its first turn is not blank in the Host list, so it counts', async () => {
  const { counter } = setup({ items: [item('a', { running: true, blank: false })] })
  await settle(counter)
  assert.deepEqual(counter.current(), { working: 1, open: 1 })
})

test('a list that is not an array gives unknown, not a crash', async () => {
  const { counter, state } = setup({ items: { not: 'a list' } })
  await settle(counter)
  assert.equal(counter.current(), undefined)
  void state
})

test('subagents and child sessions are not counted, archived sessions are not open', async () => {
  const items = [item('a', { running: true }), item('s1', { running: true, parentSessionId: 'a' }), item('s2', { running: true, origin: 'subagent' }), item('arch', { running: true }), item('b')]
  const { counter } = setup({ items, archived: ['arch'] })
  await settle(counter)
  assert.deepEqual(counter.current(), { working: 1, open: 2 })
})

test('no controller (or one without list) is unknown, not zero', async () => {
  const { counter, state } = setup()
  state.controller = null
  await settle(counter)
  assert.equal(counter.current(), undefined)
  const odd = createSessionCounter({ controllerOf: () => ({}), registryOf: () => undefined })
  await odd.refresh()
  assert.equal(odd.current(), undefined)
  const thrower = createSessionCounter({ controllerOf: () => { throw new Error('x') }, registryOf: () => undefined })
  await thrower.refresh()
  assert.equal(thrower.current(), undefined)
})

test('a registry that is missing or throws only means nothing is archived', async () => {
  const { counter } = setup({ over: { registryOf: () => { throw new Error('no registry') } } })
  await settle(counter)
  assert.deepEqual(counter.current(), { working: 1, open: 3 })
})

test('the answer is cached for 2 s: current() inside the time asks the controller once, after it asks again', async () => {
  const { counter, calls, advance } = setup()
  counter.current()
  await counter.refresh()
  const n = calls.length
  advance(1999)
  counter.current(); counter.current()
  await counter.refresh()
  assert.equal(calls.length, n, 'cached')
  advance(1)
  counter.current()
  await counter.refresh()
  assert.equal(calls.length, n + 1)
})

test('only one list call is in flight, and the call carries a signal', async () => {
  const { counter, calls, state } = setup()
  let release
  state.hang = new Promise((r) => { release = r })
  const a = counter.refresh()
  const b = counter.refresh()
  counter.current()
  release()
  await Promise.all([a, b])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls, [true])
})

test('a failing list keeps the last known numbers, logs only the code and never throws', async () => {
  const { counter, state, advance, logs } = setup()
  await settle(counter)
  state.fail = true
  advance(5000)
  await assert.doesNotReject(counter.refresh())
  assert.deepEqual(counter.current(), { working: 1, open: 3 })
  assert.ok(logs.some((l) => /boom/.test(l)))
  assert.ok(!logs.some((l) => /SECRET|C:/.test(l)), 'no message text in the log')
})

test('listeners are told only when a number changed', async () => {
  const { counter, state, advance } = setup()
  let n = 0
  counter.onChange(() => { n++ })
  await settle(counter)
  assert.equal(n, 1, 'unknown to known')
  advance(5000)
  await settle(counter)
  assert.equal(n, 1, 'same numbers, no event')
  state.items = [item('a'), item('b'), item('c')]
  advance(5000)
  await settle(counter)
  assert.equal(n, 2)
})

test('changes are rate limited: a second change inside 3 s is told later, by the next refresh after the window', async () => {
  const { counter, state, advance } = setup()
  let n = 0
  counter.onChange(() => { n++ })
  await settle(counter)
  assert.equal(n, 1)
  state.items = [item('a')]
  advance(2500)
  await settle(counter)
  assert.deepEqual(counter.current(), { working: 0, open: 1 }, 'the value is current at once')
  assert.equal(n, 1, 'but the event waits for the window')
  advance(2000)
  await settle(counter)
  assert.equal(n, 2)
})

test('a throwing listener does not stop the others', async () => {
  const { counter } = setup()
  let ok = 0
  counter.onChange(() => { throw new Error('x') })
  counter.onChange(() => { ok++ })
  await settle(counter)
  assert.equal(ok, 1)
})

// ---- in the service snapshot -----------------------------------------------------------------------------------------------------------

function service(counter) {
  const store = createStore({ now: () => 1 })
  return { store, queue: createReviewQueue({ store, capture: {}, controllerOf: () => undefined, sessions: counter, now: () => 5 }) }
}

test('the snapshot carries sessions: { working, open } once known, and nothing while unknown', async () => {
  const { counter } = setup()
  const { queue } = service(counter)
  assert.ok(!('sessions' in queue.snapshot()), 'unknown: no field, not zeros')
  await counter.refresh()
  assert.deepEqual(queue.snapshot().sessions, { working: 1, open: 3 })
})

test('a count change does not change the snapshotId (the store did not change)', async () => {
  const { counter, state, advance } = setup()
  const { queue } = service(counter)
  await counter.refresh()
  const id = queue.snapshot().snapshotId
  state.items = [item('a')]
  advance(5000)
  await counter.refresh()
  assert.equal(queue.snapshot().snapshotId, id)
  assert.deepEqual(queue.snapshot().sessions, { working: 0, open: 1 })
})

test('asking for a snapshot starts a refresh when the numbers are older than 2 s', async () => {
  const { counter, calls, advance } = setup()
  const { queue } = service(counter)
  queue.snapshot()
  await counter.refresh()
  const n = calls.length
  advance(2500)
  queue.snapshot()
  await counter.refresh()
  assert.equal(calls.length, n + 1)
})

test('a change of the numbers wakes the service listeners (the long poll), and sessionCounts gives the numbers to the agent', async () => {
  const { counter } = setup()
  const { queue } = service(counter)
  let n = 0
  queue.onChange(() => { n++ })
  await counter.refresh()
  assert.equal(n, 1)
  assert.deepEqual(queue.sessionCounts(), { working: 1, open: 3 })
  assert.equal(typeof queue.refreshSessions, 'function')
})

test('without a counter the service has no sessions and sessionCounts is undefined', () => {
  const { queue } = service(undefined)
  assert.ok(!('sessions' in queue.snapshot()))
  assert.equal(queue.sessionCounts(), undefined)
})

test('a snapshot with watch or tip touches the counter, a plain snapshot does not, watchSessions() does', async () => {
  const { counter, calls } = setup({ touched: false })
  const { queue } = service(counter)
  queue.snapshot()
  await counter.refresh()
  assert.equal(calls.length, 0)
  queue.snapshot({ watch: true })
  await counter.refresh()
  assert.equal(calls.length, 1)
  const other = setup({ touched: false })
  service(other.counter).queue.snapshot({ tip: true })
  await other.counter.refresh()
  assert.equal(other.calls.length, 1)
  const third = setup({ touched: false })
  service(third.counter).queue.watchSessions()
  await third.counter.refresh()
  assert.equal(third.calls.length, 1)
  assert.equal(typeof service(undefined).queue.watchSessions, 'function', 'harmless without a counter')
})

// ---- the long-poll stamp ----------------------------------------------------------------------------------------------------------------

test('the stamp has the four old parts first; the full stamp adds the sessions and the tip id', () => {
  const s = { snapshotId: 'e:3', focusId: 'f', reading: 'r', ui: { seq: 2 }, sessions: { working: 1, open: 4 }, tip: { id: 'tipX' } }
  assert.equal(stampOf(s), 'e:3|f|r|2')
  assert.equal(fullStampOf(s), 'e:3|f|r|2|1/4|tipX')
  assert.equal(fullStampOf({ snapshotId: 'e:3' }), 'e:3|||0||')
  assert.equal(sessionsKey(undefined), '')
  assert.equal(sessionsKey({ working: 0, open: 0 }), '0/0')
  assert.equal(sessionsKey({ working: 'x', open: 1 }), '')
})

test('parseSince keeps the extra parts a new client sends and pads the old four', () => {
  assert.equal(parseSince(undefined), undefined)
  assert.equal(parseSince('e:3'), 'e:3|||0')
  assert.equal(parseSince('e:3|f|r|2'), 'e:3|f|r|2')
  assert.equal(parseSince('e:3|f|r|2|1/4|tipX'), 'e:3|f|r|2|1/4|tipX')
  assert.equal(parseSince('e:3|f|r||1/4|'), 'e:3|f|r|0|1/4|')
})

test('stampMatches compares only the parts the client sent, so an older page never loops on full snapshots', () => {
  const s = { snapshotId: 'e:3', ui: { seq: 0 }, sessions: { working: 1, open: 4 }, tip: { id: 'tipX' } }
  assert.equal(stampMatches(s, parseSince('e:3|||0')), true, 'an old four-part token matches')
  assert.equal(stampMatches(s, parseSince('e:3|||0|1/4|tipX')), true)
  assert.equal(stampMatches(s, parseSince('e:3|||0|2/4|tipX')), false, 'the numbers moved')
  assert.equal(stampMatches(s, parseSince('e:3|||0|1/4|')), false, 'a tip appeared')
  assert.equal(stampMatches(s, parseSince('e:4|||0')), false)
  assert.equal(stampMatches({ snapshotId: 'e:3', ui: { seq: 0 } }, parseSince('e:3|||0|1/4|tipX')), false, 'the numbers and the tip went away')
})

test('over HTTP the phone and an open overlay look at the numbers; a plain request (overlay closed) does not', async (t) => {
  const { createServer } = await import('node:http')
  const { createRouter } = await import('../server.js')
  for (const [query, looked] of [['', false], ['?tip=1', true], ['?client=phone', true]]) {
    const { counter, calls } = setup({ touched: false })
    const { queue } = service(counter)
    const server = createServer(createRouter({ queue }))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
    await fetch('http://127.0.0.1:' + server.address().port + '/v1/snapshot' + query)
    await counter.refresh()
    assert.equal(calls.length > 0, looked, query)
  }
})

test('over HTTP a long poll with the stamp of the snapshot is answered unchanged, and after a change of the numbers with the new snapshot', async (t) => {
  const { createServer } = await import('node:http')
  const { createRouter } = await import('../server.js')
  const { counter, state, advance } = setup()
  const { queue } = service(counter)
  await counter.refresh()
  const server = createServer(createRouter({ queue }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const base = 'http://127.0.0.1:' + server.address().port
  const first = await (await fetch(base + '/v1/snapshot')).json()
  const since = encodeURIComponent(fullStampOf(first))
  assert.deepEqual(await (await fetch(base + '/v1/snapshot?wait=0&since=' + since)).json(), { unchanged: true, snapshotId: first.snapshotId })
  state.items = [item('a')]
  advance(5000)
  await counter.refresh()
  const next = await (await fetch(base + '/v1/snapshot?wait=0&since=' + since)).json()
  assert.deepEqual(next.sessions, { working: 0, open: 1 })
  const oldClient = await (await fetch(base + '/v1/snapshot?wait=0&since=' + encodeURIComponent(stampOf(first)))).json()
  assert.equal(oldClient.unchanged, true, 'an old client never learns of the numbers but never loops either')
})
