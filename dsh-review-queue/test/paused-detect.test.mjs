import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyLog, parseLog, scanSessionLogs, STALE_MS, MAX_AGE_MS, RESUME_PROMPT, RESUME_CONCURRENCY, reasonText } from '../paused.js'
import { cutOff, finished, log, logBytes, tmpRoot, writeLog } from './paused-helpers.mjs'

// Detection of sessions that a restart or crash cut off, from the persisted logs (docs/hub.md "Paused sessions after a restart").
const flat = (frames) => frames.flat()
const kindsOf = (frames, opts) => classifyLog(flat(frames), opts).kinds

test('the constants: resume prompt, 2 minute quiet time, 3 day window, 3 at a time', () => {
  assert.equal(RESUME_PROMPT, 'Resume the work this session was doing when it was cut off. First check git status and git log in its worktree and the last tool calls, because the last tool may have half-applied, then continue.')
  assert.equal(STALE_MS, 2 * 60 * 1000)
  assert.equal(MAX_AGE_MS, 3 * 24 * 3600 * 1000)
  assert.equal(RESUME_CONCURRENCY, 3)
})

// ---- classifyLog -----------------------------------------------------------------------------------------------------------------

test('a turn that started and never ended is cut off (open-turn)', () => {
  const c = classifyLog(flat(cutOff()))
  assert.deepEqual(c.kinds, ['open-turn'])
  assert.equal(c.turn, 1)
  assert.equal(c.title, 'Fix the thing')
  assert.equal(c.lastUser, 'please fix it')
  assert.equal(c.lastAssistant, 'on it')
})

test('a finished turn is not cut off, whatever the last words sound like', () => {
  assert.deepEqual(kindsOf(finished()), [])
})

test('turn/end interrupted with no later turn is cut off; a later finished turn clears it, a later open turn is open-turn', () => {
  const interrupted = [log.head(), log.turnStart(1), log.turnEnd(1, { kind: 'interrupted' })]
  assert.deepEqual(kindsOf([interrupted]), ['interrupted'])
  assert.deepEqual(kindsOf([[...interrupted, log.turnStart(2), log.turnEnd(2)]]), [])
  assert.deepEqual(kindsOf([[...interrupted, log.turnStart(2)]]), ['open-turn'])
})

test('deliberate or ordinary ends are not a restart cut: stopped by the user, error, parent abort, cap handoff, max tokens', () => {
  for (const reason of [{ kind: 'aborted', reason: { kind: 'user' } }, { kind: 'aborted', reason: { kind: 'parent' } }, { kind: 'aborted', reason: { kind: 'disposed' } }, { kind: 'error', error: { message: 'Overloaded' } }, { kind: 'blocked' }, { kind: 'max-tokens' }]) {
    assert.deepEqual(kindsOf(finished(reason)), [], JSON.stringify(reason))
  }
})

test('an unconsumed next-turn inbox is pending-inbox, even after a finished turn; a splice that removes it clears it', () => {
  const queued = [log.head(), log.turnStart(1), log.turnEnd(1), log.splice('next-turn', 0, 0, [log.queued('do this next')])]
  const c = classifyLog(queued)
  assert.deepEqual(c.kinds, ['pending-inbox'])
  assert.equal(c.pending, 1)
  assert.deepEqual(classifyLog([...queued, log.splice('next-turn', 0, 1)]).kinds, [])
  assert.deepEqual(classifyLog([...queued, log.splice('next-turn', 0, 1, []), log.splice('next-turn', 0, 0, [log.queued('a'), log.queued('b')])]).pending, 2)
})

test('next-step notices (hooks, working directory, reminders) left in the inbox of a finished session are not a cut', () => {
  const notices = [log.head(), log.turnStart(1), log.turnEnd(1), log.splice('next-step', 0, 0, [log.queued('cwd changed', { kind: 'working-directory' }), log.queued('reminder', { kind: 'plugin:hooks-tts' })])]
  assert.deepEqual(classifyLog(notices).kinds, [])
})

test('a torn last frame is reported as torn', () => {
  assert.deepEqual(classifyLog(flat(finished()), { torn: true }).kinds, ['torn'])
})

test('several signals are all listed, in a fixed order', () => {
  const both = [log.head(), log.turnStart(1), log.splice('next-turn', 0, 0, [log.queued('x')])]
  assert.deepEqual(classifyLog(both, { torn: true }).kinds, ['open-turn', 'pending-inbox', 'torn'])
})

test('tool calls without a result are listed as dangling; a result, a step end or a turn end closes them', () => {
  const calls = [log.head(), log.turnStart(1), log.assistant('go', [['a', 'shell'], ['b', 'apply_patch']])]
  assert.deepEqual(classifyLog(calls).danglingCalls, ['shell', 'apply_patch'])
  assert.deepEqual(classifyLog([...calls, log.result('a')]).danglingCalls, ['apply_patch'])
  assert.deepEqual(classifyLog([...calls, log.stepEnd()]).danglingCalls, [])
})

test('the last user message skips automatic notices; text is clipped to one short line', () => {
  const c = classifyLog([log.head(), log.turnStart(1), log.user('real request'), log.user('cwd changed', { kind: 'working-directory' }), log.assistant('x'.repeat(500))])
  assert.equal(c.lastUser, 'real request')
  assert.ok(c.lastAssistant.length <= 161, 'clipped')
})

test('the head of the log names the cwd and the origin; a log with no records is not classified', () => {
  const c = classifyLog([log.head({ cwd: 'D:\\dev\\x', origin: 'subagent', parentSession: 'p1' }), log.turnStart(1)])
  assert.deepEqual([c.head.cwd, c.head.origin, c.head.parent], ['D:\\dev\\x', 'subagent', 'p1'])
  assert.equal(classifyLog([]).head, undefined)
})

test('reasonText says in words why a session is listed', () => {
  assert.match(reasonText({ kinds: ['open-turn'], pending: 0 }), /middle of a turn/)
  assert.match(reasonText({ kinds: ['interrupted'], pending: 0 }), /interrupted/)
  assert.match(reasonText({ kinds: ['pending-inbox'], pending: 2 }), /2 queued messages never ran/)
  assert.match(reasonText({ kinds: ['pending-inbox'], pending: 1 }), /1 queued message never ran/)
  assert.match(reasonText({ kinds: ['torn'], pending: 0 }), /half-written/)
  assert.match(reasonText({ kinds: ['open-turn', 'pending-inbox'], pending: 1 }), /middle of a turn.*; 1 queued message/)
})

// ---- parseLog (zstd frames) ----------------------------------------------------------------------------------------------------------

test('parseLog reads every frame of a log and joins their lines in order', () => {
  const frames = [[log.head()], [log.turnStart(1)], [log.turnEnd(1)]]
  const { records, torn } = parseLog(logBytes(frames))
  assert.deepEqual(records.map((r) => r.type), ['session', 'turn/start', 'turn/end'])
  assert.equal(torn, false)
})

test('parseLog keeps what it could read and says torn when the last frame is cut short', () => {
  const { records, torn } = parseLog(logBytes([[log.head()], [log.turnStart(1), log.user('some longer text to compress ' + 'abc '.repeat(50))]], { tornTail: 6 }))
  assert.deepEqual(records.map((r) => r.type), ['session'])
  assert.equal(torn, true)
})

test('parseLog on garbage or nothing gives no records and torn', () => {
  assert.deepEqual(parseLog(Buffer.from('not a zstd log at all')), { records: [], torn: true })
  assert.deepEqual(parseLog(Buffer.alloc(0)), { records: [], torn: false })
})

test('parseLog without a zstd codec says so instead of throwing', () => {
  assert.throws(() => parseLog(logBytes(finished()), { unzip: null }), /zstd/)
})

// ---- scanSessionLogs ------------------------------------------------------------------------------------------------------------------

const NOW = 100 * 24 * 3600 * 1000
const scan = (root, over = {}) => scanSessionLogs({ root, now: NOW, ...over })
const ids = (r) => r.candidates.map((c) => c.sessionId).sort()

test('finds top-level sessions cut off earlier than the quiet time, with what the card needs', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 'cut', cutOff({ cwd: 'D:\\dev\\proj' }), { mtimeMs: NOW - 10 * 60_000 })
  writeLog(root, 'done', finished(), { mtimeMs: NOW - 10 * 60_000 })
  const r = await scan(root)
  assert.equal(r.ok, true)
  assert.equal(r.scanned, 2)
  assert.deepEqual(ids(r), ['cut'])
  const c = r.candidates[0]
  assert.deepEqual([c.cwd, c.title, c.lastWrite, c.kinds, c.turn, c.danglingCalls, c.lastUser], ['D:\\dev\\proj', 'Fix the thing', NOW - 10 * 60_000, ['open-turn'], 1, ['shell'], 'please fix it'])
  assert.match(c.reason, /middle of a turn/)
})

test('subagents are never listed (origin subagent), even when cut off', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 'sub', cutOff({ origin: 'subagent', parentSession: 'p' }), { mtimeMs: NOW - 10 * 60_000 })
  writeLog(root, 'top', cutOff(), { mtimeMs: NOW - 10 * 60_000 })
  assert.deepEqual(ids(await scan(root)), ['top'])
})

test('sessions last written more than 3 days ago are ignored without reading them', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 'old', cutOff(), { mtimeMs: NOW - MAX_AGE_MS - 1000 })
  writeLog(root, 'edge', cutOff(), { mtimeMs: NOW - MAX_AGE_MS + 60_000 })
  const reads = []
  const r = await scan(root, { fs: { readFile: async (f) => { reads.push(f); return (await import('node:fs/promises')).readFile(f) } } })
  assert.deepEqual(ids(r), ['edge'])
  assert.equal(reads.length, 1, 'the old log was not even read')
})

test('a session that is live (in liveIds) or archived (skipIds) is never listed, and its log is not read', async (t) => {
  const root = tmpRoot(t)
  for (const id of ['live', 'archived', 'free']) writeLog(root, id, cutOff(), { mtimeMs: NOW - 10 * 60_000 })
  const reads = []
  const r = await scan(root, { liveIds: new Set(['live']), skipIds: new Set(['archived']), fs: { readFile: async (f) => { reads.push(f); return (await import('node:fs/promises')).readFile(f) } } })
  assert.deepEqual(ids(r), ['free'])
  assert.equal(reads.length, 1)
})

test('an open turn written less than 2 minutes ago is live work, not a cut: not listed', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 'busy', cutOff(), { mtimeMs: NOW - (STALE_MS - 1000) })
  writeLog(root, 'quiet', cutOff(), { mtimeMs: NOW - STALE_MS })
  assert.deepEqual(ids(await scan(root)), ['quiet'])
})

test('right after a restart (startedAt) an open turn written before the start is trusted at once, one written after it is not', async (t) => {
  const root = tmpRoot(t)
  const startedAt = NOW - 30_000
  writeLog(root, 'before', cutOff(), { mtimeMs: startedAt - 5_000 })
  writeLog(root, 'after', cutOff(), { mtimeMs: startedAt + 5_000 })
  assert.deepEqual(ids(await scan(root, { startedAt })), ['before'])
  assert.deepEqual(ids(await scan(root)), [], 'without a restart both are within the quiet time')
  assert.deepEqual(ids(await scan(root, { now: NOW + STALE_MS, startedAt })), ['after', 'before'], 'after the quiet time the second one counts too')
})

test('every kind of cut obeys the same trust rule, a finished session never appears, and unreadable logs are skipped', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 'intr', [[log.head(), log.turnStart(1), log.turnEnd(1, { kind: 'interrupted' })]], { mtimeMs: NOW - 5 * STALE_MS })
  writeLog(root, 'inbox', [[log.head(), log.turnStart(1), log.turnEnd(1), log.splice('next-turn', 0, 0, [log.queued('x')])]], { mtimeMs: NOW - 5 * STALE_MS })
  writeLog(root, 'torn', [...finished(), [log.user('padding '.repeat(30))]], { mtimeMs: NOW - 5 * STALE_MS, tornTail: 5 })
  writeLog(root, 'junk', [], { mtimeMs: NOW - 5 * STALE_MS, raw: Buffer.from('junk') })
  writeLog(root, 'empty', [], { mtimeMs: NOW - 5 * STALE_MS, raw: Buffer.alloc(0) })
  writeLog(root, 'fine', finished(), { mtimeMs: NOW - 5 * STALE_MS })
  const r = await scan(root)
  assert.deepEqual(ids(r), ['inbox', 'intr', 'torn'])
  assert.deepEqual(r.candidates.find((c) => c.sessionId === 'inbox').kinds, ['pending-inbox'])
  assert.equal(r.scanned, 6)
})

test('a folder without a log, a missing root and a log over the size cap are tolerated', async (t) => {
  const root = tmpRoot(t)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(root + '/--D-w--/empty-dir', { recursive: true })
  writeLog(root, 'big', cutOff(), { mtimeMs: NOW - 10 * 60_000 })
  assert.deepEqual(ids(await scan(root, { maxLogBytes: 10 })), [])
  assert.deepEqual(await scan(root + '/nope'), { ok: false, error: 'no-sessions-dir' })
})

test('without a zstd codec the scan fails as a whole (nothing is guessed)', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 'cut', cutOff(), { mtimeMs: NOW - 10 * 60_000 })
  assert.deepEqual(await scan(root, { unzip: null }), { ok: false, error: 'no-zstd' })
})

test('candidates are ordered oldest write first, like the queue', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 'b', cutOff(), { mtimeMs: NOW - 30 * 60_000 })
  writeLog(root, 'a', cutOff(), { mtimeMs: NOW - 60 * 60_000 })
  writeLog(root, 'c', cutOff(), { mtimeMs: NOW - 10 * 60_000, cwdDir: '--D-other--' })
  assert.deepEqual((await scan(root)).candidates.map((c) => c.sessionId), ['a', 'b', 'c'])
})
