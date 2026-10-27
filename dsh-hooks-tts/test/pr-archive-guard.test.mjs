import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrArchiveGuard } from '../pr-archive-guard.js'

function make({ prs = { a1: '5' }, status = 'active', ...extra } = {}) {
  const calls = { status: [] }
  const state = { status, error: undefined, now: 1_000_000 }
  const guard = createPrArchiveGuard({
    prIdOf: async (sessionId) => prs[sessionId],
    statusOf: async (prId) => { calls.status.push(prId); if (state.error) throw state.error; return state.status },
    now: () => state.now,
    ...extra,
  })
  return { guard, calls, state }
}

test('a session that is not a PR poll session is not protected, and no lookup is made', async () => {
  const { guard, calls } = make()
  assert.deepEqual(await guard.check('other'), { protected: false })
  assert.equal(calls.status.length, 0)
})

test('the poll session of an active PR is protected', async () => {
  const { guard } = make()
  assert.deepEqual(await guard.check('a1'), { protected: true, prId: '5', status: 'active' })
})

test('a PR that is over, or that does not exist, is not protected', async () => {
  for (const status of ['completed', 'abandoned', 'notFound']) {
    const { guard } = make({ status })
    assert.equal((await guard.check('a1')).protected, false, status)
  }
})

test('a failing or unreadable status lookup counts as still open', async () => {
  const failing = make()
  failing.state.error = new Error('network down')
  assert.deepEqual(await failing.guard.check('a1'), { protected: true, prId: '5', status: 'unknown' })
  const unreadable = make({ status: undefined })
  assert.equal((await unreadable.guard.check('a1')).protected, true)
})

test('a PR already recorded as finished is not protected without a lookup', async () => {
  const { guard, calls } = make({ finished: (prId) => prId === '5' })
  assert.equal((await guard.check('a1')).protected, false)
  assert.equal(calls.status.length, 0)
})

test('a failing session lookup is not a protected session', async () => {
  const guard = createPrArchiveGuard({ prIdOf: async () => { throw new Error('boom') }, statusOf: async () => 'active' })
  assert.equal((await guard.check('a1')).protected, false)
})

test('the status of a PR is cached for the ttl; a failure is never cached', async () => {
  const { guard, calls, state } = make({ ttlMs: 60_000 })
  await guard.check('a1')
  await guard.check('a1')
  assert.equal(calls.status.length, 1)
  state.now += 61_000
  state.status = 'completed'
  assert.equal((await guard.check('a1')).protected, false)
  assert.equal(calls.status.length, 2)
  const failing = make()
  failing.state.error = new Error('x')
  await failing.guard.check('a1')
  failing.state.error = undefined
  assert.equal((await failing.guard.check('a1')).status, 'active')
  assert.equal(failing.calls.status.length, 2)
})

test('a final status stays cached past the ttl', async () => {
  const { guard, calls, state } = make({ status: 'completed', ttlMs: 1000 })
  await guard.check('a1')
  state.now += 10_000
  await guard.check('a1')
  assert.equal(calls.status.length, 1)
})

test('concurrent checks of one PR share one lookup', async () => {
  const { guard, calls } = make()
  await Promise.all([guard.check('a1'), guard.check('a1'), guard.check('a1')])
  assert.equal(calls.status.length, 1)
})

test('switched off: nothing is protected', async () => {
  const { guard, calls } = make({ enabled: () => false })
  assert.deepEqual(await guard.check('a1'), { protected: false })
  assert.equal(calls.status.length, 0)
})

test('the status cache is bounded: the oldest entry is dropped, so its PR is looked up again', async () => {
  const prs = { s1: '1', s2: '2', s3: '3', s4: '4' }
  const { guard, calls } = make({ prs, status: 'completed', maxCached: 3 })
  for (const id of ['s1', 's2', 's3', 's4']) await guard.check(id)
  assert.deepEqual(calls.status, ['1', '2', '3', '4'])
  await guard.check('s4')
  await guard.check('s3')
  assert.equal(calls.status.length, 4, 'recent entries are still cached')
  await guard.check('s1')
  assert.deepEqual(calls.status.slice(4), ['1'], 'the oldest was evicted')
})
