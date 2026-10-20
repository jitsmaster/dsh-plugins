import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { RESUME_CONCURRENCY } from '../paused.js'

// The overlay side of paused sessions: labels, counts, the card facts, "Resume all" (confirm, then 3 at a time) and the routes it calls.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')
function load({ fetchImpl, date, abortSignal } = {}) {
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, AbortSignal: abortSignal ?? AbortSignal, ...(date ? { Date: date } : {}), fetch: fetchImpl ?? (() => new Promise(() => {})),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const mod = registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
  return { mod, T: mod.__test, shared: mod.shared }
}
const plain = (x) => JSON.parse(JSON.stringify(x))
const paused = (id, over = {}) => ({ id, type: 'paused', status: 'open', sessionId: 's-' + id, sessionTitle: 'Work ' + id, createdAt: 10, payload: { lastWrite: 1000, kinds: ['open-turn'], reason: 'Cut off in the middle of a turn', danglingCalls: [], lastUser: '' }, ...over })

test('the labels, the filter chip and the resolution lines', () => {
  const { T } = load()
  assert.equal(T.typeLabel('paused'), 'Paused')
  assert.ok(T.FILTER_TYPES.includes('paused'))
  assert.equal(T.resolutionText({ type: 'paused', resolution: { kind: 'resumed', by: 'card' } }), 'Resumed')
  assert.equal(T.resolutionText({ type: 'paused', resolution: { kind: 'dismissed', by: 'card' } }), 'Dismissed')
  assert.equal(T.resolutionText({ type: 'paused', resolution: { kind: 'recovered', by: 'scan' } }), 'No longer cut off (it continued or ended)')
})

test('paused items are not "waiting on you"; pausedCount counts the open ones', () => {
  const { T, shared } = load()
  const open = [paused('a'), paused('b'), { type: 'completed' }, { type: 'todo', state: 'starting' }]
  assert.equal(T.waitingCount(open), 1)
  assert.equal(shared.pausedCount(open), 2)
  assert.equal(shared.pausedCount(undefined), 0)
})

test('errors: the words for a session DSH no longer has and for a wrong item', () => {
  const { T } = load()
  assert.match(T.errorText(409, { error: 'session-gone' }), /no longer exists/)
  assert.match(T.errorText(409, { error: 'not-paused' }), /paused session/)
  assert.match(T.errorText(409, { error: 'no-scanner' }), /scan/i)
})

test('pausedFacts: why, how long ago, a tool call that may be half done, the last request', () => {
  const { shared } = load()
  const item = paused('a', { payload: { lastWrite: 1000, kinds: ['open-turn'], reason: 'Cut off in the middle of a turn', danglingCalls: ['shell', 'apply_patch'], lastUser: 'fix the build' } })
  assert.deepEqual(plain(shared.pausedFacts(item, 1000 + 12 * 60_000)), [
    'Cut off in the middle of a turn',
    'Last activity 12 min ago',
    'The last tool call had no result and may be half done: shell, apply_patch',
    'Last request: fix the build',
  ])
  assert.deepEqual(plain(shared.pausedFacts(paused('b', { payload: {} }), 5000)), ['Cut off by a restart or crash', 'Last activity just now'])
})

test('Resume all asks first: the text names the count and the pace; one session is asked about without a pace', () => {
  const { T } = load()
  assert.equal(T.RESUME_AT_A_TIME, RESUME_CONCURRENCY, 'the overlay and the plugin agree on 3')
  assert.equal(T.resumeAllText(12), 'Resume all 12 paused sessions, 3 at a time? Each one gets the standard resume prompt.')
  assert.equal(T.resumeAllText(1), 'Resume 1 paused session? It gets the standard resume prompt.')
})

test('settledAfter: a resumed session is done working when it has a new done, question or permission item', () => {
  const { T } = load()
  const item = paused('a')
  const snap = (open = [], resolved = []) => ({ open, resolved })
  const mk = (type, createdAt, sessionId = item.sessionId) => ({ id: 'x' + createdAt, type, sessionId, createdAt })
  assert.equal(T.settledAfter(snap(), item, 100), false)
  for (const type of ['completed', 'question', 'permission']) assert.equal(T.settledAfter(snap([mk(type, 150)]), item, 100), true, type)
  assert.equal(T.settledAfter(snap([], [mk('completed', 150)]), item, 100), true, 'a hidden no-action result is in resolved')
  assert.equal(T.settledAfter(snap([mk('completed', 50)]), item, 100), false, 'older than the resume')
  assert.equal(T.settledAfter(snap([mk('completed', 150, 'other')]), item, 100), false, 'another session')
  assert.equal(T.settledAfter(snap([mk('pr-merged', 150)]), item, 100), false)
  assert.equal(T.settledAfter(null, item, 100), false)
})

// ---- runResumeAll ----------------------------------------------------------------------------------------------------------------------

const gate = () => { let go; const p = new Promise((r) => { go = r }); return { p, go } }

test('runResumeAll keeps at most 3 sessions working at a time and starts the next as one settles', async () => {
  const { T } = load()
  const items = ['a', 'b', 'c', 'd', 'e'].map((id) => paused(id))
  const gates = Object.fromEntries(items.map((i) => [i.id, gate()]))
  const started = []
  let working = 0
  let peak = 0
  const progress = []
  const run = T.runResumeAll({
    items, limit: 3,
    resume: async (item) => { started.push(item.id); working++; peak = Math.max(peak, working); return { ok: true } },
    settled: async (item) => { await gates[item.id].p; working-- },
    onProgress: (p) => progress.push(plain(p)),
  })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(started, ['a', 'b', 'c'])
  gates.b.go()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(started, ['a', 'b', 'c', 'd'])
  gates.a.go(); gates.c.go(); gates.d.go(); gates.e.go()
  const result = await run
  assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e'])
  assert.equal(peak, 3)
  assert.deepEqual(plain(result), { total: 5, started: 5, ok: 5, failed: [], cancelled: false })
  assert.deepEqual(progress.at(-1), { total: 5, started: 5, ok: 5, failed: 0, running: 0, waiting: 0 })
})

test('runResumeAll: a refused resume frees its slot at once, is reported, and the rest go on', async () => {
  const { T } = load()
  const items = ['a', 'b', 'c', 'd'].map((id) => paused(id))
  const waited = []
  const result = await T.runResumeAll({
    items, limit: 2,
    resume: async (item) => (item.id === 'a' ? { ok: false, error: 'session-gone' } : { ok: true }),
    settled: async (item) => { waited.push(item.id) },
  })
  assert.deepEqual(plain(result), { total: 4, started: 4, ok: 3, failed: [{ id: 'a', error: 'session-gone' }], cancelled: false })
  assert.deepEqual(waited.sort(), ['b', 'c', 'd'], 'a refused one is not waited for')
})

test('runResumeAll: stopping (abort) starts no new session; those already working are left alone', async () => {
  const { T } = load()
  const items = ['a', 'b', 'c', 'd'].map((id) => paused(id))
  const ac = new AbortController()
  const started = []
  const run = T.runResumeAll({
    items, limit: 1, signal: ac.signal,
    resume: async (item) => { started.push(item.id); ac.abort(); return { ok: true } },
    settled: async () => {},
  })
  const result = await run
  assert.deepEqual(started, ['a'])
  assert.deepEqual(plain(result), { total: 4, started: 1, ok: 1, failed: [], cancelled: true })
})

test('runResumeAll gives up on a session that never settles after the slot time, so one stuck session cannot block the rest', async () => {
  const { T } = load()
  const items = ['a', 'b'].map((id) => paused(id))
  const started = []
  const result = await T.runResumeAll({
    items, limit: 1, slotMs: 20,
    resume: async (item) => { started.push(item.id); return { ok: true } },
    settled: () => new Promise(() => {}),
  })
  assert.deepEqual(started, ['a', 'b'])
  assert.equal(result.ok, 2)
})

// ---- a place is also freed when the session is no longer running (poll) ----------------------------------------------------------------

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)) }
/** A manual clock: sleep(ms, signal) waits for advance(); an aborted sleep is dropped. */
function fakeClock() {
  let t = 0
  const timers = []
  return {
    now: () => t,
    sleep: (ms, signal) => new Promise((resolve) => {
      const e = { at: t + ms, resolve }
      timers.push(e)
      if (signal) signal.addEventListener('abort', () => { const i = timers.indexOf(e); if (i >= 0) timers.splice(i, 1); resolve() }, { once: true })
    }),
    pending: () => timers.length,
    async advance(ms) {
      const end = t + ms
      for (;;) {
        await flush()
        const due = timers.filter((e) => e.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers.splice(timers.indexOf(due), 1)
        t = Math.max(t, due.at)
        due.resolve()
      }
      t = end
      await flush()
    },
  }
}
const four = () => ['a', 'b', 'c', 'd'].map((id) => paused(id))
const never = () => new Promise(() => {})

test('RESUME_SLOT_MS is 2 minutes (the last resort), and the poll defaults are 3 s with a 30 s start grace', () => {
  const { T } = load()
  assert.equal(T.RESUME_SLOT_MS, 2 * 60 * 1000)
  assert.equal(T.RESUME_POLL_MS, 3000)
  assert.equal(T.RESUME_GRACE_MS, 30000)
})

test('REGRESSION: 4 paused sessions that end without a settled item: the 4th starts once polling shows the others stopped, not only after the slot time', { timeout: 5000 }, async () => {
  const { T } = load()
  const clock = fakeClock()
  const started = []
  const run = T.runResumeAll({
    items: four(), limit: 3, sleep: clock.sleep, // slotMs stays the default
    resume: async (item) => { started.push(item.id); return { ok: true } },
    settled: never, // the done card of a session that ends quietly is hidden: no settled item ever shows
    poll: async () => 'stopped',
  })
  await clock.advance(29_000)
  assert.deepEqual(started, ['a', 'b', 'c'], 'the 4th waits for a free place')
  await clock.advance(10_000)
  assert.deepEqual(started, ['a', 'b', 'c', 'd'], 'a place was freed long before ' + T.RESUME_SLOT_MS + ' ms')
  await clock.advance(60_000)
  assert.equal((await run).ok, 4)
})

test('runResumeAll frees a place when two consecutive polls after the grace do not list the session', { timeout: 5000 }, async () => {
  const { T } = load()
  const clock = fakeClock()
  const started = []
  const polls = []
  const run = T.runResumeAll({
    items: four(), limit: 3, sleep: clock.sleep, pollMs: 3000, graceMs: 30000, slotMs: 600_000,
    resume: async (item) => { started.push(item.id); return { ok: true } },
    settled: (item) => (item.id === 'd' ? Promise.resolve() : never()),
    poll: async (item) => { polls.push([item.id, clock.now()]); return 'stopped' },
  })
  await clock.advance(29_999)
  assert.deepEqual(polls, [], 'no poll during the start grace')
  await clock.advance(1)
  assert.deepEqual(started, ['a', 'b', 'c'], 'one poll that says stopped is not enough')
  await clock.advance(2_999)
  assert.deepEqual(started, ['a', 'b', 'c'])
  await clock.advance(1)
  assert.deepEqual(started, ['a', 'b', 'c', 'd'], 'the second one frees the place (30 s + 3 s)')
  assert.deepEqual(polls.filter(([id]) => id === 'a').map(([, at]) => at), [30000, 33000])
  await run
})

test('runResumeAll: a poll that lists the session starts the count again, so only two in a row free the place', { timeout: 5000 }, async () => {
  const { T } = load()
  const clock = fakeClock()
  const started = []
  const answers = ['stopped', 'running', 'stopped', 'stopped']
  let n = 0
  T.runResumeAll({
    items: [paused('a'), paused('b')], limit: 1, sleep: clock.sleep, pollMs: 100, graceMs: 100, slotMs: 600_000,
    resume: async (item) => { started.push(item.id); return { ok: true } },
    settled: never,
    poll: async () => answers[n++] ?? 'stopped',
  })
  await clock.advance(300)
  assert.deepEqual(started, ['a'], 'stopped, running, stopped: not yet')
  await clock.advance(100)
  assert.deepEqual(started, ['a', 'b'], 'stopped, running, stopped, stopped')
})

test('runResumeAll: a failed poll (unknown or a throw) never frees the place; the slot time still does', { timeout: 5000 }, async () => {
  const { T } = load()
  const clock = fakeClock()
  const started = []
  let n = 0
  const run = T.runResumeAll({
    items: [paused('a'), paused('b')], limit: 1, sleep: clock.sleep, pollMs: 1000, graceMs: 1000, slotMs: 60_000,
    resume: async (item) => { started.push(item.id); return { ok: true } },
    settled: never,
    poll: async () => { if (n++ % 2) throw new Error('network'); return 'unknown' },
  })
  await clock.advance(59_000)
  assert.deepEqual(started, ['a'], 'many failed polls, still held')
  assert.ok(n > 30, 'it kept polling')
  await clock.advance(1_000)
  assert.deepEqual(started, ['a', 'b'], 'freed by the slot time')
  await clock.advance(60_000)
  assert.equal((await run).ok, 2)
})

test('runResumeAll: a place freed by the settled item stops its polling at once', { timeout: 5000 }, async () => {
  const { T } = load()
  const clock = fakeClock()
  const polls = []
  let settle
  const run = T.runResumeAll({
    items: [paused('a')], limit: 1, sleep: clock.sleep, pollMs: 1000, graceMs: 1000, slotMs: 600_000,
    resume: async () => ({ ok: true }),
    settled: () => new Promise((r) => { settle = r }),
    poll: async (item) => { polls.push(item.id); return 'running' },
  })
  await clock.advance(3_500)
  assert.equal(polls.length, 3)
  settle()
  await run
  await clock.advance(30_000)
  assert.equal(polls.length, 3, 'no poll after the place was freed')
  assert.equal(clock.pending(), 0, 'no timer left behind (slot time included)')
})

test('runResumeAll: Stop (abort) ends the polling and starts nothing new', { timeout: 5000 }, async () => {
  const { T } = load()
  const clock = fakeClock()
  const ac = new AbortController()
  const started = []
  const polls = []
  const run = T.runResumeAll({
    items: four(), limit: 3, signal: ac.signal, sleep: clock.sleep, pollMs: 1000, graceMs: 1000, slotMs: 600_000,
    resume: async (item) => { started.push(item.id); return { ok: true } },
    settled: never,
    poll: async (item) => { polls.push(item.id); return 'running' },
  })
  await clock.advance(2_500)
  const before = polls.length
  assert.ok(before > 0)
  ac.abort()
  const result = await run
  await clock.advance(60_000)
  assert.equal(polls.length, before, 'no poll after Stop')
  assert.deepEqual(started, ['a', 'b', 'c'])
  assert.equal(result.cancelled, true)
  assert.equal(clock.pending(), 0)
})

test('runResumeAll polls with one request at a time per place, and never has more than 3 working', { timeout: 5000 }, async () => {
  const { T } = load()
  const clock = fakeClock()
  const items = ['a', 'b', 'c', 'd', 'e'].map((id) => paused(id))
  let working = 0
  let peak = 0
  const inFlight = {}
  let overlap = false
  const gates = Object.fromEntries(items.map((i) => [i.id, gate()]))
  const polls = []
  const run = T.runResumeAll({
    items, limit: 3, sleep: clock.sleep, pollMs: 1000, graceMs: 1000, slotMs: 600_000,
    resume: async (item) => { working++; peak = Math.max(peak, working); return { ok: true } },
    settled: async (item) => { await gates[item.id].p; working-- },
    poll: async (item) => {
      polls.push(item.id)
      if (inFlight[item.id]) overlap = true
      inFlight[item.id] = true
      await clock.sleep(2500) // a slow answer, longer than the poll interval
      inFlight[item.id] = false
      return 'running'
    },
  })
  await clock.advance(20_000)
  assert.ok(polls.length >= 3 * 4, 'the three places keep polling: ' + polls.length)
  assert.deepEqual([...new Set(polls)].sort(), ['a', 'b', 'c'], 'only the three places that are held are polled')
  gates.a.go()
  await clock.advance(20_000)
  assert.ok(polls.includes('d'), 'd got the place and is polled')
  for (const g of Object.values(gates)) g.go()
  await clock.advance(20_000)
  const total = polls.length
  await clock.advance(60_000)
  assert.equal(polls.length, total, 'nothing is polled once every place is freed')
  assert.equal(overlap, false, 'never two requests at once for one place')
  assert.ok(peak <= 3, 'peak ' + peak)
  assert.equal((await run).ok, 5)
})

test('runResumeAll without a poll behaves as before (settled item or slot time only)', { timeout: 5000 }, async () => {
  const { T } = load()
  const started = []
  const result = await T.runResumeAll({
    items: [paused('a'), paused('b')], limit: 1, slotMs: 20,
    resume: async (item) => { started.push(item.id); return { ok: true } },
    settled: () => new Promise(() => {}),
  })
  assert.deepEqual(started, ['a', 'b'])
  assert.equal(result.ok, 2)
})

test('runResumeAll progress carries waiting: the sessions that have not been given a place yet', { timeout: 5000 }, async () => {
  const { T } = load()
  const clock = fakeClock()
  const progress = []
  const run = T.runResumeAll({
    items: ['a', 'b', 'c', 'd', 'e'].map((id) => paused(id)), limit: 3, sleep: clock.sleep, pollMs: 1000, graceMs: 1000, slotMs: 600_000,
    resume: async () => ({ ok: true }),
    settled: never,
    poll: async () => 'stopped',
    onProgress: (p) => progress.push(plain(p)),
  })
  await clock.advance(1_500)
  const full = progress.find((p) => p.started === 3 && p.running === 3)
  assert.deepEqual([full.total, full.started, full.running, full.waiting], [5, 3, 3, 2], 'three working, two waiting for a place')
  assert.deepEqual(progress[0], { total: 5, started: 1, ok: 0, failed: 0, running: 1, waiting: 4 })
  await clock.advance(10_000)
  await run
  assert.deepEqual(progress.at(-1), { total: 5, started: 5, ok: 5, failed: 0, running: 0, waiting: 0 })
})

test('resumeProgressText says how many sessions wait for a place', () => {
  const { T } = load()
  assert.equal(T.resumeProgressText({ total: 5, started: 3, running: 3, waiting: 2 }), 'Resuming: 3 of 5 started, 3 working, 2 waiting for a place…')
  assert.equal(T.resumeProgressText({ total: 5, started: 5, running: 2, waiting: 0 }), 'Resuming: 5 of 5 started, 2 working…')
  assert.equal(T.resumeProgressText({ total: 5, started: 0, running: 0 }), 'Resuming: 0 of 5 started, 0 working…', 'an older progress object has no waiting')
})

/** A Date whose now() is set by the test: pollRunning shares one answer for a moment, so the tests move the clock between different answers. */
function fakeDate() {
  const c = { t: 1_000_000 }
  return { c, Date: class extends Date { static now() { return c.t } } }
}

test('pollRunning asks POST /v1/running-sessions: listed = running, not listed = stopped, any failure = unknown', { timeout: 5000 }, async () => {
  const seen = []
  const d = fakeDate()
  const answer = { current: { ok: true, status: 200, json: async () => ({ ok: true, ids: ['s-a'] }) } }
  const { T } = load({ date: d.Date, fetchImpl: async (url, init) => { seen.push([url, init.method]); if (answer.current instanceof Error) throw answer.current; return answer.current } })
  assert.equal(await T.pollRunning(paused('a')), 'running')
  assert.equal(await T.pollRunning(paused('b')), 'stopped')
  assert.deepEqual(seen[0], ['/review-queue/v1/running-sessions', 'POST'])
  for (const [next, expected, why] of [
    [{ ok: false, status: 409, json: async () => ({ ok: false, error: 'no-controller' }) }, 'unknown', 'an error answer'],
    [{ ok: true, status: 200, json: async () => ({ ok: false, error: 'cannot list sessions: x' }) }, 'unknown', 'ok:false in the body'],
    [{ ok: true, status: 200, json: async () => ({ ok: true }) }, 'unknown', 'no ids'],
    [new Error('offline'), 'unknown', 'a network failure'],
  ]) {
    answer.current = next
    d.c.t += 10_000
    assert.equal(await T.pollRunning(paused('b')), expected, why)
  }
})

test('pollRunning: a session of another app (hub item whose owner is not this app) is never "stopped"', { timeout: 5000 }, async () => {
  const ids = []
  const d = fakeDate()
  const { T } = load({ date: d.Date, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ids: [...ids], instanceId: 'me' }) }) })
  assert.equal(await T.pollRunning(paused('a', { owner: 'other' })), 'unknown', 'owned by another app')
  assert.equal(await T.pollRunning(paused('a', { owner: 'me' })), 'stopped', 'owned by this app and not running')
  assert.equal(await T.pollRunning(paused('a')), 'stopped', 'no owner (standalone): this app')
  ids.push('s-a')
  d.c.t += 10_000
  assert.equal(await T.pollRunning(paused('a', { owner: 'me' })), 'running')
  const old = load({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ids: [] }) }) })
  assert.equal(await old.T.pollRunning(paused('a', { owner: 'x' })), 'unknown', 'an owner and no instanceId in the answer: cannot tell')
})

test('pollRunning: the three lanes polling at the same moment share ONE request (one controller list, not three)', { timeout: 5000 }, async () => {
  const d = fakeDate()
  let requests = 0
  let release
  const slow = new Promise((r) => { release = r })
  const { T } = load({ date: d.Date, fetchImpl: async () => { requests++; await slow; return { ok: true, status: 200, json: async () => ({ ok: true, ids: ['s-b'] }) } } })
  const lanes = ['a', 'b', 'c'].map((id) => T.pollRunning(paused(id)))
  d.c.t += 5_000 // still in flight: a late lane joins the same request
  lanes.push(T.pollRunning(paused('a')))
  release()
  assert.deepEqual(await Promise.all(lanes), ['stopped', 'running', 'stopped', 'stopped'])
  assert.equal(requests, 1)
})

test('pollRunning: an answer is shared for half a poll interval only; the next poll of a lane (a full interval later) asks again, and a failed answer is not kept', { timeout: 5000 }, async () => {
  const d = fakeDate()
  let requests = 0
  let fail = false
  const { T } = load({ date: d.Date, fetchImpl: async () => { requests++; if (fail) throw new Error('offline'); return { ok: true, status: 200, json: async () => ({ ok: true, ids: [] }) } } })
  await T.pollRunning(paused('a'))
  d.c.t += 1_000
  await T.pollRunning(paused('b'))
  assert.equal(requests, 1, 'a lane a second behind reuses the answer')
  d.c.t += 2_000 // 3 s after the first request: the next poll of lane a
  await T.pollRunning(paused('a'))
  assert.equal(requests, 2, 'two polls of one lane never come from one answer')
  d.c.t += 10_000
  fail = true
  assert.equal(await T.pollRunning(paused('a')), 'unknown')
  fail = false
  assert.equal(await T.pollRunning(paused('b')), 'stopped', 'the failure was not reused')
  assert.equal(requests, 4)
})

test('pollRunning gives up on a request that hangs (10 s): the poll is "unknown" and the shared in-flight call is cleared for the next lane', { timeout: 5000 }, async () => {
  const d = fakeDate()
  const timeouts = []
  const ac = new AbortController()
  let requests = 0
  const hang = (url, init) => new Promise((resolve, reject) => {
    requests++
    if (requests > 1) return resolve({ ok: true, status: 200, json: async () => ({ ok: true, ids: [] }) })
    init.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
  })
  const { T } = load({ date: d.Date, fetchImpl: hang, abortSignal: { timeout: (ms) => { timeouts.push(ms); return ac.signal } } })
  const first = T.pollRunning(paused('a'))
  const joined = T.pollRunning(paused('b'))
  assert.deepEqual(timeouts, [10_000], 'one request, with a 10 s limit')
  ac.abort()
  assert.deepEqual(await Promise.all([first, joined]), ['unknown', 'unknown'])
  assert.equal(await T.pollRunning(paused('a')), 'stopped', 'the next poll asks again at once, not a hung answer')
  assert.equal(requests, 2)
})

test('sleepFor: an already aborted signal returns at once; a timer that fires leaves no abort listener behind; an abort ends the wait early', { timeout: 5000 }, async () => {
  const { T } = load()
  const listeners = new Set()
  const signal = { aborted: false, addEventListener: (_t, fn) => listeners.add(fn), removeEventListener: (_t, fn) => listeners.delete(fn) }
  await T.sleepFor(5, signal)
  assert.equal(listeners.size, 0, 'no listener after a normal timer')
  const early = T.sleepFor(60_000, signal)
  assert.equal(listeners.size, 1)
  ;[...listeners][0]()
  await early
  assert.equal(listeners.size, 0, 'an abort removes it too')
  const t0 = Date.now()
  await T.sleepFor(60_000, { aborted: true, addEventListener() { throw new Error('must not listen') }, removeEventListener() {} })
  assert.ok(Date.now() - t0 < 1000, 'returned at once')
})

test('fetchRunning shares an answer for half a poll interval after it COMPLETED (a slow request does not shorten it), and a clock that steps back expires it', { timeout: 5000 }, async () => {
  const d = fakeDate()
  let requests = 0
  const { T } = load({ date: d.Date, fetchImpl: async () => { requests++; d.c.t += 4_000; return { ok: true, status: 200, json: async () => ({ ok: true, ids: [] }) } } })
  await T.pollRunning(paused('a'))
  const doneAt = d.c.t
  d.c.t = doneAt + 1_499
  await T.pollRunning(paused('b'))
  assert.equal(requests, 1, 'within 1.5 s of the completion')
  d.c.t = doneAt + 1_500
  await T.pollRunning(paused('b'))
  assert.equal(requests, 2, 'older than 1.5 s: asks again')
  const again = d.c.t
  d.c.t = again - 10_000 // the clock stepped back: a negative age is expired
  await T.pollRunning(paused('b'))
  assert.equal(requests, 3)
})

test('pollRunning: once this app\'s instanceId is known (first answer of the run), an item of another app is not worth a request', { timeout: 5000 }, async () => {
  const d = fakeDate()
  let requests = 0
  const { T } = load({ date: d.Date, fetchImpl: async () => { requests++; return { ok: true, status: 200, json: async () => ({ ok: true, ids: ['s-a'], instanceId: 'me' }) } } })
  assert.equal(await T.pollRunning(paused('a', { owner: 'me' })), 'running')
  assert.equal(requests, 1)
  for (let i = 0; i < 3; i++) { d.c.t += 10_000; assert.equal(await T.pollRunning(paused('b', { owner: 'other' })), 'unknown') }
  assert.equal(requests, 1, 'no request for items of another app')
  d.c.t += 10_000
  assert.equal(await T.pollRunning(paused('a')), 'running', 'an ownerless item (standalone) still asks')
  assert.equal(requests, 2)
})

test('Resume all passes the poller to runResumeAll and shows the waiting text', () => {
  assert.match(source, /poll: pollRunning/)
  assert.match(source, /resumeProgressText\(r\.progress\)/)
  assert.match(source, /\/v1\/running-sessions/)
})

// ---- the calls the buttons make -----------------------------------------------------------------------------------------------------

test('the card buttons call the paused routes, and the overlay has the bar, the buttons and the scan link', () => {
  for (const needle of ['/v1/paused-resume', '/v1/paused-dismiss', '/v1/paused-scan', 'Resume all', 'PausedBody', 'rq-chip.paused']) assert.ok(source.includes(needle), needle)
})

test('resumeOne posts the standard route and returns the outcome; failures return the reason', async () => {
  const seen = []
  const { T } = load({ fetchImpl: async (url, init) => { seen.push([url, JSON.parse(init.body)]); return { ok: false, status: 409, json: async () => ({ ok: false, error: 'session-gone' }) } } })
  assert.deepEqual(plain(await T.resumeOne(paused('a'))), { ok: false, error: 'session-gone' })
  assert.deepEqual(seen, [['/review-queue/v1/paused-resume', { id: 'a' }]])
})
