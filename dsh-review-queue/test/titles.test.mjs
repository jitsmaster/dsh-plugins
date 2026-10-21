import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTitleReader } from '../titles.js'

const ok = (title) => ({ status: 'fulfilled', value: { title: { title } } })

test('titles are read for the ids asked and a failed or untitled one is left out', async () => {
  const query = { readTitleSnapshots: async (ids) => ids.map((id) => (id === 'bad' ? { status: 'rejected', reason: new Error('x') } : id === 'none' ? { status: 'fulfilled', value: {} } : ok('T ' + id))) }
  const read = createTitleReader(() => query)
  assert.deepEqual([...(await read(['a', 'bad', 'none', 'b']))], [['a', 'T a'], ['b', 'T b']])
})

test('a title that was read is reused (only the ids not known are asked) until it is older than the ttl', async () => {
  const asked = []
  let t = 1000
  const query = { readTitleSnapshots: async (ids) => { asked.push([...ids]); return ids.map((id) => ok('T ' + id)) } }
  const read = createTitleReader(() => query, { now: () => t, ttlMs: 500 })
  await read(['a', 'b'])
  await read(['a', 'b', 'c'])
  assert.deepEqual(asked, [['a', 'b'], ['c']])
  t += 600
  await read(['a'])
  assert.deepEqual(asked.at(-1), ['a'], 'expired: read again')
})

test('a read the caller gave up on still fills the cache, so the next call is answered at once', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let calls = 0
  const query = { readTitleSnapshots: async (ids) => { calls++; await gate; return ids.map((id) => ok('T ' + id)) } }
  const read = createTitleReader(() => query)
  const first = read(['a']) // the caller (within(..., 3 s)) walks away from this
  release()
  await first
  assert.deepEqual([...(await read(['a']))], [['a', 'T a']])
  assert.equal(calls, 1)
})

test('no service, a service without the method or a throwing one gives an empty map, never an error', async () => {
  assert.equal((await createTitleReader(() => undefined)(['a'])).size, 0)
  assert.equal((await createTitleReader(() => ({}))(['a'])).size, 0)
  assert.equal((await createTitleReader(() => ({ readTitleSnapshots: async () => { throw new Error('boom') } }))(['a'])).size, 0)
  assert.equal((await createTitleReader(() => { throw new Error('no ctx') })(['a'])).size, 0)
})

test('the cache holds at most max titles, the oldest go first', async () => {
  const asked = []
  const query = { readTitleSnapshots: async (ids) => { asked.push([...ids]); return ids.map((id) => ok(id)) } }
  const read = createTitleReader(() => query, { max: 2 })
  await read(['a', 'b', 'c'])
  await read(['c', 'b'])
  await read(['a'])
  assert.deepEqual(asked, [['a', 'b', 'c'], ['a']])
})
