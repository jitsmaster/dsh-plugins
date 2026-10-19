import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile as realReadFile, utimes } from 'node:fs/promises'
import { createThreadCache, DEFAULT_THREAD_LOG_BYTES, readThread } from '../thread.js'
import { createReviewQueue } from '../service.js'
import { createStore } from '../store.js'
import { zstdDecompressSync as zstd } from 'node:zlib'
import { log, tmpRoot, writeLog } from './paused-helpers.mjs'

// These tests are about the cache of parsed logs, so they switch the 3 s answer memory off (throttleMs: 0); thread-cost.test.mjs covers that.
// Follow-up of the chat thread slice: the phone refreshes the thread every 5 s, so an unchanged log must not be read and parsed again,
// the log cap of the thread is lower than the paused-session scan's, and no message text is ever logged (docs/mobile.md "Chat thread").
const frames = (n) => [[log.head(), ...Array.from({ length: n }, (_, k) => (k % 2 === 0 ? log.user('u' + k) : log.assistant('a' + k)))]]
/** A reader that counts the file reads and the decompressions. */
function counting() {
  const seen = { reads: 0, unzips: 0 }
  return { seen, fs: { readFile: async (...a) => { seen.reads++; return realReadFile(...a) } }, unzip: (b) => { seen.unzips++; return zstd(b) } }
}

// ---- the cache of parsed logs ------------------------------------------------------------------------------------------------------

test('an unchanged log is read and parsed once: the next poll is answered from the cache', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(4))
  const cache = createThreadCache({ throttleMs: 0 })
  const c = counting()
  const first = await readThread({ root, sessionId: 's1', cache, ...c })
  const second = await readThread({ root, sessionId: 's1', cache, ...c })
  assert.deepEqual(second, first)
  assert.deepEqual([c.seen.reads, c.seen.unzips], [1, 1])
  assert.deepEqual([cache.hits, cache.misses], [1, 1])
})

test('other pages of the same log (before, limit) also come from the cache', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(10))
  const cache = createThreadCache({ throttleMs: 0 })
  const c = counting()
  const last = await readThread({ root, sessionId: 's1', limit: 3, cache, ...c })
  const earlier = await readThread({ root, sessionId: 's1', limit: 3, before: last.cursor, cache, ...c })
  assert.deepEqual(earlier.messages.map((m) => m.text), ['u4', 'a5', 'u6'])
  assert.equal(c.seen.reads, 1)
})

test('a log that grew (new size) is read again and the new messages show up', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2), { mtimeMs: 5_000_000 })
  const cache = createThreadCache({ throttleMs: 0 })
  const c = counting()
  const before = await readThread({ root, sessionId: 's1', cache, ...c })
  writeLog(root, 's1', frames(4), { mtimeMs: 5_000_000 }) // same mtime, bigger file
  const after = await readThread({ root, sessionId: 's1', cache, ...c })
  assert.deepEqual([before.messages.length, after.messages.length], [2, 4])
  assert.equal(c.seen.reads, 2)
})

test('a log rewritten with the same size but a newer mtime is read again', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', frames(2), { mtimeMs: 5_000_000 })
  const cache = createThreadCache({ throttleMs: 0 })
  const c = counting()
  await readThread({ root, sessionId: 's1', cache, ...c })
  await utimes(file, 6_000, 6_000)
  await readThread({ root, sessionId: 's1', cache, ...c })
  assert.equal(c.seen.reads, 2)
})

test('the cache keeps at most 8 logs by default and drops the least recently used', async (t) => {
  const root = tmpRoot(t)
  for (let i = 0; i < 9; i++) writeLog(root, 's' + i, frames(2))
  const cache = createThreadCache({ throttleMs: 0 })
  assert.equal(cache.max, 8)
  for (let i = 0; i < 8; i++) await readThread({ root, sessionId: 's' + i, cache })
  assert.equal(cache.size, 8)
  await readThread({ root, sessionId: 's0', cache }) // s0 is used again: s1 is now the oldest
  await readThread({ root, sessionId: 's8', cache })
  assert.equal(cache.size, 8)
  const c = counting()
  await readThread({ root, sessionId: 's0', cache, ...c })
  assert.equal(c.seen.reads, 0, 's0 stayed')
  await readThread({ root, sessionId: 's1', cache, ...c })
  assert.equal(c.seen.reads, 1, 's1 was dropped')
})

test('the size of the cache can be set (max)', async (t) => {
  const root = tmpRoot(t)
  for (let i = 0; i < 3; i++) writeLog(root, 's' + i, frames(2))
  const cache = createThreadCache({ max: 2, throttleMs: 0 })
  for (let i = 0; i < 3; i++) await readThread({ root, sessionId: 's' + i, cache })
  assert.equal(cache.size, 2)
})

test('failures are not cached: a log that cannot be read is tried again', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2))
  const cache = createThreadCache({ throttleMs: 0 })
  assert.deepEqual(await readThread({ root, sessionId: 's1', cache, fs: { readFile: async () => { throw new Error('EBUSY') } } }), { ok: false, error: 'unreadable' })
  assert.equal(cache.size, 0)
  assert.equal((await readThread({ root, sessionId: 's1', cache })).messages.length, 2)
})

test('without a cache option the module-wide cache is used', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 'shared-1', frames(2))
  const c = counting()
  await readThread({ root, sessionId: 'shared-1', ...c })
  await readThread({ root, sessionId: 'shared-1', ...c })
  assert.equal(c.seen.reads, 1)
})

// ---- the lower cap --------------------------------------------------------------------------------------------------------------

test('the thread reads logs up to 8 MiB; larger ones are too-large', async () => {
  assert.equal(DEFAULT_THREAD_LOG_BYTES, 8 * 1024 * 1024)
  const base = { readdir: async () => [{ name: 'p', isDirectory: () => true }], readFile: async () => Buffer.alloc(0) }
  const big = { ...base, stat: async () => ({ mtimeMs: 1, size: 8 * 1024 * 1024 + 1 }) }
  assert.deepEqual(await readThread({ root: '/r', sessionId: 's', fs: big, cache: createThreadCache({ throttleMs: 0 }) }), { ok: false, error: 'too-large' })
  const edge = { ...base, stat: async () => ({ mtimeMs: 1, size: 8 * 1024 * 1024 }) }
  assert.equal((await readThread({ root: '/r', sessionId: 's', fs: edge, cache: createThreadCache({ throttleMs: 0 }) })).ok, true)
})

test('maxLogBytes still overrides the cap', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2))
  assert.deepEqual(await readThread({ root, sessionId: 's1', maxLogBytes: 10, cache: createThreadCache({ throttleMs: 0 }) }), { ok: false, error: 'too-large' })
})

// ---- no message text in any log --------------------------------------------------------------------------------------------------

test('reading and posting never write message text anywhere: not to the console, not to the logger', async (t) => {
  const root = tmpRoot(t)
  const secret = 'TOP-SECRET-MESSAGE-TEXT'
  writeLog(root, 's1', [[log.head(), log.user(secret), log.assistant('reply ' + secret)]])
  const lines = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, m, (...a) => { lines.push(a.join(' ')) })
  const store = createStore()
  const { id } = store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'T', summary: 'done', payload: { reply: 'r', questions: [] } })
  const logger = (...a) => { lines.push(a.join(' ')) }
  const queue = createReviewQueue({
    store, capture: {}, speaker: undefined, log: logger,
    controllerOf: () => ({ prompt: async () => ({}) }),
    threadOf: (opts) => readThread({ root, cache: createThreadCache({ throttleMs: 0 }), ...opts }),
  })
  const read = await queue.thread(id)
  assert.equal(read.ok, true)
  assert.deepEqual(await queue.post(id, secret), { ok: true })
  await queue.thread(id, { before: 1, limit: 5 })
  assert.deepEqual(lines.filter((l) => l.includes(secret)), [])
})

// The only thing logged is the error code of a failed read (thread-cost.test.mjs, thread-service.test.mjs): nothing of a message ever is.
test('thread.js and the thread / post code of service.js have no console call, and log nothing but a "thread: <code>" line', () => {
  const thread = readFileSync(new URL('../thread.js', import.meta.url), 'utf8')
  assert.doesNotMatch(thread, /console\./)
  for (const call of thread.match(/\blog\??\.?\([^\n]*/g) ?? []) assert.match(call, /^log\?\.\('thread: ' \+ /, call)
  const service = readFileSync(new URL('../service.js', import.meta.url), 'utf8')
  const start = service.indexOf('async thread(id')
  const end = service.indexOf('getFocus:', start)
  assert.ok(start > 0 && end > start)
  assert.doesNotMatch(service.slice(start, end), /console\./)
  for (const call of service.slice(start, end).match(/\blog\??\.?\([^\n]*/g) ?? []) assert.match(call, /^log\?\.\('thread: ' \+ /, call)
})
