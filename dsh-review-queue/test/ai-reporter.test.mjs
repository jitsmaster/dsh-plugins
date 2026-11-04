// RED: ai-reporter.js, the hourly timer around buildReport/reportText. createAiReporter({ store, triageLog, speaker, notify, now, intervalMs, io, enabled, channels, log }).
// State: io.read()/io.write(text) hold { lastTickAt } so a restart neither repeats nor skips a period. Nothing here touches a real timer, speaker or network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAiReporter } from '../ai-reporter.js'

const H = 3600_000
const NOW = 100 * H
const aiDone = (id, at) => ({ id, type: 'completed', status: 'resolved', resolvedAt: at, resolution: { kind: 'ai-resolved', by: 'ai' } })

function setup(over = {}) {
  const calls = { speak: [], notify: [], log: [] }
  const mem = { text: over.state }
  const io = { read: () => mem.text, write: (t) => { mem.text = t } }
  let clock = over.now ?? NOW
  const deps = {
    store: { list: () => over.items ?? [aiDone('a', NOW - 10), aiDone('b', NOW - 20)] },
    triageLog: { entries: () => over.entries ?? [] },
    speaker: { speak: (chunks) => { calls.speak.push(chunks); if (over.speakThrows) throw new Error('speaker down'); return { ok: true } }, stop() {} },
    notify: async (text) => { calls.notify.push(text); if (over.notify) return over.notify(text); if (over.notifyThrows) throw new Error('rc down') },
    now: () => clock, io, log: (m) => calls.log.push(String(m)),
    ...(over.deps ?? {}),
  }
  const reporter = createAiReporter(deps)
  return { reporter, calls, mem, advance: (ms) => { clock += ms }, setNow: (n) => { clock = n } }
}

test('a tick with handled items speaks and notifies the same text, and last() holds the report with that text', async () => {
  const { reporter, calls } = setup()
  const r = await reporter.tick()
  assert.equal(r.total, 2)
  assert.equal(calls.notify.length, 1)
  assert.equal(calls.speak.length, 1)
  assert.deepEqual(calls.speak[0], [calls.notify[0]])
  assert.match(calls.notify[0], /AI handled 2 in the last hour/)
  assert.equal(reporter.last().text, calls.notify[0])
  assert.equal(reporter.last().total, 2)
})

test('the first tick covers the last interval; the window is persisted as lastTickAt', async () => {
  const { reporter, mem } = setup()
  const r = await reporter.tick()
  assert.equal(r.from, NOW - H); assert.equal(r.to, NOW)
  assert.equal(JSON.parse(mem.text).lastTickAt, NOW)
})

test('a restart continues from the persisted lastTickAt: no repeat, no gap', async () => {
  const first = setup()
  await first.reporter.tick()
  const second = setup({ state: first.mem.text, now: NOW + 30 * 60_000 })
  const r = await second.reporter.tick()
  assert.equal(r.from, NOW); assert.equal(r.to, NOW + 30 * 60_000)
})

test('the catch-up window after a long stop is capped at 24 hours', async () => {
  const { reporter } = setup({ state: JSON.stringify({ lastTickAt: NOW - 72 * H }) })
  const r = await reporter.tick()
  assert.equal(r.from, NOW - 24 * H)
})

test('a corrupt state file falls back to the last interval', async () => {
  const { reporter } = setup({ state: '{nope' })
  assert.equal((await reporter.tick()).from, NOW - H)
})

test('a quiet period sends nothing, but last() is updated and the window still moves on', async () => {
  const { reporter, calls, mem } = setup({ items: [], entries: [] })
  const r = await reporter.tick()
  assert.equal(r.total, 0)
  assert.deepEqual([calls.notify.length, calls.speak.length], [0, 0])
  assert.equal(reporter.last().total, 0)
  assert.equal(JSON.parse(mem.text).lastTickAt, NOW)
})

test('only overruled items (total 0) are still worth a message', async () => {
  const overruled = { id: 'o', type: 'completed', status: 'resolved', resolvedAt: NOW - 5, resolution: { kind: 'reviewed', review: 'overruled' } }
  const { reporter, calls } = setup({ items: [overruled] })
  await reporter.tick()
  assert.equal(calls.notify.length, 1)
  assert.match(calls.notify[0], /You overruled 1/)
})

test('last() is undefined before the first tick', () => {
  assert.equal(setup().reporter.last(), undefined)
})

test('a failing chat channel does not stop the voice channel and tick does not throw', async () => {
  const { reporter, calls } = setup({ notifyThrows: true })
  await assert.doesNotReject(() => reporter.tick())
  assert.equal(calls.speak.length, 1)
  assert.ok(calls.log.some((l) => /rc down|chat|notify/i.test(l)))
})

test('a failing voice channel does not stop the chat channel and tick does not throw', async () => {
  const { reporter, calls } = setup({ speakThrows: true })
  await assert.doesNotReject(() => reporter.tick())
  assert.equal(calls.notify.length, 1)
})

test('a failing items source does not throw and sends nothing', async () => {
  const { reporter, calls } = setup({ deps: { store: { list: () => { throw new Error('store down') } } } })
  await assert.doesNotReject(() => reporter.tick())
  assert.equal(calls.notify.length, 0)
})

test('a muted speaker (ok:false) is not an error', async () => {
  const { reporter, calls } = setup({ deps: { speaker: { speak: () => ({ ok: false, error: 'muted' }) } } })
  await assert.doesNotReject(() => reporter.tick())
  assert.equal(calls.notify.length, 1)
})

test('channels.voice:false / channels.chat:false switch one channel off', async () => {
  const a = setup({ deps: { channels: { voice: false, chat: true } } }); await a.reporter.tick()
  assert.deepEqual([a.calls.speak.length, a.calls.notify.length], [0, 1])
  const b = setup({ deps: { channels: { voice: true, chat: false } } }); await b.reporter.tick()
  assert.deepEqual([b.calls.speak.length, b.calls.notify.length], [1, 0])
})

test('a tick never overlaps itself: a second call while one is running does no work', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { reporter, calls } = setup({ notify: () => gate })
  const first = reporter.tick()
  const second = await reporter.tick()
  assert.equal(second, undefined)
  release(); await first
  assert.equal(calls.notify.length, 1)
  assert.notEqual(await reporter.tick(), undefined) // free again afterwards
})

test('enabled() false: no work, nothing persisted, nothing sent', async () => {
  const { reporter, calls, mem } = setup({ deps: { enabled: () => false } })
  assert.equal(await reporter.tick(), undefined)
  assert.deepEqual([calls.notify.length, calls.speak.length], [0, 0])
  assert.equal(mem.text, undefined)
  assert.equal(reporter.last(), undefined)
})

test('log lines carry no message text from the failing channel beyond its error', async () => {
  const { reporter, calls } = setup({ notify: () => { throw new Error('boom token=SUPERSECRETVALUE123456') } })
  await reporter.tick()
  assert.ok(!calls.log.join('\n').includes('SUPERSECRETVALUE123456'))
})

test('start() arms an unref\'d timer and stop() clears it; neither fires a tick by itself', async () => {
  const { reporter, calls } = setup({ deps: { intervalMs: 5 } })
  reporter.start(); reporter.start() // idempotent
  reporter.stop()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(calls.notify.length, 0)
})

test('start() schedules one catch-up tick when lastTickAt is older than the interval, and never when it is fresh', async () => {
  const mkTimers = () => { const t = []; return { t, set: (fn, ms) => { const h = { fn, ms, unref() { h.unrefd = true } }; t.push(h); return h }, clear: () => {} } }
  const stale = setup({ state: JSON.stringify({ lastTickAt: NOW - 2 * H }) })
  const timers = mkTimers()
  const r1 = setup({ state: JSON.stringify({ lastTickAt: NOW - 2 * H }), deps: { setTimeoutFn: timers.set, catchUpDelayMs: 5 } })
  r1.reporter.start()
  const once = timers.t.filter((h) => h.ms === 5)
  assert.equal(once.length, 1)
  assert.equal(once[0].unrefd, true)
  await once[0].fn()
  assert.equal(r1.calls.notify.length, 1)
  assert.equal(JSON.parse(r1.mem.text).lastTickAt, NOW)
  r1.reporter.stop()
  const t2 = mkTimers()
  const fresh = setup({ state: JSON.stringify({ lastTickAt: NOW - 10 }), deps: { setTimeoutFn: t2.set, catchUpDelayMs: 5 } })
  fresh.reporter.start()
  assert.equal(t2.t.filter((h) => h.ms === 5).length, 0)
  fresh.reporter.stop()
  const t3 = mkTimers()
  const none = setup({ deps: { setTimeoutFn: t3.set, catchUpDelayMs: 5 } })
  none.reporter.start()
  assert.equal(t3.t.filter((h) => h.ms === 5).length, 1) // missing state counts as stale
  none.reporter.stop(); stale.reporter.stop()
})
