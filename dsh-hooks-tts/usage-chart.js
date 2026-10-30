/**
 * Token buckets for the Claude session chart on the Hooks and Usage page.
 * Pure bucketing and slicing, plus two small file helpers; see docs/usage-chart.md.
 * A bucket is { t, input, output, reasoning, ctx, fresh, cacheRead, cacheWrite } keyed by its 5-minute start time;
 * input = fresh + cacheRead + cacheWrite.
 */
import { readFileSync, writeFileSync } from 'node:fs'

export const BUCKET_MS = 300_000
export const RETAIN_MS = 6 * 3_600_000
const WINDOW_MS = 5 * 3_600_000
const MAX_POINTS = 61

export const bucketStart = (ms) => Math.floor(ms / BUCKET_MS) * BUCKET_MS

const DEFAULT_IDS = ['claude-code']
export const isClaudeProvider = (provider, ids = DEFAULT_IDS) => {
  const list = Array.isArray(ids) && ids.every(i => typeof i === 'string') ? ids : DEFAULT_IDS
  return typeof provider === 'string' && list.includes(provider)
}

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const required = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0

const MAX_BUCKETS = 100
const MAX_COUNT = 1e9 // per observation field
const MAX_STORED = 1e12 // per stored bucket value, so sums stay finite
const COUNT_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']

/** Add one observation, prune old buckets. Returns true when something changed. */
export function addObservation(buckets, { at, usage } = {}, now = Date.now()) {
  if (typeof usage !== 'object' || usage === null) return false
  if (!required(usage.inputTokens) || !required(usage.outputTokens)) return false
  if (COUNT_FIELDS.some(f => typeof usage[f] === 'number' && usage[f] > MAX_COUNT)) return false
  if (!Number.isFinite(at)) return false
  if (at > now + BUCKET_MS || at < now - RETAIN_MS) return false
  const prompt = usage.inputTokens + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens)
  const t = bucketStart(at)
  let bucket = buckets.find(b => b.t === t)
  if (!bucket) {
    bucket = { t, input: 0, output: 0, reasoning: 0, ctx: 0, fresh: 0, cacheRead: 0, cacheWrite: 0 }
    buckets.push(bucket)
    buckets.sort((a, b) => a.t - b.t)
  }
  bucket.fresh += usage.inputTokens
  bucket.cacheRead += count(usage.cacheReadTokens)
  bucket.cacheWrite += count(usage.cacheWriteTokens)
  bucket.input += prompt
  bucket.output += usage.outputTokens
  bucket.reasoning += count(usage.reasoningTokens)
  bucket.ctx = Math.max(bucket.ctx, prompt)
  for (let i = buckets.length - 1; i >= 0; i--) if (buckets[i].t < now - RETAIN_MS) buckets.splice(i, 1)
  if (buckets.length > MAX_BUCKETS) buckets.splice(0, buckets.length - MAX_BUCKETS)
  return true
}

/** A chart with no points: `note` says why (enabled=false for the disabled state). */
export const NO_WINDOW = 'no current Claude session window'
export const emptyChart = (note, enabled = true) => ({ enabled, window: null, points: [], note, bucketMs: BUCKET_MS })

/** The snapshot's `claudeChart` for the window ending at `windowEndMs`. */
export function chartFor(buckets, windowEndMs, now = Date.now()) {
  if (!Number.isFinite(windowEndMs) || windowEndMs <= now) {
    return emptyChart(NO_WINDOW)
  }
  const start = windowEndMs - WINDOW_MS
  const byTime = new Map(buckets.map(b => [b.t, b]))
  const points = []
  for (let t = bucketStart(start); t <= Math.min(now, windowEndMs) && points.length < MAX_POINTS; t += BUCKET_MS) {
    const b = byTime.get(t)
    points.push({
      t: new Date(t).toISOString(),
      all: b ? b.input + b.output : 0,
      input: b?.input ?? 0,
      output: b?.output ?? 0,
      reasoning: b?.reasoning ?? 0,
      fresh: b?.fresh ?? 0,
      cacheRead: b?.cacheRead ?? 0,
      cacheWrite: b?.cacheWrite ?? 0,
      context: b ? b.ctx : null,
    })
  }
  return {
    enabled: true,
    window: { start: new Date(start).toISOString(), end: new Date(windowEndMs).toISOString() },
    bucketMs: BUCKET_MS,
    points,
    note: null,
  }
}

const valid = (b) => b && required(b.t) && [b.input, b.output, b.reasoning, b.ctx].every(v => required(v) && v <= MAX_STORED)
// The prompt split arrived after the first buckets were saved: a missing value is 0, a present one must be sane.
const SPLIT = ['fresh', 'cacheRead', 'cacheWrite']
const validSplit = (b) => SPLIT.every(k => b[k] === undefined || (required(b[k]) && b[k] <= MAX_STORED))

export function loadBuckets(path, now = Date.now()) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (data?.v !== 1 || !Array.isArray(data.buckets)) return []
    return data.buckets
      .filter(b => valid(b) && validSplit(b) && b.t >= now - RETAIN_MS && b.t <= now + BUCKET_MS)
      .map(b => ({ t: b.t, input: b.input, output: b.output, reasoning: b.reasoning, ctx: b.ctx, fresh: b.fresh ?? 0, cacheRead: b.cacheRead ?? 0, cacheWrite: b.cacheWrite ?? 0 }))
      .sort((a, b) => a.t - b.t)
      .slice(-MAX_BUCKETS)
  } catch { return [] }
}

export function saveBuckets(path, buckets) {
  try { writeFileSync(path, JSON.stringify({ v: 1, buckets })) } catch { /* best effort */ }
}
