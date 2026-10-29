// status.js wiring for the Claude session chart, with a fake ctx.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startStatusService } from '../status.js'

const HOUR = 3_600_000

function harness(config = {}, { reading = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-chart-status-'))
  const resetsAt = Math.floor((Date.now() + 2 * HOUR) / 1000)
  if (reading) writeFileSync(join(dir, 'claude-rate-limit.json'), JSON.stringify({ updatedAt: new Date().toISOString(), fiveHour: { utilization: 0.1, resetsAt } }))
  const handlers = {}
  let routes
  const ctx = {
    logger: { warn() {}, info() {} },
    get: () => undefined,
    on: (name, fn) => { handlers[name] = fn },
    inject: (_deps, fn) => fn({ effect: (f) => f(), webServer: { register: (r) => { routes = r } }, connection: { admit: () => ({}) } }),
  }
  const controller = new AbortController()
  startStatusService(ctx, { refreshIntervalMs: 3_600_000, ...config }, dir, controller.signal, { get: () => ({}) })
  const served = async () => {
    let body
    const res = { setHeader() {}, end: (b) => { body = b } }
    routes.handler({ url: '/hooks-tts/status', method: 'GET' }, res)
    return JSON.parse(body)
  }
  return { dir, handlers, served, stop: () => controller.abort() }
}

const message = (provider, extra = {}) => ({
  type: 'assistant/message',
  time: Date.now(),
  data: { usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 60, reasoningTokens: 7 }, message: { source: { provider } }, ...extra },
})

async function until(check, what, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > end) assert.fail('timed out after ' + timeoutMs + ' ms waiting for ' + what)
    await new Promise(r => setTimeout(r, 10))
  }
}
// agent/turn-stopping is what refreshes the served snapshot; fail loudly if it is not registered.
const sample = (h) => { assert.equal(typeof h.handlers['agent/turn-stopping'], 'function'); h.handlers['agent/turn-stopping']() }
const total = chart => chart.points.reduce((a, p) => a + p.all, 0)

test('a Claude-provider assistant/message is counted in the served chart', async (t) => {
  const h = harness()
  t.after(h.stop)
  assert.equal(typeof h.handlers['session/event'], 'function')
  h.handlers['session/event']({}, message('claude-code'))
  sample(h)
  await until(async () => total((await h.served()).claudeChart) === 200, 'the event to reach the served chart')
  const { claudeChart } = await h.served()
  assert.equal(claudeChart.enabled, true)
  assert.ok(claudeChart.window)
  assert.equal(total(claudeChart), 200)
  assert.equal(claudeChart.points.reduce((a, p) => a + p.input, 0), 160)
  assert.ok(existsSync(join(h.dir, 'usage-buckets.json')))
})

test('stopping flushes dirty buckets to disk before the next sample tick', () => {
  const h = harness()
  h.handlers['session/event']({}, message('claude-code'))
  h.stop()
  const saved = JSON.parse(readFileSync(join(h.dir, 'usage-buckets.json'), 'utf8'))
  assert.equal(saved.buckets.reduce((a, b) => a + b.input + b.output, 0), 200)
})

test('other providers, attempts and unusable events are not counted and never throw', async (t) => {
  const h = harness()
  t.after(h.stop)
  const fire = h.handlers['session/event']
  fire({}, message('deepseek'))
  fire({}, { type: 'assistant/attempt', time: Date.now(), data: message('claude-code').data })
  fire({}, { type: 'assistant/message', data: { message: { source: { provider: 'claude-code' } } } })
  assert.doesNotThrow(() => fire({}, null))
  assert.doesNotThrow(() => fire({}, undefined))
  assert.doesNotThrow(() => fire(null, { type: 'assistant/message', data: null }))
  const { claudeChart } = await h.served()
  assert.equal(total(claudeChart), 0)
})

test('config.claudeProviderIds overrides the default', async (t) => {
  const h = harness({ claudeProviderIds: ['mine'] })
  t.after(h.stop)
  h.handlers['session/event']({}, message('claude-code'))
  h.handlers['session/event']({}, message('mine'))
  sample(h)
  await until(async () => total((await h.served()).claudeChart) === 200, 'only the configured provider to be counted')
  assert.equal(total((await h.served()).claudeChart), 200)
})

test('claudeUsage:false disables the chart', async (t) => {
  const h = harness({ claudeUsage: false })
  t.after(h.stop)
  h.handlers['session/event']({}, message('claude-code'))
  assert.deepEqual((await h.served()).claudeChart, { enabled: false, window: null, points: [], note: 'disabled', bucketMs: 300000 })
})

test('without a Claude reading the chart says there is no window', async (t) => {
  const h = harness({}, { reading: false })
  t.after(h.stop)
  const { claudeChart } = await h.served()
  assert.equal(claudeChart.window, null)
  assert.equal(claudeChart.note, 'no current Claude session window')
})

test('saved buckets are loaded at start', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-chart-load-'))
  const at = Math.floor(Date.now() / 300000) * 300000
  writeFileSync(join(dir, 'usage-buckets.json'), JSON.stringify({ v: 1, buckets: [{ t: at, input: 11, output: 4, reasoning: 0, ctx: 11 }] }))
  writeFileSync(join(dir, 'claude-rate-limit.json'), JSON.stringify({ fiveHour: { utilization: 0.1, resetsAt: Math.floor((Date.now() + 2 * HOUR) / 1000) } }))
  let routes
  const ctx = { logger: { warn() {} }, get: () => undefined, on() {}, inject: (_d, fn) => fn({ effect: f => f(), webServer: { register: r => { routes = r } }, connection: { admit: () => ({}) } }) }
  const controller = new AbortController()
  t.after(() => controller.abort())
  startStatusService(ctx, { refreshIntervalMs: 3_600_000 }, dir, controller.signal, { get: () => ({}) })
  const read = () => { let body; routes.handler({ url: '/hooks-tts/status', method: 'GET' }, { setHeader() {}, end: b => { body = b } }); return JSON.parse(body) }
  await until(() => total(read().claudeChart) === 15, 'saved buckets to be served')
  let body
  routes.handler({ url: '/hooks-tts/status', method: 'GET' }, { setHeader() {}, end: b => { body = b } })
  assert.equal(total(JSON.parse(body).claudeChart), 15)
  assert.ok(readFileSync(join(dir, 'usage-buckets.json'), 'utf8').includes('"v":1'))
})

test('a non-array or non-string claudeProviderIds falls back to claude-code and never throws', async (t) => {
  for (const ids of ['claude-code', { a: 1 }, 5, [1, null]]) {
    const h = harness({ claudeProviderIds: ids })
    t.after(h.stop)
    assert.doesNotThrow(() => h.handlers['session/event']({}, message('claude-code')))
    sample(h)
    await until(async () => total((await h.served()).claudeChart) === 200, 'claude-code to be counted for ' + JSON.stringify(ids))
  }
})
test('the real DSH assistant/message event shape (session types.ts + llm TokenUsage) is counted', async (t) => {
  const h = harness()
  t.after(h.stop)
  h.handlers['session/event']({}, {
    type: 'assistant/message', seq: 12, time: Date.now(), surfaceOp: 'append',
    data: {
      turn: 1, step: 0,
      message: { id: 'msg-1', role: 'assistant', content: [], source: { kind: 'model', provider: 'claude-code', model: 'claude-sonnet-5-5' } },
      stream: [],
      usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 20, reasoningTokens: 7, totalTokens: 227 },
    },
  })
  sample(h)
  await until(async () => total((await h.served()).claudeChart) > 0, 'the real-shape event to be counted')
  const { points } = (await h.served()).claudeChart
  const sum = (k) => points.reduce((a, p) => a + p[k], 0)
  assert.equal(sum('input'), 180)
  assert.equal(sum('output'), 40)
  assert.equal(sum('reasoning'), 7)
  assert.equal(Math.max(...points.map(p => p.context ?? 0)), 180)
})