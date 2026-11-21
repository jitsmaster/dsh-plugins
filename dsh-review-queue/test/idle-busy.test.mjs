import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createIdleAsker } from '../idle-ask.js'
import { createBusyTracker, logBusy } from '../idle-busy.js'

const H = 3600_000
const M = 60_000
const memIo = () => { const io = { text: undefined, read: () => io.text, write: (t) => { io.text = t } }; return io }
const S = (id, updatedAt, more = {}) => ({ sessionId: id, updatedAt, running: false, ...more })
const queued = (time) => [{ type: 'agent/inbox/spliced', time, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{}] } }]
const call = (id, time) => ({ type: 'assistant/message', time, data: { message: { content: [{ type: 'tool-call', id, name: 'pwsh' }] } } })

test('logBusy: an open turn, an unanswered tool call, a queued next-turn prompt or a live background job is busy', () => {
  const open = [{ type: 'turn/start', time: 100, data: { turn: 1 } }]
  assert.equal(logBusy(open, { startedAt: 0 }).busy, true)
  assert.equal(logBusy(open, { startedAt: 500 }).busy, false, 'an open turn from before the app started is a stale crash, not work')
  assert.equal(logBusy([call('c1', 100)], { startedAt: 0 }).busy, true)
  const queued = [{ type: 'agent/inbox/spliced', time: 100, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{}] } }]
  assert.equal(logBusy(queued, { startedAt: 0 }).busy, true)
  const job = [{ type: 'tool/result', time: 100, data: { content: 'started background job j1' } }]
  assert.equal(logBusy(job, { startedAt: 0 }).busy, true)
  const finished = [{ type: 'turn/start', time: 100, data: { turn: 1 } }, { type: 'turn/end', time: 200, data: { reason: { kind: 'completed' } } }]
  const r = logBusy(finished, { startedAt: 0 })
  assert.equal(r.busy, false)
  assert.equal(r.lastTime, 200)
})

test('tracker: running, running child, open question and open permission count as busy now; the idle start is the later of updatedAt and the last busy sample', async () => {
  let t = 10 * H
  const store = createStore()
  const tracker = createBusyTracker({ now: () => t, waitingOf: (id) => store.list({ status: 'open' }).some((i) => i.sessionId === id && (i.type === 'question' || i.type === 'permission')) })
  store.add({ type: 'question', sessionId: 'q', questions: [] })
  const items = [S('run', 1 * H, { running: true }), S('parent', 1 * H), S('kid', 1 * H, { running: true, parentSessionId: 'parent' }), S('q', 1 * H), S('quiet', 1 * H)]
  tracker.observe(items)
  for (const id of ['run', 'parent', 'q']) assert.equal(tracker.sinceOf(S(id, 1 * H)), 10 * H, id)
  assert.equal(tracker.sinceOf(S('quiet', 1 * H)), 1 * H)
  assert.equal(tracker.sinceOf(S('quiet', 11 * H)), 11 * H)
  t = 10 * H + 5 * M
  tracker.observe([S('run', 1 * H)]) // finished meanwhile
  assert.equal(tracker.sinceOf(S('run', 1 * H)), 10 * H, 'the clock starts at the last moment it was busy')
})

test('tracker.inspect: unreadable log is busy; a log with later activity moves the idle start; no readLog means no log check', async () => {
  const logs = { late: [{ type: 'turn/end', time: 9 * H, data: { reason: { kind: 'completed' } } }], work: queued(1) }
  const tracker = createBusyTracker({ now: () => 10 * H, readLog: async (id) => (logs[id] ? { records: logs[id] } : undefined) })
  assert.deepEqual(await tracker.inspect(S('late', 1 * H)), { busy: false, since: 9 * H })
  assert.equal((await tracker.inspect(S('work', 1 * H))).busy, true)
  assert.equal((await tracker.inspect(S('gone', 1 * H))).busy, true)
  const plain = createBusyTracker({ now: () => 10 * H })
  assert.deepEqual(await plain.inspect(S('x', 2 * H)), { busy: false, since: 2 * H })
})

const rig = (items, extra = {}) => {
  const prompts = []
  let t = 10 * H
  const asker = createIdleAsker({
    controllerOf: () => ({ list: async () => ({ items }), prompt: async (r) => { prompts.push(r) } }),
    registryOf: () => ({ archivedSessionIds: [] }), store: createStore(), now: () => t, io: memIo(), ...extra,
  })
  return { asker, prompts, setNow: (n) => { t = n } }
}

test('asker: the idle hour starts when the session last was busy, not at its last message', async () => {
  const items = [S('a', 1 * H, { running: true })]
  const r = rig(items)
  assert.deepEqual((await r.asker.check()).asked, [], 'running now')
  items[0].running = false
  r.setNow(10 * H + 30 * M)
  assert.deepEqual((await r.asker.check()).asked, [], 'only 30 min since it stopped')
  r.setNow(10 * H + 61 * M)
  assert.deepEqual((await r.asker.check()).asked, ['a'])
})

test('asker: log activity after the last message delays the ask; a busy log skips it', async () => {
  const logs = { late: [{ type: 'turn/end', time: 10 * H - 20 * M, data: { reason: { kind: 'completed' } } }], work: queued(1), old: [{ type: 'turn/end', time: 1 * H, data: { reason: { kind: 'completed' } } }] }
  const r = rig([S('late', 1 * H), S('work', 1 * H), S('old', 1 * H)], { readLog: async (id) => ({ records: logs[id] }) })
  const res = await r.asker.check()
  assert.deepEqual(res.asked, ['old'])
  assert.deepEqual(res.skipped, ['work'])
})

test('asker: a session that was busy again after being asked is asked again after the next full idle hour', async () => {
  const items = [S('a', 1 * H)]
  const r = rig(items)
  assert.deepEqual((await r.asker.check()).asked, ['a'])
  assert.deepEqual((await r.asker.check()).asked, [])
  items[0].running = true
  r.setNow(10 * H + 10 * M)
  await r.asker.check()
  items[0].running = false
  r.setNow(10 * H + 40 * M)
  assert.deepEqual((await r.asker.check()).asked, [])
  r.setNow(10 * H + 71 * M)
  assert.deepEqual((await r.asker.check()).asked, ['a'])
})

test('asker: answering an open question restarts the clock', async () => {
  const store = createStore()
  const r = rig([S('a', 1 * H)], { store })
  const q = store.add({ type: 'question', sessionId: 'a', questions: [] })
  assert.deepEqual((await r.asker.check()).asked, [])
  store.resolve(q.id ?? q, { kind: 'answered', by: 'card', answers: [] })
  r.setNow(10 * H + 30 * M)
  assert.deepEqual((await r.asker.check()).asked, [])
  r.setNow(10 * H + 61 * M)
  assert.deepEqual((await r.asker.check()).asked, ['a'])
})

test('asker: a PR-titled session is skipped when no PR guard answers, and asked when the guard says it is free', async () => {
  const items = [S('p', 1 * H, { projections: { values: { title: 'PR 6554' } } })]
  assert.deepEqual((await rig(items).asker.check()).asked, [])
  const free = rig(items, { prGuardOf: () => ({ check: async () => ({ protected: false }) }) })
  assert.deepEqual((await free.asker.check()).asked, ['p'])
})

test('resumer: shares the busy tracker, the idle half hour starts when the session last was busy', async () => {
  const { createIdleResumer } = await import('../idle-resume.js')
  const items = [S('a', 1 * H, { running: true })]
  let t = 10 * H
  const resumed = []
  const r = createIdleResumer({
    controllerOf: () => ({ list: async () => ({ items }), prompt: async (p) => { resumed.push(p.sessionId) } }),
    readLog: async () => ({ records: [{ type: 'turn/start', time: 1, data: { turn: 1 } }, { type: 'turn/end', time: 2, data: { reason: { kind: 'completed' } } }] }),
    judge: async () => ({ verdict: 'resume', reason: 'x' }), now: () => t, io: memIo(),
  })
  await r.check()
  items[0].running = false
  t = 10 * H + 10 * M
  await r.check()
  assert.deepEqual(resumed, [], 'only 10 min since it stopped')
  t = 10 * H + 31 * M
  await r.check()
  assert.deepEqual(resumed, ['a'])
})

test('asker: sessions whose log shows recent activity do not use up maxPerPass', async () => {
  const logs = { late: [{ type: 'turn/end', time: 10 * H - 5 * M, data: { reason: { kind: 'completed' } } }], old: [{ type: 'turn/end', time: 1 * H, data: { reason: { kind: 'completed' } } }] }
  const r = rig([S('late', 2 * H), S('old', 1 * H)], { maxPerPass: 1, readLog: async (id) => ({ records: logs[id] }) })
  assert.deepEqual((await r.asker.check()).asked, ['old'])
})

test('logBusy: only work records move lastTime, a title or metadata record does not', () => {
  const recs = [{ type: 'turn/end', time: 100, data: { reason: { kind: 'completed' } } }, { type: 'session/title', time: 900, data: { title: 'x' } }]
  assert.equal(logBusy(recs, { startedAt: 0 }).lastTime, 100)
})

test('asker.sample(): a busy state seen between two checks starts the idle clock', async () => {
  const items = [S('a', 1 * H, { running: true })]
  const r = rig(items)
  await r.asker.sample()
  items[0].running = false
  r.setNow(10 * H + 30 * M)
  assert.deepEqual((await r.asker.check()).asked, [])
  r.setNow(10 * H + 61 * M)
  assert.deepEqual((await r.asker.check()).asked, ['a'])
})

test('logBusy: an inbox entry from before the app started is stale, a malformed inserted list does not throw, a future record time is ignored', () => {
  const stale = [{ type: 'agent/inbox/spliced', time: 100, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{}] } }]
  assert.equal(logBusy(stale, { startedAt: 500 }).busy, false)
  const bad = [{ type: 'agent/inbox/spliced', time: 600, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: 5 } }]
  assert.doesNotThrow(() => logBusy(bad, { startedAt: 0 }))
  const future = [{ type: 'turn/end', time: 9e15, data: { reason: { kind: 'completed' } } }]
  assert.equal(logBusy(future, { startedAt: 0, now: () => 1000 }).lastTime, undefined)
})

test('tracker: busy marks of sessions that left the list are pruned', () => {
  let t = 10 * H
  const tracker = createBusyTracker({ now: () => t })
  tracker.observe([S('gone', 1 * H, { running: true })])
  tracker.observe([S('other', 1 * H)])
  assert.equal(tracker.sinceOf(S('gone', 1 * H)), 1 * H)
})

test('asker.sample(): overlapping samples share one list call', async () => {
  let calls = 0
  const r = rig([S('a', 1 * H)], { controllerOf: () => ({ list: async () => { calls++; await new Promise((x) => setTimeout(x, 20)); return { items: [] } }, prompt: async () => {} }) })
  await Promise.all([r.asker.sample(), r.asker.sample()])
  assert.equal(calls, 1)
})

test('asker: sessions that are busy in their log do not starve older idle ones', async () => {
  const work = queued(10 * H - 1)
  const idleLog = [{ type: 'turn/end', time: 1 * H, data: { reason: { kind: 'completed' } } }]
  const items = [S('b1', 5 * H), S('b2', 5 * H - 1), S('b3', 5 * H - 2), S('b4', 5 * H - 3), S('b5', 5 * H - 4), S('old', 1 * H)]
  const r = rig(items, { maxPerPass: 1, readLog: async (id) => ({ records: id === 'old' ? idleLog : work }) })
  assert.deepEqual((await r.asker.check()).asked, ['old'])
})

test('asker: an idle state asked before the upgrade (keyed on updatedAt) is not asked again', async () => {
  const io = memIo()
  io.text = JSON.stringify({ v: 1, items: { a: { updatedAt: 1 * H, at: 10 * H - 30 * M } } })
  const log = [{ type: 'turn/end', time: 1 * H + 5000, data: { reason: { kind: 'completed' } } }]
  const r = rig([S('a', 1 * H)], { io, readLog: async () => ({ records: log }) })
  assert.deepEqual((await r.asker.check()).asked, [])
})

test('asker: an already-asked session is not log-read again on the next pass', async () => {
  const reads = []
  const log = [{ type: 'turn/end', time: 1 * H + 5000, data: { reason: { kind: 'completed' } } }]
  const r = rig([S('a', 1 * H)], { readLog: async (id) => { reads.push(id); return { records: log } } })
  assert.deepEqual((await r.asker.check()).asked, ['a'])
  const before = reads.length
  await r.asker.check()
  assert.equal(reads.length, before)
})

test('logBusy: an open turn or unanswered call in a session that is not running is a cut-off, not work (running defaults to true)', () => {
  const open = [{ type: 'turn/start', time: 100, data: { turn: 1 } }]
  assert.equal(logBusy(open, { startedAt: 0, running: false }).busy, false)
  assert.equal(logBusy([call('c1', 100)], { startedAt: 0, running: false }).busy, false)
  assert.equal(logBusy(open, { startedAt: 0, running: false }).lastTime, 100, 'the idle clock still starts at its last record')
  assert.equal(logBusy(open, { startedAt: 0 }).busy, true, 'default keeps the old behaviour')
  assert.equal(logBusy(open, { startedAt: 0, running: true }).busy, true)
  assert.equal(logBusy(queued(100), { startedAt: 0, running: false }).busy, true, 'a queued prompt is still work')
  const job = [{ type: 'tool/result', time: 100, data: { content: 'started background job j1' } }]
  assert.equal(logBusy(job, { startedAt: 0, running: false }).busy, true, 'a live background job is still work')
})

test('tracker.inspect: a not-running session with an open turn in its log is not busy and its idle start is the last record', async () => {
  const open = [{ type: 'turn/start', time: 2 * H, data: { turn: 1 } }, call('c', 2 * H + 1)]
  const tracker = createBusyTracker({ now: () => 10 * H, readLog: async () => ({ records: open }) })
  assert.deepEqual(await tracker.inspect(S('cut', 1 * H)), { busy: false, since: 2 * H + 1 })
  assert.equal((await tracker.inspect(S('live', 1 * H, { running: true }))).busy, true)
})

test('asker: a session cut off in an open turn (not running) is asked once its hour is up, not skipped as busy until restart', async () => {
  const open = [{ type: 'turn/start', time: 1 * H, data: { turn: 1 } }, call('c', 1 * H + 1)]
  const r = rig([S('cut', 1 * H)], { readLog: async () => ({ records: open }) })
  const res = await r.asker.check()
  assert.deepEqual(res.asked, ['cut'])
  assert.deepEqual(res.skipped, [])
})