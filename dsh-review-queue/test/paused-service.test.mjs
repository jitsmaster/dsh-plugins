import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { cancelStalePending } from '../capture.js'
import { spokenFor, titleFor, fullTextFor } from '../speech.js'
import { RESUME_PROMPT, createDismissals, createPausedTracker } from '../paused.js'

// The paused-session item: the agent's scan turns candidates (paused.js scanSessionLogs) into open items, a card resumes or dismisses
// them, and a dismissed session stays dismissed (by session id and the log's last write).
const cand = (id, over = {}) => ({
  sessionId: id, cwd: 'D:/w/' + id, title: 'Work of ' + id, lastWrite: 1000, kinds: ['open-turn'], reason: 'Cut off in the middle of a turn', turn: 2,
  danglingCalls: ['shell'], pending: 0, lastUser: 'please fix it', lastAssistant: 'on it', ...over,
})
const memIo = () => { const io = { text: undefined, read: () => io.text, write: (t) => { io.text = t } }; return io }

function setup({ candidates = [], controller, io = memIo(), now = () => 5000, retentionMs, log } = {}) {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const scans = { result: { ok: true, candidates }, calls: 0, gate: undefined }
  const dismissals = createDismissals({ io, now, retentionMs })
  const tracker = createPausedTracker({ store, dismissals, now, scan: async () => { scans.calls++; await scans.gate; return scans.result } })
  const prompts = []
  const ctl = controller ?? { prompt: async (request, signal) => { prompts.push({ request, signal }) } }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ctl, speaker: { speak: () => ({ ok: true }), stop() {} }, paused: tracker, log })
  return { store, queue, tracker, dismissals, scans, prompts, io, now }
}
const openPaused = (store) => store.snapshot().open.filter((i) => i.type === 'paused')

// ---- the scan fills the list --------------------------------------------------------------------------------------------------------

test('scan adds one open paused item per candidate, carrying what the card shows', async () => {
  const { store, tracker } = setup({ candidates: [cand('s1'), cand('s2', { lastWrite: 2000 })] })
  assert.deepEqual(await tracker.scan(), { ok: true, added: 2, updated: 0, resolved: 0, total: 2 })
  const open = openPaused(store)
  assert.equal(open.length, 2)
  const a = open.find((i) => i.sessionId === 's1')
  assert.deepEqual([a.type, a.sessionTitle, a.workspace], ['paused', 'Work of s1', 'D:/w/s1'])
  assert.deepEqual(a.payload, { lastWrite: 1000, kinds: ['open-turn'], reason: 'Cut off in the middle of a turn', turn: 2, danglingCalls: ['shell'], pending: 0, lastUser: 'please fix it', lastAssistant: 'on it' })
})

test('scanning again adds no duplicate; a newer last write updates the open item in place; a vanished candidate is resolved as recovered', async () => {
  const { store, tracker, scans } = setup({ candidates: [cand('s1'), cand('s2')] })
  await tracker.scan()
  const ids = openPaused(store).map((i) => i.id)
  assert.deepEqual(await tracker.scan(), { ok: true, added: 0, updated: 0, resolved: 0, total: 2 })
  scans.result = { ok: true, candidates: [cand('s1', { lastWrite: 1500, danglingCalls: [] })] }
  assert.deepEqual(await tracker.scan(), { ok: true, added: 0, updated: 1, resolved: 1, total: 1 })
  assert.deepEqual(openPaused(store).map((i) => i.id), [ids[0]])
  assert.equal(openPaused(store)[0].payload.lastWrite, 1500)
  assert.deepEqual(store.get(ids[1]).resolution, { kind: 'recovered', by: 'scan' })
})

test('a failed scan changes nothing and says why; a scan that throws is a failed scan', async () => {
  const { store, tracker, scans } = setup({ candidates: [cand('s1')] })
  await tracker.scan()
  scans.result = { ok: false, error: 'no-zstd' }
  assert.deepEqual(await tracker.scan(), { ok: false, error: 'no-zstd' })
  assert.equal(openPaused(store).length, 1)
  scans.result = undefined
  const bad = createPausedTracker({ store, dismissals: createDismissals({ io: memIo() }), scan: async () => { throw new Error('boom') } })
  assert.deepEqual(await bad.scan(), { ok: false, error: 'scan-failed' })
  assert.equal(openPaused(store).length, 1)
})

test('two scans at once share one run', async () => {
  const { tracker, scans } = setup({ candidates: [cand('s1')] })
  let release
  scans.gate = new Promise((r) => { release = r })
  const first = tracker.scan()
  const second = tracker.scan()
  release()
  assert.deepEqual(await first, await second)
  assert.equal(scans.calls, 1)
})

// ---- dismissed stays dismissed ---------------------------------------------------------------------------------------------------------

test('Dismiss resolves the item and the session stays dismissed on every later scan, also after a restart (state file)', async () => {
  const io = memIo()
  const first = setup({ candidates: [cand('s1')], io })
  await first.tracker.scan()
  const id = openPaused(first.store)[0].id
  assert.deepEqual(first.queue.dismissPaused(id), { ok: true })
  assert.deepEqual(first.store.get(id).resolution, { kind: 'dismissed', by: 'card' })
  assert.deepEqual(await first.tracker.scan(), { ok: true, added: 0, updated: 0, resolved: 0, total: 0 })
  assert.equal(openPaused(first.store).length, 0)
  // a new process: new store, same state file
  const second = setup({ candidates: [cand('s1')], io })
  assert.deepEqual(await second.tracker.scan(), { ok: true, added: 0, updated: 0, resolved: 0, total: 0 })
  // the session wrote more and was cut off again: a new last write is a new case
  second.scans.result = { ok: true, candidates: [cand('s1', { lastWrite: 2000 })] }
  assert.equal((await second.tracker.scan()).added, 1)
})

test('dismissals are keyed by session id and last write, and entries older than the retention are forgotten', () => {
  const io = memIo()
  let t = 1000
  const d = createDismissals({ io, now: () => t, retentionMs: 500 })
  d.add('s1', 100)
  assert.deepEqual([d.has('s1', 100), d.has('s1', 50), d.has('s1', 101), d.has('s2', 100)], [true, true, false, false])
  assert.equal(createDismissals({ io, now: () => t }).has('s1', 100), true)
  t = 2000
  assert.equal(createDismissals({ io, now: () => t, retentionMs: 500 }).has('s1', 100), false)
})

test('an unreadable or foreign state file means nothing is dismissed, never a crash', () => {
  assert.equal(createDismissals({ io: { read: () => '{not json', write() {} } }).has('s', 1), false)
  assert.equal(createDismissals({ io: { read: () => JSON.stringify({ v: 9 }), write() {} } }).has('s', 1), false)
  const d = createDismissals({ io: { read: () => undefined, write() { throw new Error('disk full') } } })
  assert.doesNotThrow(() => d.add('s', 1))
  assert.equal(d.has('s', 1), true, 'kept in memory for this run')
})

// ---- Resume -----------------------------------------------------------------------------------------------------------------------------

test('Resume prompts the session itself with the standard resume prompt, queued, then closes the item as resumed', async () => {
  const { store, queue, prompts, tracker, scans } = setup({ candidates: [cand('s1')] })
  await tracker.scan()
  const id = openPaused(store)[0].id
  assert.deepEqual(await queue.resumePaused(id), { ok: true })
  assert.equal(prompts.length, 1)
  const { request, signal } = prompts[0]
  assert.equal(request.sessionId, 's1')
  assert.equal(request.mode, 'queue')
  assert.deepEqual(request.content, [{ type: 'text', text: RESUME_PROMPT }])
  assert.match(request.requestId, /^resume-/)
  assert.ok(signal instanceof AbortSignal, 'the Remote method needs a caller signal')
  assert.deepEqual(store.get(id).resolution, { kind: 'resumed', by: 'card' })
  // the prompt may not have reached the log yet: the same candidate must not come back
  assert.equal((await tracker.scan()).added, 0)
  scans.result = { ok: true, candidates: [cand('s1', { lastWrite: 3000 })] }
  assert.equal((await tracker.scan()).added, 1, 'but a later cut is a new case')
})

test('Resume refuses what is not an open paused item, and a missing controller', async () => {
  const { store, queue, tracker } = setup({ candidates: [cand('s1')] })
  const done = store.add({ type: 'completed', sessionId: 'c', payload: { reply: 'x' } })
  assert.deepEqual(await queue.resumePaused(done.id), { ok: false, error: 'not-paused' })
  assert.deepEqual(await queue.resumePaused('nope'), { ok: false, error: 'not-open' })
  await tracker.scan()
  const id = openPaused(store)[0].id
  const bare = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), speaker: undefined, paused: tracker })
  assert.deepEqual(await bare.resumePaused(id), { ok: false, error: 'no-controller' })
  assert.equal(store.get(id).status, 'open')
  assert.deepEqual(await queue.resumePaused(id), { ok: true })
  assert.deepEqual(await queue.resumePaused(id), { ok: false, error: 'not-open' })
})

test('Resume of a session DSH no longer has ends the item (session-gone); another failure keeps it open with the reason', async () => {
  const gone = setup({ candidates: [cand('s1')], controller: { prompt: async () => { throw Object.assign(new Error('nope'), { code: 'session/not-found' }) } } })
  await gone.tracker.scan()
  const id = openPaused(gone.store)[0].id
  assert.deepEqual(await gone.queue.resumePaused(id), { ok: false, error: 'session-gone' })
  assert.deepEqual(gone.store.get(id).resolution, { kind: 'session-ended' })
  const busy = setup({ candidates: [cand('s1')], controller: { prompt: async () => { throw new Error('writer held') } } })
  await busy.tracker.scan()
  const id2 = openPaused(busy.store)[0].id
  assert.deepEqual(await busy.queue.resumePaused(id2), { ok: false, error: 'writer held' })
  assert.equal(busy.store.get(id2).status, 'open')
})

test('Resume of a session DSH no longer has logs the item it closed as session-ended', async () => {
  const logs = []
  const gone = setup({ candidates: [cand('s1')], log: (l) => logs.push(l), controller: { prompt: async () => { throw Object.assign(new Error('nope'), { code: 'session/not-found' }) } } })
  await gone.tracker.scan()
  const id = openPaused(gone.store)[0].id
  await gone.queue.resumePaused(id)
  assert.ok(logs.some((l) => l.includes(id) && l.includes('session-ended')), logs.join(' | '))
})

test('Dismiss refuses what is not an open paused item', async () => {
  const { store, queue } = setup()
  const done = store.add({ type: 'completed', sessionId: 'c', payload: { reply: 'x' } })
  assert.deepEqual(queue.dismissPaused(done.id), { ok: false, error: 'not-paused' })
  assert.deepEqual(queue.dismissPaused('nope'), { ok: false, error: 'not-open' })
})

test('scanPaused runs the scan; without a scanner it says so', async () => {
  const { queue, store } = setup({ candidates: [cand('s1')] })
  assert.equal((await queue.scanPaused()).added, 1)
  assert.equal(openPaused(store).length, 1)
  const bare = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), speaker: undefined })
  assert.deepEqual(await bare.scanPaused(), { ok: false, error: 'no-scanner' })
})

// ---- how a paused item shows up -------------------------------------------------------------------------------------------------------

test('paused items do not count as waiting on the user, but have their own count', async () => {
  const { store, queue, tracker } = setup({ candidates: [cand('s1'), cand('s2')] })
  store.add({ type: 'completed', sessionId: 'c', payload: { reply: 'x' } })
  await tracker.scan()
  const c = queue.count()
  assert.equal(c.total, 1)
  assert.equal(c.byType.paused, 2)
  assert.equal(queue.snapshot().open.length, 3, 'they are in the list')
})

test('snapshot gives a paused item a title and speech; the card text reads as a cut-off session', async () => {
  const { queue, tracker } = setup({ candidates: [cand('s1')] })
  await tracker.scan()
  const item = queue.snapshot().open[0]
  assert.equal(item.title, 'Work of s1')
  assert.match(item.spoken.headline, /^Item 1\. Paused session Work of s1: cut off/)
  assert.match(fullTextFor(item, 1), /cut off.*Resume or dismiss it at the desktop/s)
  assert.equal(titleFor({ type: 'paused' }), 'Paused session')
  assert.ok(spokenFor({ type: 'paused', sessionTitle: 'x'.repeat(200) }).headline.length < 200)
})

test('a restart does not cancel paused items: the next scan decides', async () => {
  const { store, tracker } = setup({ candidates: [cand('s1')] })
  await tracker.scan()
  assert.equal(cancelStalePending(store), 0)
  assert.equal(openPaused(store).length, 1)
})

// ---- the routes -------------------------------------------------------------------------------------------------------------------------

async function withServer(t, queue) {
  const server = createServer(createRouter({ queue }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  const base = 'http://127.0.0.1:' + server.address().port
  return async (path, body) => { const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, json: await res.json() } }
}

test('POST /v1/paused-resume, /v1/paused-dismiss and /v1/paused-scan', async (t) => {
  const { store, queue, tracker, prompts } = setup({ candidates: [cand('s1'), cand('s2')] })
  const post = await withServer(t, queue)
  assert.deepEqual((await post('/v1/paused-scan', {})).json, { ok: true, added: 2, updated: 0, resolved: 0, total: 2 })
  const [a, b] = openPaused(store).map((i) => i.id)
  assert.deepEqual(await post('/v1/paused-resume', { id: a }), { status: 200, json: { ok: true } })
  assert.equal(prompts.length, 1)
  assert.deepEqual(await post('/v1/paused-dismiss', { id: b }), { status: 200, json: { ok: true } })
  assert.deepEqual(await post('/v1/paused-resume', { id: a }), { status: 409, json: { ok: false, error: 'not-open' } })
  await tracker.scan()
  assert.equal(openPaused(store).length, 0)
})
