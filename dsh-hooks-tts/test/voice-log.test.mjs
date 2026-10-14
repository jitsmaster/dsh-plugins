// The voice log is written off the hot path: write() only buffers, a flush appends the lines in one go.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceLog } from '../voice/log.js'

function make(over = {}) {
  const h = { appended: [], renames: [], size: 0, scheduled: [], fail: false }
  h.log = createVoiceLog({
    file: 'D:\\state\\voice.log',
    maxBytes: 1000,
    appendFile: async (file, data) => { if (h.fail) throw new Error('disk'); h.appended.push([file, data]); h.size += data.length },
    statFile: async () => { if (h.size === 0 && !h.appended.length) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return { size: h.size } },
    rename: async (a, b) => { h.renames.push([a, b]); h.size = 0 },
    schedule: (fn) => { h.scheduled.push(fn) },
    now: () => new Date('2026-10-13T20:00:00Z'),
    ...over,
  })
  return h
}

test('L1 write() does no I/O itself: it buffers and schedules one flush', async () => {
  const h = make()
  h.log.write({ type: 'a' })
  h.log.write({ type: 'b' })
  assert.deepEqual(h.appended, [])
  assert.equal(h.scheduled.length, 1, 'one flush scheduled for the burst')
  await h.scheduled[0]()
  assert.equal(h.appended.length, 1)
  const lines = h.appended[0][1].trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.type), ['a', 'b'])
  assert.equal(lines[0].at, '2026-10-13T20:00:00.000Z')
})

test('L2 the log rotates to .1 when it grows past maxBytes before the append', async () => {
  const h = make()
  h.size = 5000
  h.log.write({ type: 'a' })
  await h.log.flush()
  assert.deepEqual(h.renames, [['D:\\state\\voice.log', 'D:\\state\\voice.log.1']])
  assert.equal(h.appended.length, 1)
})

test('L3 an I/O failure is swallowed and does not stop later writes', async () => {
  const h = make()
  h.fail = true
  h.log.write({ type: 'a' })
  await assert.doesNotReject(h.log.flush())
  h.fail = false
  h.log.write({ type: 'b' })
  await h.log.flush()
  assert.equal(h.appended.length, 1)
  assert.match(h.appended[0][1], /"b"/)
})

test('L4 the buffer is bounded when the disk stalls: the oldest entries go first', async () => {
  const h = make({ maxBuffered: 3 })
  for (const n of [1, 2, 3, 4, 5]) h.log.write({ n })
  await h.log.flush()
  assert.deepEqual(h.appended[0][1].trim().split('\n').map((l) => JSON.parse(l).n), [3, 4, 5])
})

test('L5 flushes never overlap, and entries written during a flush are written by the next one', async () => {
  let release
  let active = 0
  let maxActive = 0
  const h = make({
    appendFile: async (file, data) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => { release = r }); active--; h.appended.push([file, data]) },
  })
  h.log.write({ n: 1 })
  const first = h.log.flush()
  await new Promise((r) => setImmediate(r))
  h.log.write({ n: 2 })
  const second = h.log.flush()
  await new Promise((r) => setImmediate(r))
  release(); await new Promise((r) => setImmediate(r)); release()
  await first; await second
  assert.equal(maxActive, 1)
  assert.deepEqual(h.appended.map(([, d]) => JSON.parse(d.trim()).n), [1, 2])
})

test('L6 an entry that cannot be serialised is dropped, not thrown, and nothing is written for it', async () => {
  const h = make()
  const cyc = {}; cyc.self = cyc
  assert.doesNotThrow(() => h.log.write(cyc))
  await h.log.flush()
  assert.equal(h.scheduled.length, 0, 'nothing buffered, so no flush was scheduled')
  assert.deepEqual(h.appended, [], 'nothing was written')
  h.log.write({ type: 'ok' })
  await h.scheduled[0]()
  assert.equal(h.appended.length, 1)
  assert.deepEqual(h.appended[0][1].trim().split('\n').map((l) => JSON.parse(l).type), ['ok'], 'only the valid entry reaches the file')
})

test('L7 a line is truncated to ~8 KB (still one valid JSON line that says it was cut); normal lines are untouched', async () => {
  const h = make()
  h.log.write({ type: 'decider', line: 'y'.repeat(500_000) })
  h.log.write({ type: 'flow', stage: 'ok' })
  h.log.write({ type: 'flow', stage: 'wide', text: '\u4E2D'.repeat(20_000) })
  await h.log.flush()
  const lines = h.appended[0][1].split('\n').filter(Boolean)
  assert.equal(lines.length, 3)
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 8192, 'a line is at most 8 KB')
  const [big, small, wide] = lines.map((l) => JSON.parse(l))
  assert.equal(big.type, 'decider')
  assert.equal(big.truncated, true)
  assert.equal(big.at, '2026-10-13T20:00:00.000Z')
  assert.equal(wide.truncated, true)
  assert.deepEqual(small, { at: '2026-10-13T20:00:00.000Z', type: 'flow', stage: 'ok' })
})

test('L11 the line limit is configurable', async () => {
  const h = make({ maxLineBytes: 300 })
  h.log.write({ type: 'a', text: 'z'.repeat(1000) })
  await h.log.flush()
  assert.ok(Buffer.byteLength(h.appended[0][1].trim()) <= 300)
})

test('L8 flushWithin() resolves when the flush finishes, and after the timeout when the disk stalls (shutdown must not hang)', async () => {
  const h = make()
  h.log.write({ type: 'a' })
  await h.log.flushWithin(1000)
  assert.equal(h.appended.length, 1, 'a healthy flush completes within the bound')

  const stalled = make({ appendFile: () => new Promise(() => {}) }) // never settles
  stalled.log.write({ type: 'b' })
  const t0 = Date.now()
  await stalled.log.flushWithin(40)
  const took = Date.now() - t0
  assert.ok(took >= 30 && took < 1000, 'gave up after the bound, took ' + took + ' ms')
  stalled.log.write({ type: 'c' })
  await stalled.log.flushWithin(20) // a later bounded flush behind the stuck one is bounded too
})

test('L9 a multi-MB line is cut from a bounded prefix: under the cap, one valid JSON object, no multi-MB copy per shrink pass', async () => {
  for (const text of ['y'.repeat(5_000_000), '"'.repeat(5_000_000), '\u4E2D'.repeat(2_000_000)]) {
    const h = make()
    const realFrom = Buffer.from
    let biggest = 0
    Buffer.from = function (value, ...rest) { if (typeof value === 'string') biggest = Math.max(biggest, value.length); return realFrom.call(Buffer, value, ...rest) }
    const t0 = Date.now()
    try { h.log.write({ type: 'decider', stage: 'reply', text }) } finally { Buffer.from = realFrom }
    const took = Date.now() - t0
    await h.log.flush()
    const line = h.appended[0][1]
    assert.ok(Buffer.byteLength(line) <= 8192, 'under the cap')
    const parsed = JSON.parse(line)
    assert.equal(parsed.truncated, true)
    assert.equal(parsed.type, 'decider')
    assert.ok(parsed.bytes > 2_000_000, 'the original size is reported')
    assert.ok(parsed.text.length > 100, 'the start of the original is kept')
    assert.ok(biggest <= 100_000, 'only a bounded prefix is copied, saw a ' + biggest + ' char string')
    assert.ok(took < 1500, 'took ' + took + ' ms')
  }
})

test('L10 a stalled append is not chained again for every write: one append in flight, bounded pending flushes', async () => {
  let appends = 0
  const h = make({ appendFile: () => { appends++; return new Promise(() => {}) }, maxBuffered: 5 })
  let drains = 0
  h.log.write({ n: 0 })
  h.scheduled.shift()() // the 50 ms flush fires and stalls in appendFile
  await new Promise((r) => setImmediate(r))
  for (let i = 1; i <= 200; i++) {
    h.log.write({ n: i })
    while (h.scheduled.length) { h.scheduled.shift()(); drains++ } // every 50 ms tick schedules (and runs) another flush
  }
  await new Promise((r) => setImmediate(r))
  assert.ok(drains >= 1, 'flushes were requested during the stall')
  assert.equal(h.log.pendingFlushes(), 1, 'one flush link, however many writes and ticks')
  assert.equal(appends, 1, 'appendFile was called once while the first append is stalled')
})

test('L12 after a stalled flush finally settles, the buffered lines (the newest maxBuffered) are written', async () => {
  const calls = []
  let release
  const h = make({
    maxBuffered: 3,
    appendFile: (file, data) => { calls.push(data); return calls.length === 1 ? new Promise((r) => { release = r }) : Promise.resolve() },
  })
  h.log.write({ n: 0 })
  const first = h.log.flush()
  await new Promise((r) => setImmediate(r))
  for (let i = 1; i <= 10; i++) h.log.write({ n: i })
  const second = h.log.flush()
  assert.equal(h.log.pendingFlushes(), 1)
  release()
  await first; await second
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].trim().split('\n').map((l) => JSON.parse(l).n), [8, 9, 10])
})
