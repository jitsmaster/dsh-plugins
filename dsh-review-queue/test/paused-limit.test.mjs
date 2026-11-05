import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyLog, reasonText, scanSessionLogs, createPausedTracker, createDismissals, STALE_MS } from '../paused.js'
import { log, tmpRoot, writeLog } from './paused-helpers.mjs'

// Sessions stopped by the Claude subscription session limit: kind 'limit' on the paused items.
const SESSION_MSG = "Claude Code failed (success: You've hit your session limit · resets 1pm (America/Los_Angeles))"
const limitEnd = (message = SESSION_MSG, code = 'PROVIDER_ERROR') => ({ kind: 'error', error: { code, message } })
const ended = (reason) => [log.head(), log.turnStart(1), log.user('hi'), log.assistant('hello'), log.turnEnd(1, reason)]

test('limit: a last turn/end error with the session-limit message (PROVIDER_ERROR) is kind limit with the reset text', () => {
  const c = classifyLog(ended(limitEnd()))
  assert.deepEqual(c.kinds, ['limit'])
  assert.equal(c.limitResetText, '1pm (America/Los_Angeles)')
})

test('limit: QUOTA code and the usage/weekly/5-hour/opus messages are limit stops', () => {
  assert.deepEqual(classifyLog(ended(limitEnd('whatever', 'QUOTA'))).kinds, ['limit'])
  assert.equal(classifyLog(ended(limitEnd('whatever', 'QUOTA'))).limitResetText, undefined)
  for (const m of ['usage limit reached', 'Weekly limit reached', 'You hit the 5-hour limit', 'Opus limit reached']) {
    assert.deepEqual(classifyLog(ended(limitEnd(m))).kinds, ['limit'], m)
  }
})

test('limit: the reset text is short and plain: a long or odd zone part is dropped, never carried onto the card', () => {
  const long = `Claude Code failed (success: You've hit your session limit · resets 1pm (${'x'.repeat(200)}))`
  assert.equal(classifyLog(ended(limitEnd(long))).limitResetText, '1pm')
  const odd = "You've hit your session limit · resets 1pm (<b>boom</b>)"
  assert.equal(classifyLog(ended(limitEnd(odd))).limitResetText, '1pm')
  assert.equal(classifyLog(ended(limitEnd(SESSION_MSG))).limitResetText, '1pm (America/Los_Angeles)')
})

test('limit: "usage limit reached|<epoch seconds>" gives the epoch as an ISO string', () => {
  const c = classifyLog(ended(limitEnd('Claude AI usage limit reached|1800000000', 'QUOTA')))
  assert.deepEqual(c.kinds, ['limit'])
  assert.equal(c.limitResetText, new Date(1_800_000_000_000).toISOString())
})

test('limit: a plain 429 RATE_LIMIT, overload, SERVER errors and ordinary ends are not limit stops', () => {
  const rate = limitEnd("This request would exceed your account's rate limit. Please try again later.", 'RATE_LIMIT')
  for (const r of [rate, limitEnd('Overloaded', 'SERVER'), { kind: 'error', error: { message: 'Overloaded' } }, { kind: 'completed' }]) {
    const c = classifyLog(ended(r))
    assert.deepEqual(c.kinds, [], JSON.stringify(r))
    assert.equal(c.limitResetText, undefined)
  }
})

test('limit: an earlier limit error followed by a later successful turn (or an open turn) is not limit', () => {
  const first = ended(limitEnd())
  assert.deepEqual(classifyLog([...first, log.turnStart(2), log.turnEnd(2)]).kinds, [])
  assert.deepEqual(classifyLog([...first, log.turnStart(2)]).kinds, ['open-turn'])
})

test('reasonText: limit says Stopped by the Claude usage limit, with the reset text when known', () => {
  assert.equal(reasonText({ kinds: ['limit'], pending: 0 }), 'Stopped by the Claude usage limit')
  assert.equal(reasonText({ kinds: ['limit'], pending: 0, limitResetText: '1pm (America/Los_Angeles)' }), 'Stopped by the Claude usage limit (resets 1pm (America/Los_Angeles))')
  assert.equal(reasonText({ kinds: ['limit', 'torn'], pending: 0, limitResetText: '7pm' }), 'Stopped by the Claude usage limit (resets 7pm); The log ends in a half-written entry')
})

test('scan: a limit-stopped session is listed with kinds and limitResetText; not when fresh, live, or a subagent', async (t) => {
  const root = tmpRoot(t)
  const now = 10_000_000_000
  writeLog(root, 'old', [ended(limitEnd())], { mtimeMs: now - STALE_MS - 5000 })
  writeLog(root, 'fresh', [ended(limitEnd())], { mtimeMs: now - 1000 })
  writeLog(root, 'live', [ended(limitEnd())], { mtimeMs: now - STALE_MS - 5000 })
  writeLog(root, 'sub', [[log.head({ origin: 'subagent' }), log.turnStart(1), log.turnEnd(1, limitEnd())]], { mtimeMs: now - STALE_MS - 5000 })
  const r = await scanSessionLogs({ root, now, startedAt: now - 3_600_000, liveIds: new Set(['live']) })
  assert.deepEqual(r.candidates.map((c) => c.sessionId), ['old'])
  assert.deepEqual(r.candidates[0].kinds, ['limit'])
  assert.equal(r.candidates[0].limitResetText, '1pm (America/Los_Angeles)')
  assert.match(r.candidates[0].reason, /usage limit/)
})

test('tracker: the item payload carries limitResetText, updates when it changes, and resolves as recovered when gone', async () => {
  const items = []
  let n = 0
  const store = {
    list: () => items.filter((i) => i.status === 'open'),
    add: (i) => { items.push({ ...i, id: 'i' + ++n, status: 'open' }) },
    update: (id, p) => { Object.assign(items.find((i) => i.id === id), p) },
    resolve: (id) => { items.find((i) => i.id === id).status = 'done'; return true },
  }
  let cands = [{ sessionId: 's1', cwd: 'D:/w', title: 'T', lastWrite: 5, kinds: ['limit'], reason: 'r', turn: 1, danglingCalls: [], pending: 0, lastUser: '', lastAssistant: '', limitResetText: '1pm' }]
  const tracker = createPausedTracker({ store, scan: async () => ({ ok: true, candidates: cands }), dismissals: createDismissals() })
  assert.equal((await tracker.scan()).added, 1)
  assert.equal(items[0].payload.limitResetText, '1pm')
  cands = [{ ...cands[0], limitResetText: '7pm' }]
  assert.equal((await tracker.scan()).updated, 1)
  assert.equal(items[0].payload.limitResetText, '7pm')
  cands = []
  assert.equal((await tracker.scan()).resolved, 1)
})
