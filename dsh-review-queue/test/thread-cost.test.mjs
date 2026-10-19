import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile as realReadFile, stat as realStat } from 'node:fs/promises'
import { zstdDecompressSync as zstd } from 'node:zlib'
import { MAX_FRAME_OUTPUT, MAX_TOTAL_OUTPUT, THREAD_THROTTLE_MS, createThreadCache, readThread } from '../thread.js'
import { log, tmpRoot, writeLog } from './paused-helpers.mjs'

// Review follow-up of the chat thread: a live session's log changes every few seconds, so the path + mtime + size cache misses on every 5 s poll
// and the whole log would be read and decoded again on the host's event loop. An identical request is therefore answered from memory for a
// few seconds, a decoded frame has a size cap, and a failure logs its error code and never its message (docs/mobile.md "Chat thread").
const frames = (n) => [[log.head(), ...Array.from({ length: n }, (_, k) => (k % 2 === 0 ? log.user('u' + k) : log.assistant('a' + k)))]]
/** Counts the file reads and the stat calls, and has a clock the test moves. */
function rig() {
  const seen = { reads: 0, stats: 0 }
  const clock = { t: 0 }
  return {
    seen, clock, cache: createThreadCache({ now: () => clock.t }),
    fs: { readFile: async (...a) => { seen.reads++; return realReadFile(...a) }, stat: async (...a) => { seen.stats++; return realStat(...a) } },
  }
}

// ---- the 3 s throttle -----------------------------------------------------------------------------------------------------------------

test('the throttle is 3 seconds', () => {
  assert.equal(THREAD_THROTTLE_MS, 3000)
})

test('an identical request within 3 s is answered from memory: no stat, no read, no parse', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(4))
  const r = rig()
  const first = await readThread({ root, sessionId: 's1', cache: r.cache, fs: r.fs })
  const after = { ...r.seen }
  r.clock.t = 2999
  const second = await readThread({ root, sessionId: 's1', cache: r.cache, fs: r.fs })
  assert.deepEqual(second, first)
  assert.deepEqual(r.seen, after, 'the disk was not touched again')
})

test('a log that changed is not served stale once 3 s have passed since the answer was computed', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2), { mtimeMs: 5_000_000 })
  const r = rig()
  const first = await readThread({ root, sessionId: 's1', cache: r.cache, fs: r.fs })
  writeLog(root, 's1', frames(4), { mtimeMs: 5_000_000 })
  r.clock.t = 2999
  assert.equal((await readThread({ root, sessionId: 's1', cache: r.cache, fs: r.fs })).messages.length, first.messages.length, 'still the remembered answer inside the window')
  r.clock.t = 3000
  assert.equal((await readThread({ root, sessionId: 's1', cache: r.cache, fs: r.fs })).messages.length, 4, 'a fresh answer after the window')
})

test('a served answer does not renew the window: it counts from the last computed answer', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2), { mtimeMs: 5_000_000 })
  const r = rig()
  await readThread({ root, sessionId: 's1', cache: r.cache, fs: r.fs })
  writeLog(root, 's1', frames(4), { mtimeMs: 5_000_000 })
  r.clock.t = 2000
  await readThread({ root, sessionId: 's1', cache: r.cache, fs: r.fs })
  r.clock.t = 3500
  assert.equal((await readThread({ root, sessionId: 's1', cache: r.cache, fs: r.fs })).messages.length, 4)
})

test('the throttle is per log file: any before and limit within 3 s is served from the remembered messages, with no stat, read or parse', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(60)) // message ids 1..60
  const r = rig()
  const newest = await readThread({ root, sessionId: 's1', limit: 2, cache: r.cache, fs: r.fs })
  assert.deepEqual(newest.messages.map((m) => m.id), [59, 60])
  const after = { ...r.seen }
  r.clock.t = 100
  const earlier = await readThread({ root, sessionId: 's1', limit: 2, before: newest.cursor, cache: r.cache, fs: r.fs })
  assert.deepEqual(earlier.messages.map((m) => m.id), [57, 58], 'the right page, computed from memory')
  assert.equal((await readThread({ root, sessionId: 's1', limit: 3, cache: r.cache, fs: r.fs })).messages.length, 3)
  for (let limit = 1; limit <= 50; limit++) await readThread({ root, sessionId: 's1', limit, cache: r.cache, fs: r.fs })
  for (let before = 1; before <= 60; before++) await readThread({ root, sessionId: 's1', before, cache: r.cache, fs: r.fs })
  assert.deepEqual(r.seen, after, 'varying limit or before never touched the disk again')
})

test('another session is not covered by the throttle of the first: it is computed', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(6))
  writeLog(root, 's2', frames(2))
  const r = rig()
  await readThread({ root, sessionId: 's1', cache: r.cache, fs: r.fs })
  const reads = r.seen.reads
  assert.equal((await readThread({ root, sessionId: 's2', cache: r.cache, fs: r.fs })).messages.length, 2)
  assert.equal(r.seen.reads, reads + 1)
})

test('the same session id under another sessions folder is another log file: not covered either', async (t) => {
  const a = tmpRoot(t)
  const b = tmpRoot(t)
  writeLog(a, 's1', frames(2))
  writeLog(b, 's1', frames(4))
  const r = rig()
  assert.equal((await readThread({ root: a, sessionId: 's1', cache: r.cache, fs: r.fs })).messages.length, 2)
  assert.equal((await readThread({ root: b, sessionId: 's1', cache: r.cache, fs: r.fs })).messages.length, 4)
})

test('a failure is not remembered: the next identical request tries again', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2))
  const r = rig()
  assert.deepEqual(await readThread({ root, sessionId: 's1', cache: r.cache, fs: { ...r.fs, readFile: async () => { throw new Error('EBUSY') } } }), { ok: false, error: 'unreadable' })
  r.clock.t = 10
  assert.equal((await readThread({ root, sessionId: 's1', cache: r.cache, fs: r.fs })).messages.length, 2)
})

test('the memory is per cache and holds a bounded number of logs', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2))
  const a = rig()
  const b = rig()
  await readThread({ root, sessionId: 's1', cache: a.cache, fs: a.fs })
  await readThread({ root, sessionId: 's1', cache: b.cache, fs: b.fs })
  assert.equal(b.seen.reads, 1, 'another cache does not see the answer of the first')
  const small = createThreadCache({ recentMax: 3, now: () => 0 })
  for (let i = 0; i < 5; i++) { writeLog(root, 'n' + i, frames(2)); await readThread({ root, sessionId: 'n' + i, cache: small }) }
  assert.equal(small.recentSize, 3)
  assert.ok(createThreadCache().recentSize === 0)
})

// ---- one read at a time per log file ---------------------------------------------------------------------------------------------------

test('concurrent requests for one log (any before and limit) share a single read and parse, and each gets its own page', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(10))
  const cache = createThreadCache({ throttleMs: 0 })
  const seen = { reads: 0, unzips: 0 }
  const fs = { readFile: async (...a) => { seen.reads++; return realReadFile(...a) } }
  const unzip = (b) => { seen.unzips++; return zstd(b) }
  const results = await Promise.all([1, 2, 3, 4, 5].map((limit) => readThread({ root, sessionId: 's1', limit, cache, fs, unzip })))
  assert.deepEqual(results.map((x) => x.messages.length), [1, 2, 3, 4, 5])
  assert.deepEqual([seen.reads, seen.unzips], [1, 1])
  assert.equal(cache.inflightSize, 0, 'the flight is removed when it ends')
})

test('a failed shared read is logged once, leaves nothing in flight, and the next call tries again', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2))
  const cache = createThreadCache({ throttleMs: 0 })
  const lines = []
  const broken = { readFile: async () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }) } }
  const all = await Promise.all([0, 1, 2].map(() => readThread({ root, sessionId: 's1', cache, fs: broken, log: (l) => lines.push(l) })))
  assert.deepEqual(all, [0, 1, 2].map(() => ({ ok: false, error: 'unreadable' })))
  assert.deepEqual(lines, ['thread: EBUSY'])
  assert.equal(cache.inflightSize, 0)
  assert.equal((await readThread({ root, sessionId: 's1', cache })).messages.length, 2)
})

test('requests for different logs do not wait for one another', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2))
  writeLog(root, 's2', frames(2))
  const cache = createThreadCache({ throttleMs: 0 })
  const seen = { reads: 0 }
  const fs = { readFile: async (...a) => { seen.reads++; return realReadFile(...a) } }
  await Promise.all([readThread({ root, sessionId: 's1', cache, fs }), readThread({ root, sessionId: 's2', cache, fs })])
  assert.equal(seen.reads, 2)
})

// ---- the size cap of a decoded frame ----------------------------------------------------------------------------------------------------

test('every frame is decoded with maxOutputLength 32 MiB', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', [...frames(2), [log.user('more')]])
  const options = []
  const r = await readThread({ root, sessionId: 's1', cache: createThreadCache(), unzip: (bytes, o) => { options.push(o); return zstd(bytes) } })
  assert.equal(r.ok, true)
  assert.equal(MAX_FRAME_OUTPUT, 32 * 1024 * 1024)
  assert.deepEqual(options, [{ maxOutputLength: MAX_FRAME_OUTPUT }, { maxOutputLength: MAX_FRAME_OUTPUT }])
})

test('a frame that decodes to more than the cap is too-large, and nothing is cached', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', [[log.head(), log.user('x'.repeat(5000))]])
  const cache = createThreadCache()
  assert.deepEqual(await readThread({ root, sessionId: 's1', cache, maxFrameBytes: 1000 }), { ok: false, error: 'too-large' })
  assert.equal(cache.size, 0)
  assert.equal((await readThread({ root, sessionId: 's1', cache, maxFrameBytes: 100_000 })).ok, true, 'the same log under a roomier cap')
})

test('a codec that reports ERR_BUFFER_TOO_LARGE is too-large, another failure of a frame is not', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2))
  const tooBig = () => { throw Object.assign(new RangeError('Cannot create a Buffer larger than the limit'), { code: 'ERR_BUFFER_TOO_LARGE' }) }
  assert.deepEqual(await readThread({ root, sessionId: 's1', cache: createThreadCache(), unzip: tooBig }), { ok: false, error: 'too-large' })
  const other = () => { throw new Error('bad frame') }
  assert.deepEqual(await readThread({ root, sessionId: 's1', cache: createThreadCache(), unzip: other }), { ok: true, messages: [], hasMore: false })
})

// ---- the total decoded size of one log ---------------------------------------------------------------------------------------------------

test('all frames of one log together may decode to 64 MiB', () => {
  assert.equal(MAX_TOTAL_OUTPUT, 64 * 1024 * 1024)
})

test('a log whose frames together decode to more than the total cap is too-large although every frame is within the frame cap; nothing is cached', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', [[log.head(), log.user('x'.repeat(1000))], [log.user('y'.repeat(1000))], [log.user('z'.repeat(1000))]])
  const cache = createThreadCache()
  assert.deepEqual(await readThread({ root, sessionId: 's1', cache, maxFrameBytes: 100_000, maxTotalBytes: 2500 }), { ok: false, error: 'too-large' })
  assert.equal(cache.size, 0)
  assert.equal((await readThread({ root, sessionId: 's1', cache, maxFrameBytes: 100_000, maxTotalBytes: 100_000 })).ok, true, 'the same log under a roomier total cap')
})

test('a frame is decoded with the room left under the total cap when that is smaller than the frame cap', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', [[log.head(), log.user('a'.repeat(500))], [log.user('b'.repeat(500))]])
  const options = []
  const sizes = []
  const r = await readThread({ root, sessionId: 's1', cache: createThreadCache(), maxFrameBytes: 100_000, maxTotalBytes: 5000, unzip: (bytes, o) => { options.push(o); const out = zstd(bytes); sizes.push(out.length); return out } })
  assert.equal(r.ok, true)
  assert.deepEqual(options, [{ maxOutputLength: 5000 }, { maxOutputLength: 5000 - sizes[0] }])
})

// ---- the log carries the error code only -----------------------------------------------------------------------------------------------

const SECRET = 'sk-live-SECRET-token-1234 in C:\\Users\\someone\\private.txt'

test('an unreadable log is logged by its error code only, never by its message', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2))
  const lines = []
  const fail = (error) => readThread({ root, sessionId: 's1', cache: createThreadCache(), log: (line) => lines.push(line), fs: { readFile: async () => { throw error } } })
  assert.deepEqual(await fail(Object.assign(new Error(SECRET), { code: 'EBUSY' })), { ok: false, error: 'unreadable' })
  assert.deepEqual(await fail(new TypeError(SECRET)), { ok: false, error: 'unreadable' })
  assert.deepEqual(lines, ['thread: EBUSY', 'thread: TypeError'])
  assert.equal(lines.join('\n').includes('SECRET'), false)
})

test('reading without a log function still answers unreadable', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2))
  assert.deepEqual(await readThread({ root, sessionId: 's1', cache: createThreadCache(), fs: { readFile: async () => { throw new Error(SECRET) } } }), { ok: false, error: 'unreadable' })
})
