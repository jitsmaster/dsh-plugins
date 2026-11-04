// RED: index.js wiring of the hourly AI report. On by default, off with config.aiReport === false or env DSH_RQ_AI_REPORT=0, off in node --test runs unless
// config.aiReport === true. config.aiReport may be { intervalMinutes, voice, chat, rcEnvFile }; config.aiReportDeps ({ notify, speaker, now, spawn }) replaces parts.
// The plugin result exposes aiReporter ({ tick, last, start, stop }) so a test can drive a tick; no real timer, speaker or RingCentral call happens here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewQueuePlugin } from '../index.js'

const ctx = () => ({
  on: () => {}, get: () => undefined, effect: () => {}, logger: { warn() {}, info() {} },
  inject: (_n, fn) => fn({ effect: (f) => f(), connection: { admit: () => ({}) }, webServer: { register: () => {} } }),
})
function boot(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-aireport-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sent = { notify: [], speak: [], spawn: [] }
  const deps = {
    notify: async (text) => { sent.notify.push(text) },
    speaker: { speak: (chunks) => { sent.speak.push(chunks); return { ok: true } }, stop() {} },
    now: () => Date.now() + 1000,
    ...(config.aiReportDeps ?? {}),
  }
  const plugin = createReviewQueuePlugin(ctx(), { hub: false, stateDir: dir, triage: false, ...config, aiReportDeps: deps })
  const resolveAuto = () => { const it = plugin.store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'Did X.', payload: { reply: 'ok' } }); plugin.store.resolve(it.id, { kind: 'no-action', by: 'auto' }) }
  return { plugin, sent, dir, resolveAuto }
}

test('under node --test the reporter is off by default', (t) => {
  assert.equal(boot(t).plugin.aiReporter, undefined)
})

test('config.aiReport: false keeps it off even when asked through deps', (t) => {
  assert.equal(boot(t, { aiReport: false }).plugin.aiReporter, undefined)
})

test('with config.aiReport: true a tick reports an auto-cleared item to both channels using the fakes', async (t) => {
  const { plugin, sent, resolveAuto } = boot(t, { aiReport: true })
  assert.ok(plugin.aiReporter, 'aiReporter exposed')
  resolveAuto()
  await plugin.aiReporter.tick()
  assert.equal(sent.notify.length, 1)
  assert.match(sent.notify[0], /AI handled 1 in the last hour/)
  assert.deepEqual(sent.speak[0], [sent.notify[0]])
})

test('the snapshot carries the report after a tick', async (t) => {
  const { plugin, resolveAuto } = boot(t, { aiReport: true })
  resolveAuto()
  await plugin.aiReporter.tick()
  const snap = plugin.local.snapshot()
  assert.equal(snap.aiReport.total, 1)
  assert.match(snap.aiReport.text, /AI handled 1/)
})

test('config.aiReport as an object switches channels off', async (t) => {
  const { plugin, sent, resolveAuto } = boot(t, { aiReport: { voice: false, chat: true } })
  resolveAuto()
  await plugin.aiReporter.tick()
  assert.deepEqual([sent.speak.length, sent.notify.length], [0, 1])
})

test('config.aiReport.intervalMinutes sets the window the first tick covers', async (t) => {
  const now = 10 * 3600_000
  const { plugin } = boot(t, { aiReport: { intervalMinutes: 30 }, aiReportDeps: { now: () => now } })
  const r = await plugin.aiReporter.tick()
  assert.equal(r.to - r.from, 30 * 60_000)
})

test('without a notify override the RingCentral channel is the spawn wrapper: a missing env file spawns nothing', async (t) => {
  const spawned = []
  const spawn = (...a) => { spawned.push(a); return Object.assign(new EventEmitter(), { stdin: { end() {}, on() {} }, stderr: new EventEmitter() }) }
  const dir = mkdtempSync(join(tmpdir(), 'rq-aireport-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const plugin = createReviewQueuePlugin(ctx(), { hub: false, stateDir: dir, triage: false, aiReport: { voice: false, rcEnvFile: join(dir, 'missing.env') }, aiReportDeps: { spawn, now: () => Date.now() + 1000 } })
  const it = plugin.store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'x', payload: { reply: 'ok' } })
  plugin.store.resolve(it.id, { kind: 'no-action', by: 'auto' })
  await plugin.aiReporter.tick()
  assert.equal(spawned.length, 0)
})

test('the window is persisted in ai-report.json in the state directory', async (t) => {
  const { plugin, dir } = boot(t, { aiReport: true })
  await plugin.aiReporter.tick()
  const { readFileSync } = await import('node:fs')
  assert.equal(typeof JSON.parse(readFileSync(join(dir, 'ai-report.json'), 'utf8')).lastTickAt, 'number')
})
