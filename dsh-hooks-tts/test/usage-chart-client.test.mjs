import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The Claude session token chart of the Usage page (lib/client.js, browser bundle): pure chartModel geometry + the ClaudeChart element tree.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')

// Records elements as plain objects instead of rendering them.
const el = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) })

function load() {
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } } },
    document: { head: { appendChild() {} }, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} }, console, fetch: (...a) => globalThis.fetch(...a), setInterval, clearInterval, setTimeout, clearTimeout,
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stub = { createElement: el, Fragment: Symbol('F'), useState: () => [0, () => {}], useEffect() {}, useRef() {}, useSyncExternalStore() {}, useMemo() {}, useCallback() {} }
  return registered.factory(() => stub).__test
}
const T = load()

const START = Date.parse('2026-10-29T10:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const point = (i, over = {}) => ({ t: iso(START + i * 300000), all: 0, input: 0, output: 0, reasoning: 0, context: null, ...over })
const chart = (points, over = {}) => ({ enabled: true, window: { start: iso(START), end: iso(START + 5 * 3600000) }, bucketMs: 300000, points, note: null, ...over })
const full = () => chart(Array.from({ length: 61 }, (_, i) => point(i)))

const walk = (node, out = []) => {
  if (node && typeof node === 'object') { out.push(node); node.children.forEach((c) => walk(c, out)) }
  return out
}
const text = (node) => (node && typeof node === 'object' ? node.children.map(text).join('') : node === null || node === undefined ? '' : String(node))

test('chartModel returns null for missing, disabled, window-less and empty charts', () => {
  assert.equal(T.chartModel(undefined, 480, 180), null)
  assert.equal(T.chartModel(null, 480, 180), null)
  assert.equal(T.chartModel(chart([point(0)], { enabled: false }), 480, 180), null)
  assert.equal(T.chartModel(chart([point(0)], { window: null }), 480, 180), null)
  assert.equal(T.chartModel(chart([]), 480, 180), null)
})

test('legend: five series in order with the specified colours, Context dashed on the right axis', () => {
  const m = T.chartModel(full(), 480, 180)
  assert.deepEqual(JSON.parse(JSON.stringify(m.legend)), [
    { key: 'all', label: 'All', color: '#8b5cf6', dashed: false, axis: 'left' },
    { key: 'input', label: 'Input', color: '#3b82f6', dashed: false, axis: 'left' },
    { key: 'context', label: 'Context (right axis)', color: '#f59e0b', dashed: true, axis: 'right' },
    { key: 'output', label: 'Output', color: '#22c55e', dashed: false, axis: 'left' },
    { key: 'reasoning', label: 'Reasoning', color: '#ec4899', dashed: false, axis: 'left' },
  ])
  for (const k of ['all', 'input', 'output', 'reasoning']) assert.equal(typeof m.series[k], 'string')
  assert.ok(Array.isArray(m.series.context))
})

test('a full window spans the whole plot; a half-elapsed window leaves the right half empty', () => {
  const m = T.chartModel(full(), 480, 180)
  const { x, w } = m.plot
  assert.ok(Math.abs(m.xs[0] - x) < 1e-6)
  assert.ok(Math.abs(m.xs[60] - (x + w)) < 1e-6)
  const half = T.chartModel(chart(Array.from({ length: 31 }, (_, i) => point(i))), 480, 180)
  assert.ok(Math.abs(half.xs[30] - (x + w / 2)) < 1, 'last point is about the middle of the plot')
  assert.ok(half.xs[30] < x + w - 10)
})

test('an unaligned window start clamps the first point to the left edge of the plot', () => {
  const start = START + 2 * 60000
  const pts = [{ ...point(0), t: iso(START) }, { ...point(1), t: iso(START + 300000) }]
  const m = T.chartModel(chart(pts, { window: { start: iso(start), end: iso(start + 5 * 3600000) } }), 480, 180)
  assert.equal(m.xs[0], m.plot.x)
  assert.ok(m.xs[1] > m.plot.x)
  const late = T.chartModel(chart([{ ...point(0), t: iso(START + 6 * 3600000) }]), 480, 180)
  assert.equal(late.xs[0], late.plot.x + late.plot.w)
})

test('a single point still draws all four flow lines', () => {
  const m = T.chartModel(chart([point(0, { all: 5 })]), 480, 180)
  for (const k of ['all', 'input', 'output', 'reasoning']) assert.equal(m.series[k].split(' ').length, 2, k)
})

test('x labels are start, middle and end as local h:mm', () => {
  const m = T.chartModel(full(), 480, 180)
  const hm = (ms) => { const d = new Date(ms); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') }
  assert.deepEqual([...m.xLabels.map((l) => l.label)], [hm(START), hm(START + 2.5 * 3600000), hm(START + 5 * 3600000)])
  assert.ok(Math.abs(m.xLabels[1].x - (m.plot.x + m.plot.w / 2)) < 1e-6)
})

test('context null buckets split the context polyline into segments', () => {
  const pts = [point(0, { context: 100 }), point(1, { context: 200 }), point(2), point(3, { context: 50 }), point(4, { context: 60 }), point(5, { context: 70 })]
  const m = T.chartModel(chart(pts), 480, 180)
  assert.equal(m.series.context.length, 2)
  assert.equal(m.series.context[0].split(' ').length, 2)
  assert.equal(m.series.context[1].split(' ').length, 3)
  assert.equal(m.series.all.split(' ').length, 6, 'flow lines keep every bucket')
})

test('left axis ignores context, right axis ignores flows, both get a rounded top and 4 ticks', () => {
  const m = T.chartModel(chart([point(0, { all: 700, input: 600, output: 100, reasoning: 20, context: 90000 }), point(1, { all: 300, input: 250, output: 50, context: 40000 })]), 480, 180)
  assert.equal(m.left.max, 1000)
  assert.equal(m.right.max, 100000)
  assert.equal(m.left.ticks.length, 4)
  assert.equal(m.right.ticks.length, 4)
  assert.equal(m.left.ticks[3].value, 1000)
  assert.equal(m.right.ticks[3].label, '100k')
  const flat = T.chartModel(chart([point(0)]), 480, 180)
  assert.equal(flat.left.max, 1)
  assert.equal(flat.right.max, 1)
})

test('ClaudeChart renders heading, caption, svg, legend and aria-label from the model', () => {
  const root = T.ClaudeChart({ chart: full() })
  const all = walk(root)
  const svg = all.find((n) => n.type === 'svg')
  assert.equal(svg.props.viewBox, '0 0 480 180')
  assert.equal(svg.props.role, 'img')
  assert.ok(svg.props['aria-label'])
  const t = text(root)
  for (const s of ['Tokens this session window', 'DSH sessions only, per 5 min', 'All', 'Input', 'Context (right axis)', 'Output', 'Reasoning']) assert.ok(t.includes(s), s)
})

test('ClaudeChart without a window shows only the note; disabled renders nothing', () => {
  const noWin = T.ClaudeChart({ chart: chart([], { window: null, note: 'no current Claude session window' }) })
  assert.equal(walk(noWin).some((n) => n.type === 'svg'), false)
  assert.equal(text(noWin), 'no current Claude session window')
  assert.equal(text(T.ClaudeChart({ chart: chart([], { window: null }) })), 'Token chart unavailable')
  assert.equal(text(T.ClaudeChart({})), 'Token chart unavailable')
  assert.equal(T.ClaudeChart({ chart: chart([], { enabled: false }) }), null)
})

test('UsagePage places the chart after the limit bars and before the local-tokens line', async () => {
  const status = {
    claude: { limits: [{ kind: 'session', label: 'Session', percent: 10, resetsAt: iso(START) }, { kind: 'weekly', label: 'Week', percent: 20, resetsAt: iso(START) }] },
    usage: { fiveHour: { tokens: 1, budget: 1, pct: 0 }, weekly: { tokens: 2, budget: 1, pct: 0 } },
    claudeChart: full(),
  }
  globalThis.fetch = async (url) => ({ ok: !String(url).endsWith('/groups'), json: async () => status })
  await T.poll()
  const kids = walk(T.UsagePage()).find((n) => n.props.style && n.props.style.padding === 24).children
  const bars = kids.map((n, i) => (n && n.type === T.Bar ? i : -1)).filter((i) => i >= 0)
  const chartAt = kids.findIndex((n) => n && n.type === T.ClaudeChart)
  const localAt = kids.findIndex((n) => text(n).includes('DSH tokens (local)'))
  assert.equal(bars.length, 2, 'two limit bars')
  assert.ok(chartAt > Math.max(...bars), 'chart after the last bar')
  assert.ok(localAt > chartAt, 'local-tokens line after the chart')
  assert.equal(kids[chartAt].props.chart, status.claudeChart)
})