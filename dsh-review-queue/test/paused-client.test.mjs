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
function load({ fetchImpl } = {}) {
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: fetchImpl ?? (() => new Promise(() => {})),
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
  assert.deepEqual(progress.at(-1), { total: 5, started: 5, ok: 5, failed: 0, running: 0 })
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
