// Token buckets for the Claude session chart: pure bucketing, slicing and persistence.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  BUCKET_MS, RETAIN_MS, addObservation, bucketStart, chartFor, isClaudeProvider, loadBuckets, saveBuckets,
} from '../usage-chart.js'

const NOW = Date.parse('2026-10-29T12:00:00Z')
const HOUR = 3_600_000
const usage = (inputTokens, outputTokens, extra = {}) => ({ inputTokens, outputTokens, ...extra })

test('constants and bucketStart floor to 5 minutes', () => {
  assert.equal(BUCKET_MS, 300_000)
  assert.equal(RETAIN_MS, 6 * HOUR)
  assert.equal(bucketStart(NOW + 123_456) % BUCKET_MS, 0)
  assert.equal(bucketStart(NOW), NOW)
  assert.equal(bucketStart(NOW + BUCKET_MS - 1), NOW)
})

test('provider filter defaults to claude-code and honours custom ids', () => {
  assert.equal(isClaudeProvider('claude-code'), true)
  assert.equal(isClaudeProvider('deepseek'), false)
  assert.equal(isClaudeProvider(undefined), false)
  assert.equal(isClaudeProvider('mine', ['mine']), true)
  assert.equal(isClaudeProvider('claude-code', ['mine']), false)
})

test('observations land in buckets; All = input + output, reasoning kept out', () => {
  const buckets = []
  assert.equal(addObservation(buckets, { at: NOW + 1000, usage: usage(100, 50, { cacheReadTokens: 400, cacheWriteTokens: 10, reasoningTokens: 30 }) }, NOW), true)
  assert.equal(addObservation(buckets, { at: NOW + 2000, usage: usage(20, 5) }, NOW), true)
  assert.equal(buckets.length, 1)
  const chart = chartFor(buckets, NOW + 4 * HOUR, NOW + 10 * 60_000)
  const point = chart.points.find(p => p.t === new Date(NOW).toISOString())
  assert.deepEqual(point, { t: new Date(NOW).toISOString(), all: 510 + 50 + 20 + 5, input: 530, output: 55, reasoning: 30, context: 510 })
})

test('context is the max prompt size in the bucket', () => {
  const buckets = []
  addObservation(buckets, { at: NOW, usage: usage(100, 1, { cacheReadTokens: 100 }) }, NOW)
  addObservation(buckets, { at: NOW + 1, usage: usage(50, 1) }, NOW)
  const point = chartFor(buckets, NOW + 4 * HOUR, NOW + 1).points.find(p => p.context !== null)
  assert.equal(point.context, 200)
})

test('buckets older than six hours are pruned', () => {
  const buckets = []
  addObservation(buckets, { at: NOW - 7 * HOUR, usage: usage(1, 1) }, NOW - 7 * HOUR)
  addObservation(buckets, { at: NOW, usage: usage(1, 1) }, NOW)
  assert.equal(buckets.length, 1)
  assert.equal(buckets[0].t, bucketStart(NOW))
})

test('unusable usage is ignored', () => {
  const buckets = []
  for (const bad of [null, 'x', 5, {}, usage(-1, 2), usage(1, -2), usage(NaN, 1), usage(1, Infinity), usage('1', 2)]) {
    assert.equal(addObservation(buckets, { at: NOW, usage: bad }, NOW), false)
  }
  assert.deepEqual(buckets, [])
  // bad optional fields count as 0
  assert.equal(addObservation(buckets, { at: NOW, usage: usage(10, 5, { cacheReadTokens: -3, cacheWriteTokens: NaN, reasoningTokens: 'x' }) }, NOW), true)
  assert.deepEqual(chartFor(buckets, NOW + HOUR, NOW).points.find(p => p.context !== null), { t: new Date(NOW).toISOString(), all: 15, input: 10, output: 5, reasoning: 0, context: 10 })
})

test('window slicing: start = end - 5h, points up to now, max 61', () => {
  const end = NOW + HOUR
  const chart = chartFor([], end, NOW)
  assert.deepEqual(chart.window, { start: new Date(end - 5 * HOUR).toISOString(), end: new Date(end).toISOString() })
  assert.equal(chart.enabled, true)
  assert.equal(chart.bucketMs, BUCKET_MS)
  assert.equal(chart.note, null)
  assert.equal(chart.points[0].t, new Date(bucketStart(end - 5 * HOUR)).toISOString())
  assert.ok(chart.points.length <= 61)
  assert.ok(Date.parse(chart.points.at(-1).t) <= NOW)
  // whole window elapsed: 61 points at most
  const full = chartFor([], NOW + 1000, NOW)
  assert.ok(full.points.length <= 61 && full.points.length >= 60)
})

test('gaps have zero flow and null context; observations outside the window are left out', () => {
  const buckets = []
  addObservation(buckets, { at: NOW - HOUR, usage: usage(7, 3) }, NOW)
  addObservation(buckets, { at: NOW - 5.5 * HOUR, usage: usage(99, 99) }, NOW - 5.5 * HOUR)
  const chart = chartFor(buckets, NOW + 2 * HOUR, NOW)
  const filled = chart.points.filter(p => p.context !== null)
  assert.equal(filled.length, 1)
  assert.equal(filled[0].all, 10)
  const gap = chart.points.find(p => p.context === null)
  assert.deepEqual([gap.all, gap.input, gap.output, gap.reasoning], [0, 0, 0, 0])
})

test('no or expired window gives no chart', () => {
  for (const end of [undefined, NOW, NOW - 1000]) {
    assert.deepEqual(chartFor([], end, NOW), { window: null, points: [], note: 'no current Claude session window', bucketMs: BUCKET_MS, enabled: true })
  }
})

test('persistence round trip, missing, corrupt and wrong version files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-chart-'))
  const path = join(dir, 'usage-buckets.json')
  assert.deepEqual(loadBuckets(path), [])
  const buckets = []
  addObservation(buckets, { at: NOW, usage: usage(5, 6) }, NOW)
  saveBuckets(path, buckets)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).v, 1)
  assert.deepEqual(loadBuckets(path, NOW), buckets)
  writeFileSync(path, '{not json')
  assert.deepEqual(loadBuckets(path, NOW), [])
  writeFileSync(path, JSON.stringify({ v: 2, buckets }))
  assert.deepEqual(loadBuckets(path, NOW), [])
  writeFileSync(path, JSON.stringify({ v: 1, buckets: 'x' }))
  assert.deepEqual(loadBuckets(path, NOW), [])
  assert.doesNotThrow(() => saveBuckets(join(dir, 'missing', 'sub', 'x.json'), buckets))
})

test('isClaudeProvider falls back to claude-code for a non-array or non-string id list', () => {
  for (const ids of ['claude-code', { a: 1 }, 5, null, [1, null]]) {
    assert.equal(isClaudeProvider('claude-code', ids), true, JSON.stringify(ids))
    assert.equal(isClaudeProvider('deepseek', ids), false)
  }
})

test('loading drops buckets with a negative value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-chart-neg-'))
  const path = join(dir, 'usage-buckets.json')
  const ok = { t: NOW, input: 1, output: 2, reasoning: 0, ctx: 1 }
  writeFileSync(path, JSON.stringify({ v: 1, buckets: [ok, { ...ok, t: NOW + 1, input: -1 }, { ...ok, t: NOW + 2, ctx: -5 }] }))
  assert.deepEqual(loadBuckets(path, NOW), [ok])
})

test('future-dated and stale observations are ignored', () => {
  const buckets = []
  assert.equal(addObservation(buckets, { at: NOW + BUCKET_MS + 1, usage: usage(1, 1) }, NOW), false)
  assert.equal(addObservation(buckets, { at: NOW + 10 * HOUR, usage: usage(1, 1) }, NOW), false)
  assert.equal(addObservation(buckets, { at: NOW - RETAIN_MS - 1, usage: usage(1, 1) }, NOW), false)
  assert.deepEqual(buckets, [])
  assert.equal(addObservation(buckets, { at: NOW + BUCKET_MS, usage: usage(1, 1) }, NOW), true)
  assert.equal(addObservation(buckets, { at: NOW - RETAIN_MS, usage: usage(1, 1) }, NOW), true)
})

test('counts above 1e9 are ignored, 1e9 is accepted', () => {
  const buckets = []
  for (const f of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    assert.equal(addObservation(buckets, { at: NOW, usage: usage(1, 1, { [f]: 1e9 + 1 }) }, NOW), false, f)
  }
  assert.equal(addObservation(buckets, { at: NOW, usage: usage(1e18, 1) }, NOW), false)
  assert.deepEqual(buckets, [])
  assert.equal(addObservation(buckets, { at: NOW, usage: usage(1e9, 1e9) }, NOW), true)
})

test('bucket array is capped at 100, oldest dropped', () => {
  const buckets = []
  for (let i = 0; i < 120; i++) buckets.push({ t: NOW - RETAIN_MS + i * 1000, input: 1, output: 1, reasoning: 0, ctx: 1 })
  assert.equal(addObservation(buckets, { at: NOW, usage: usage(1, 1) }, NOW), true)
  assert.equal(buckets.length, 100)
  assert.equal(buckets.at(-1).t, bucketStart(NOW))
  assert.ok(buckets[0].t > NOW - RETAIN_MS + 20 * 1000)
})

test('loading cleans future, stale, huge and extra-key buckets and caps length', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-chart-clean-'))
  const path = join(dir, 'usage-buckets.json')
  const ok = { t: NOW, input: 1, output: 2, reasoning: 0, ctx: 1 }
  writeFileSync(path, JSON.stringify({ v: 1, buckets: [
    { ...ok, t: NOW + 2 * BUCKET_MS },
    { ...ok, t: NOW - RETAIN_MS - 1 },
    { ...ok, t: NOW + 1, input: 1e12 + 1 },
    { ...ok, t: NOW + 2, ctx: 1e13 },
    { ...ok, t: NOW + 3, evil: 'x', __proto__: { a: 1 } },
    ok,
  ] }))
  const got = loadBuckets(path, NOW)
  assert.deepEqual(got, [ok, { ...ok, t: NOW + 3 }])
  assert.deepEqual(Object.keys(got[1]), ['t', 'input', 'output', 'reasoning', 'ctx'])
  const many = Array.from({ length: 150 }, (_, i) => ({ ...ok, t: NOW - 1 - i }))
  writeFileSync(path, JSON.stringify({ v: 1, buckets: many }))
  const capped = loadBuckets(path, NOW)
  assert.equal(capped.length, 100)
  assert.equal(capped[0].t, NOW - 100)
})