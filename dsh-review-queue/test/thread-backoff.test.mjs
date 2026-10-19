import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile as realReadFile, stat as realStat } from 'node:fs/promises'
import { createThreadCache, readThread } from '../thread.js'
import { log, tmpRoot, writeLog } from './paused-helpers.mjs'

// The back-off of the thread read is proportional to its cost: after a log was read, any request for it is answered from memory for
// max(3 s, 5 x the time that read took), at most 30 s. A big log that takes a second to decode is not decoded again every 5 s.
const frames = (n) => [[log.head(), ...Array.from({ length: n }, (_, k) => (k % 2 === 0 ? log.user('u' + k) : log.assistant('a' + k)))]]
/** A clock the test moves; reading a file takes r.cost milliseconds of it. Counts the stat calls and the reads. */
function rig() {
  const r = { seen: { reads: 0, stats: 0 }, clock: { t: 0 }, cost: 0 }
  r.cache = createThreadCache({ now: () => r.clock.t })
  r.fs = {
    readFile: async (...a) => { r.seen.reads++; const bytes = await realReadFile(...a); r.clock.t += r.cost; return bytes },
    stat: async (...a) => { r.seen.stats++; return realStat(...a) },
  }
  r.read = (root, over = {}) => readThread({ root, sessionId: 's1', cache: r.cache, fs: r.fs, ...over })
  return r
}

test('a read that took 2 s keeps the log in memory for 10 s (5 x its duration), a quick one for 3 s', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2), { mtimeMs: 5_000_000 })
  const r = rig()
  r.cost = 2000
  await r.read(root) // done at t = 2000, window 10 s
  writeLog(root, 's1', frames(4), { mtimeMs: 5_000_000 })
  r.clock.t = 11_999
  assert.equal((await r.read(root)).messages.length, 2, 'still the remembered answer 9999 ms after it was computed')
  r.clock.t = 12_000
  assert.equal((await r.read(root)).messages.length, 4, 'fresh once 10 s have passed since the answer')
})

test('a quick read keeps the floor of 3 s', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2), { mtimeMs: 5_000_000 })
  const r = rig()
  r.cost = 100 // 5 x 100 ms is under the floor
  await r.read(root) // done at 100
  writeLog(root, 's1', frames(4), { mtimeMs: 5_000_000 })
  r.clock.t = 3099
  assert.equal((await r.read(root)).messages.length, 2)
  r.clock.t = 3100
  assert.equal((await r.read(root)).messages.length, 4)
})

test('the window never grows past 30 s, however long the read took', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2), { mtimeMs: 5_000_000 })
  const r = rig()
  r.cost = 20_000 // 5 x 20 s = 100 s: capped
  await r.read(root) // done at 20000
  writeLog(root, 's1', frames(4), { mtimeMs: 5_000_000 })
  r.clock.t = 49_999
  assert.equal((await r.read(root)).messages.length, 2)
  r.clock.t = 50_000
  assert.equal((await r.read(root)).messages.length, 4)
})

test('the cost of the last parse of the file is remembered when the next read is served from the parsed cache (the log did not change)', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2), { mtimeMs: 5_000_000 })
  const r = rig()
  r.cost = 2000
  await r.read(root) // parsed at t = 2000, window 10 s
  r.clock.t = 12_000
  r.cost = 0
  await r.read(root) // same path, mtime and size: no parse, answered from the parsed cache, window starts again at 12000
  const stats = r.seen.stats
  r.clock.t = 21_999
  await r.read(root)
  assert.equal(r.seen.stats, stats, 'still inside the 10 s window (not the 3 s floor): the disk was not touched')
  r.clock.t = 22_000
  await r.read(root)
  assert.ok(r.seen.stats > stats, 'after 10 s it looks at the disk again')
})

test('a cheaper parse lowers the window again: it follows the last parse of that file', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2), { mtimeMs: 5_000_000 })
  const r = rig()
  r.cost = 2000
  await r.read(root)
  r.clock.t = 12_000
  writeLog(root, 's1', frames(4), { mtimeMs: 6_000_000 }) // changed: parsed again
  r.cost = 100
  await r.read(root) // done at 12100, window 3 s
  writeLog(root, 's1', frames(6), { mtimeMs: 7_000_000 })
  r.clock.t = 15_100
  assert.equal((await r.read(root)).messages.length, 6, 'the window is 3 s again')
})

test('the window is per log file: a slow log does not slow down another one', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', frames(2), { mtimeMs: 5_000_000 })
  writeLog(root, 's2', frames(2), { mtimeMs: 5_000_000 })
  const r = rig()
  r.cost = 2000
  await r.read(root) // s1: window 10 s
  r.cost = 0
  const second = await r.read(root, { sessionId: 's2' }) // s2 parsed in no time: window 3 s
  assert.equal(second.ok, true)
  writeLog(root, 's2', frames(4), { mtimeMs: 6_000_000 })
  r.clock.t = 5_100 // 3.1 s after the answer for s2
  assert.equal((await r.read(root, { sessionId: 's2' })).messages.length, 4)
})
