import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile as realReadFile } from 'node:fs/promises'
import { zstdDecompressSync as zstd } from 'node:zlib'
import { createThreadCache, readThread } from '../thread.js'
import { log, logBytes, tmpRoot, writeLog } from './paused-helpers.mjs'

// Review follow-up (performance): a live session's log only grows by whole zstd frames, so the thread decodes only the bytes that were added
// since the last read (from the end of the last COMPLETE frame) instead of the whole log again, continuing the record indexes (= message ids).
// Anything that does not look like plain growth (a shrunk or replaced file, a failed read of the new part) falls back to the full parse, and the
// answer is always the one a full parse of the same bytes gives (docs/mobile.md "Chat thread", "Cost on the PC").
const pair = (k) => [log.user('u' + k), log.assistant('a' + k)]
/** The frames of a synthetic log: the first one has the head record; frame n holds the messages of pair n. */
const framesOf = (n) => Array.from({ length: n }, (_, k) => (k === 0 ? [log.head(), ...pair(0)] : pair(k)))

/** Counts the decompressions, the whole-file reads and the ranged reads; the seam of the ranged read is fs.readFrom(file, position, length). */
function rig() {
  const seen = { unzips: 0, reads: 0, ranges: [] }
  const options = []
  return {
    seen, options, cache: createThreadCache({ throttleMs: 0 }),
    unzip: (bytes, o) => { seen.unzips++; options.push(o); return zstd(bytes, o) },
    fs: {
      readFile: async (...a) => { seen.reads++; return realReadFile(...a) },
      readFrom: async (file, position, length) => { seen.ranges.push([position, length]); return readFileSync(file).subarray(position, position + length) },
    },
  }
}
const full = (root, over = {}) => readThread({ root, sessionId: 's1', cache: createThreadCache({ throttleMs: 0 }), ...over })

test('a log that grew by whole frames decodes only the new frames, reading only the new bytes', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', framesOf(3))
  const r = rig()
  await readThread({ root, sessionId: 's1', ...r })
  assert.deepEqual([r.seen.unzips, r.seen.reads, r.seen.ranges.length], [3, 1, 0])
  const before = statSync(file).size
  appendFileSync(file, logBytes([pair(3), pair(4)]))
  const grown = await readThread({ root, sessionId: 's1', ...r })
  assert.equal(r.seen.unzips, 5, 'two more frames decoded, not five again')
  assert.equal(r.seen.reads, 1, 'the whole file was not read again')
  assert.deepEqual(r.seen.ranges, [[before, statSync(file).size - before]])
  assert.deepEqual(grown, await full(root))
})

test('the ids continue after the last record of the previous read (an id is the index of its record in the log)', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', framesOf(2)) // head = 0, then ids 1, 2, 3, 4
  const r = rig()
  assert.deepEqual((await readThread({ root, sessionId: 's1', ...r })).messages.map((m) => m.id), [1, 2, 3, 4])
  appendFileSync(file, logBytes([[log.turnStart(1), ...pair(2)]])) // a record without a message in between
  const grown = await readThread({ root, sessionId: 's1', ...r })
  assert.deepEqual(grown.messages.map((m) => [m.id, m.text]), [[1, 'u0'], [2, 'a0'], [3, 'u1'], [4, 'a1'], [6, 'u2'], [7, 'a2']])
})

test('an unchanged log is not read at all, and a growth read twice is read once', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', framesOf(2))
  const r = rig()
  await readThread({ root, sessionId: 's1', ...r })
  await readThread({ root, sessionId: 's1', ...r })
  assert.deepEqual([r.seen.unzips, r.seen.reads, r.seen.ranges.length], [2, 1, 0])
  appendFileSync(file, logBytes([pair(2)]))
  await readThread({ root, sessionId: 's1', ...r })
  await readThread({ root, sessionId: 's1', ...r })
  assert.deepEqual([r.seen.unzips, r.seen.ranges.length], [3, 1])
})

test('a torn last frame is not counted: the next read starts at its first byte and decodes it once it is complete', async (t) => {
  const root = tmpRoot(t)
  const frames = framesOf(4)
  const bytes = logBytes(frames)
  const lens = frames.map((f) => logBytes([f]).length)
  const doneAt = lens[0] + lens[1] + lens[2] // the end of the last frame that is complete in the torn file
  const torn = bytes.subarray(0, bytes.length - 5)
  const file = writeLog(root, 's1', null, { raw: torn })
  const r = rig()
  const first = await readThread({ root, sessionId: 's1', ...r })
  assert.deepEqual(first.messages.map((m) => m.id), [1, 2, 3, 4, 5, 6])
  const unzips = r.seen.unzips
  await readThread({ root, sessionId: 's1', ...r })
  assert.equal(r.seen.unzips, unzips, 'the same torn file again: nothing new to decode, nothing retried')
  writeFileSync(file, bytes) // the writer finished the frame
  const done = await readThread({ root, sessionId: 's1', ...r })
  assert.deepEqual(r.seen.ranges.at(-1), [doneAt, bytes.length - doneAt], 'it reads from the start of the frame that was torn')
  assert.equal(r.seen.unzips - unzips, 1, 'only that frame is decoded')
  assert.deepEqual(done.messages.map((m) => m.id), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(done, await full(root))
})

test('a torn tail that grows but is still torn gives what is complete and keeps the end where it was', async (t) => {
  const root = tmpRoot(t)
  const frames = framesOf(4)
  const bytes = logBytes(frames)
  const file = writeLog(root, 's1', null, { raw: bytes.subarray(0, bytes.length - 20) })
  const r = rig()
  await readThread({ root, sessionId: 's1', ...r })
  writeFileSync(file, bytes.subarray(0, bytes.length - 8))
  const again = await readThread({ root, sessionId: 's1', ...r })
  assert.deepEqual(again, await full(root))
  assert.deepEqual(again.messages.map((m) => m.id), [1, 2, 3, 4, 5, 6])
})

test('a log that shrank is parsed in full again', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', framesOf(5))
  const r = rig()
  await readThread({ root, sessionId: 's1', ...r })
  writeFileSync(file, logBytes(framesOf(2)))
  const shrunk = await readThread({ root, sessionId: 's1', ...r })
  assert.deepEqual([r.seen.reads, r.seen.ranges.length], [2, 0], 'the whole file was read again and no range')
  assert.deepEqual(shrunk.messages.map((m) => m.id), [1, 2, 3, 4])
  assert.deepEqual(shrunk, await full(root))
})

test('a log replaced by a bigger one that does not continue the old frames is parsed in full again', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', framesOf(2))
  const r = rig()
  await readThread({ root, sessionId: 's1', ...r })
  writeFileSync(file, logBytes([[log.head(), ...pair(7), ...pair(8), ...pair(9), ...pair(10)]])) // one frame, bigger, from another history
  const replaced = await readThread({ root, sessionId: 's1', ...r })
  assert.equal(r.seen.reads, 2, 'the bytes at the old end are no frame start: the full parse ran')
  assert.deepEqual(replaced, await full(root))
  assert.deepEqual(replaced.messages.map((m) => m.text), ['u7', 'a7', 'u8', 'a8', 'u9', 'a9', 'u10', 'a10'])
})

test('a ranged read that fails falls back to the full parse', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', framesOf(2))
  const r = rig()
  await readThread({ root, sessionId: 's1', ...r })
  appendFileSync(file, logBytes([pair(2)]))
  const grown = await readThread({ root, sessionId: 's1', ...r, fs: { ...r.fs, readFrom: async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) } } })
  assert.equal(r.seen.reads, 2)
  assert.deepEqual(grown.messages.map((m) => m.id), [1, 2, 3, 4, 5, 6])
})

test('a ranged read that comes back short (the file changed under it) falls back to the full parse', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', framesOf(2))
  const r = rig()
  await readThread({ root, sessionId: 's1', ...r })
  appendFileSync(file, logBytes([pair(2)]))
  const grown = await readThread({ root, sessionId: 's1', ...r, fs: { ...r.fs, readFrom: async () => Buffer.alloc(0) } })
  assert.equal(r.seen.reads, 2)
  assert.deepEqual(grown, await full(root))
})

test('the same size with a newer mtime is not growth: the log is parsed in full again', async (t) => {
  const root = tmpRoot(t)
  const raw = logBytes(framesOf(2))
  const file = writeLog(root, 's1', null, { raw, mtimeMs: 5_000_000 })
  const r = rig()
  await readThread({ root, sessionId: 's1', ...r })
  writeLog(root, 's1', null, { raw, mtimeMs: 6_000_000 }) // the same bytes, a newer mtime
  assert.equal(statSync(file).mtimeMs, 6_000_000)
  await readThread({ root, sessionId: 's1', ...r })
  assert.deepEqual([r.seen.reads, r.seen.ranges.length], [2, 0])
})

test('a frame that is cut by a false frame magic inside its data is still joined and decoded in the new part', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', framesOf(1))
  const r = rig()
  await readThread({ root, sessionId: 's1', ...r })
  // 0x28 b5 2f fd inside the text of a message: the compressed bytes may or may not contain it, the answer must equal the full parse either way
  appendFileSync(file, logBytes([[log.user(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]).toString('latin1') + 'x'.repeat(50)), ...pair(5)]]))
  assert.deepEqual(await readThread({ root, sessionId: 's1', ...r }), await full(root))
})

// ---- the caps still apply to what is decoded, with a running total --------------------------------------------------------------------

test('the total cap counts what earlier reads decoded: the new frame is decoded with the room that is left', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', [[log.head(), log.user('a'.repeat(500))]])
  const r = rig()
  const caps = { maxFrameBytes: 100_000, maxTotalBytes: 5000 }
  await readThread({ root, sessionId: 's1', ...caps, ...r })
  const first = zstd(readFileSync(file)).length
  appendFileSync(file, logBytes([[log.user('b'.repeat(500))]]))
  const grown = await readThread({ root, sessionId: 's1', ...caps, ...r })
  assert.equal(grown.ok, true)
  assert.deepEqual(r.options.at(-1), { maxOutputLength: 5000 - first })
  assert.equal(r.seen.reads, 1)
})

test('a growth that pushes the log over the total cap is too-large, whatever was decoded before', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', [[log.head(), log.user('a'.repeat(1000))]])
  const r = rig()
  const caps = { maxFrameBytes: 100_000, maxTotalBytes: 2500 }
  assert.equal((await readThread({ root, sessionId: 's1', ...caps, ...r })).ok, true)
  appendFileSync(file, logBytes([[log.user('b'.repeat(1000))], [log.user('c'.repeat(1000))]]))
  assert.deepEqual(await readThread({ root, sessionId: 's1', ...caps, ...r }), { ok: false, error: 'too-large' })
  assert.equal((await readThread({ root, sessionId: 's1', maxFrameBytes: 100_000, maxTotalBytes: 100_000, ...r })).ok, true, 'a roomier cap reads it')
})

// ---- the same answer as a full parse, whatever the cut ------------------------------------------------------------------------------------

/** A tiny seeded generator: the property tests are reproducible. */
function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 } }

test('property: growing a synthetic multi-frame log in random steps (cuts inside frames included) always answers what a full parse of the same bytes answers', async (t) => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const rand = prng(seed)
    const frames = Array.from({ length: 14 }, (_, k) => {
      const records = []
      for (let i = 0, n = 1 + Math.floor(rand() * 5); i < n; i++) records.push(rand() < 0.3 ? log.turnStart(k) : rand() < 0.5 ? log.user('u' + k + '.' + i + ' ' + 'x'.repeat(Math.floor(rand() * 300))) : log.assistant('a' + k + '.' + i))
      return k === 0 ? [log.head(), ...records] : records
    })
    const bytes = logBytes(frames)
    const root = tmpRoot(t)
    const file = writeLog(root, 's1', null, { raw: bytes.subarray(0, 0) })
    const r = rig()
    let cut = 0
    while (cut < bytes.length) {
      cut = Math.min(bytes.length, cut + 1 + Math.floor(rand() * (bytes.length / 6)))
      writeFileSync(file, bytes.subarray(0, cut))
      const grown = await readThread({ root, sessionId: 's1', limit: 100, ...r })
      assert.deepEqual(grown, await full(root, { limit: 100 }), 'seed ' + seed + ' cut ' + cut + '/' + bytes.length)
    }
    assert.ok(r.seen.ranges.length > 0, 'seed ' + seed + ': some reads were incremental')
    assert.ok(r.seen.reads < 8, 'seed ' + seed + ': most reads were incremental')
    const everything = await readThread({ root, sessionId: 's1', limit: 100, ...r })
    assert.deepEqual(everything.messages.map((m) => m.id), (await full(root, { limit: 100 })).messages.map((m) => m.id))
  }
})
