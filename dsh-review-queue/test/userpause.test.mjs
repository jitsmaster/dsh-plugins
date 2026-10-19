import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PAUSED_BY_USER, RAN_AGAIN_GRACE_MS, REASON, createPauseRecord, logMtimeOf, mergeCandidates, pausedByUserCandidates, pauseRunningSessions } from '../userpause.js'

// Pause all: cancel every running top-level session, remember them, list them as paused until they run again.
const memIo = () => { const io = { text: undefined, read: () => io.text, write: (t) => { io.text = t } }; return io }
const item = (id, over = {}) => ({ sessionId: id, running: true, cwd: 'D:/w/' + id, ...over })
const fakeController = (sessions, { cancelFails = [], stopOnCancel = true } = {}) => {
  const cancelled = []
  const c = {
    cancelled,
    list: async () => ({ items: sessions.map((s) => ({ ...s })) }),
    cancel: async ({ sessionId }) => {
      cancelled.push(sessionId)
      if (cancelFails.includes(sessionId)) throw Object.assign(new Error('gone'), { code: 'session/not-found' })
      if (stopOnCancel) sessions.find((s) => s.sessionId === sessionId).running = false
      return { accepted: true }
    },
  }
  return c
}
const noSleep = async () => {}

test('cancels every running top-level session (not idle ones, subagents or children) and remembers them with their titles', async () => {
  const sessions = [item('a'), item('b'), item('idle', { running: false }), item('sub', { origin: 'subagent' }), item('kid', { parentSessionId: 'a' })]
  const controller = fakeController(sessions)
  const record = createPauseRecord({ io: memIo(), now: () => 5000 })
  const r = await pauseRunningSessions({ controller, record, now: () => 5000, sleep: noSleep, titlesOf: async (ids) => new Map(ids.map((id) => [id, 'Title ' + id])) })
  assert.deepEqual(controller.cancelled.sort(), ['a', 'b'])
  assert.deepEqual([r.ok, r.paused, r.stillRunning], [true, 2, 0])
  assert.deepEqual(record.entries().map((e) => [e.sessionId, e.title, e.cwd, e.pausedAt]), [['a', 'Title a', 'D:/w/a', 5000], ['b', 'Title b', 'D:/w/b', 5000]])
})

test('a cancel that fails still leaves the session remembered; a session that does not stop in time is reported', async () => {
  const sessions = [item('a'), item('b')]
  const controller = fakeController(sessions, { cancelFails: ['a'], stopOnCancel: false })
  const record = createPauseRecord({ io: memIo() })
  const lines = []
  const r = await pauseRunningSessions({ controller, record, sleep: noSleep, settleMs: 500, pollMs: 250, log: (l) => lines.push(l) })
  assert.deepEqual([r.ok, r.paused, r.stillRunning], [true, 2, 2])
  assert.equal(record.size, 2)
  assert.ok(lines.some((l) => /cancel of a failed/.test(l)))
})

test('waits until the cancelled turns have ended', async () => {
  const sessions = [item('a')]
  const controller = fakeController(sessions, { stopOnCancel: false })
  let sleeps = 0
  const sleep = async () => { if (++sleeps === 3) sessions[0].running = false }
  const r = await pauseRunningSessions({ controller, record: createPauseRecord({ io: memIo() }), sleep })
  assert.equal(r.stillRunning, 0)
  assert.equal(sleeps, 3)
})

test('nothing running records nothing; no controller or a failing list is an error and records nothing', async () => {
  const record = createPauseRecord({ io: memIo() })
  assert.deepEqual((await pauseRunningSessions({ controller: fakeController([item('x', { running: false })]), record, sleep: noSleep })).paused, 0)
  assert.deepEqual(await pauseRunningSessions({ controller: {}, record }), { ok: false, error: 'no-controller' })
  const bad = { list: async () => { throw new Error('boom') }, cancel: async () => {} }
  const r = await pauseRunningSessions({ controller: bad, record, sleep: noSleep })
  assert.equal(r.ok, false)
  assert.match(r.error, /boom/)
  assert.equal(record.size, 0)
})

test('the record survives a restart (persisted), drops entries older than a week, and ignores a damaged file', () => {
  const io = memIo()
  createPauseRecord({ io, now: () => 1000 }).add([{ sessionId: 'a', title: 'T', cwd: 'c' }], 1000)
  assert.deepEqual(createPauseRecord({ io, now: () => 2000 }).entries(), [{ sessionId: 'a', pausedAt: 1000, title: 'T', cwd: 'c' }])
  assert.equal(createPauseRecord({ io, now: () => 1000 + 7 * 24 * 3600 * 1000 + 1 }).size, 0)
  assert.equal(createPauseRecord({ io: { read: () => '{nope', write() {} } }).size, 0)
})

test('candidates: one per remembered session in the paused-scan shape; one that ran again or was archived is forgotten', async () => {
  const record = createPauseRecord({ io: memIo(), now: () => 10_000 })
  record.add([{ sessionId: 'a', title: 'A', cwd: 'D:/a' }, { sessionId: 'ran', title: 'R' }, { sessionId: 'old', title: 'O' }, { sessionId: 'gone' }], 10_000)
  const mtimes = { a: 9_000, ran: 10_000 + RAN_AGAIN_GRACE_MS + 1, old: undefined }
  const out = await pausedByUserCandidates({ record, logMtime: async (id) => mtimes[id], skipIds: new Set(['gone']) })
  assert.deepEqual(out.map((c) => c.sessionId).sort(), ['a', 'old'])
  const a = out.find((c) => c.sessionId === 'a')
  assert.deepEqual([a.kinds, a.reason, a.lastWrite, a.title, a.cwd, a.danglingCalls], [[PAUSED_BY_USER], REASON, 10_000, 'A', 'D:/a', []])
  assert.deepEqual(record.entries().map((e) => e.sessionId).sort(), ['a', 'old'], 'the ones that ran again or were archived are gone from the record')
})

test('mergeCandidates adds the remembered ones, keeps the scan details of a session both found, and leaves a failed scan alone', () => {
  const scanned = { ok: true, scanned: 3, candidates: [{ sessionId: 'x', lastWrite: 5, kinds: ['open-turn'], reason: 'Cut off in the middle of a turn', danglingCalls: ['shell'] }] }
  const extra = [{ sessionId: 'x', lastWrite: 9, kinds: [PAUSED_BY_USER], reason: REASON, danglingCalls: [] }, { sessionId: 'y', lastWrite: 1, kinds: [PAUSED_BY_USER], reason: REASON, danglingCalls: [] }]
  const m = mergeCandidates(scanned, extra)
  assert.deepEqual(m.candidates.map((c) => c.sessionId), ['y', 'x'])
  const x = m.candidates.find((c) => c.sessionId === 'x')
  assert.deepEqual([x.kinds, x.danglingCalls, x.lastWrite], [['open-turn', PAUSED_BY_USER], ['shell'], 5])
  assert.equal(x.reason, REASON + '; Cut off in the middle of a turn')
  const failed = { ok: false, error: 'no-zstd' }
  assert.equal(mergeCandidates(failed, extra), failed)
  assert.equal(mergeCandidates(scanned, []), scanned)
})

test('logMtimeOf finds the log of a session in whichever project folder holds it', async () => {
  const dirs = [{ name: 'f.txt', isDirectory: () => false }, { name: '--p1--', isDirectory: () => true }, { name: '--p2--', isDirectory: () => true }]
  const fs = { readdir: async () => dirs, stat: async (p) => { if (/--p2--[\\/]s1[\\/]session\.v4\.jsonl\.zstd$/.test(p)) return { mtimeMs: 1234.4 }; throw new Error('ENOENT') } }
  assert.equal(await logMtimeOf('root', 's1', { fs }), 1234)
  assert.equal(await logMtimeOf('root', 'nope', { fs }), undefined)
  assert.equal(await logMtimeOf('root', 's1', { fs: { readdir: async () => { throw new Error('x') } } }), undefined)
})
