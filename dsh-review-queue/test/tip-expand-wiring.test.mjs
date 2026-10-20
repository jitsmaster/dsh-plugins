import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { createTipper, HOLD_MS, TIP_TTL_MS } from '../tip.js'
import { hubSnap, startFakeHub, startProxy } from './agent-proxy-helpers.mjs'

// The wiring of "Go deeper" and "Use in my code": the tip holder (attach / hold), reading the longer text aloud, the service methods, the two routes,
// and the proxy that keeps both with this app (the model and the speaker belong to the local app, never the hub).
const TIP = { id: 'tip1', title: 'Bloom filters', body: 'A Bloom filter is a bit array. It never gives a false negative.', category: 'algorithms', at: 1, source: 'model' }
const DEEPER = { paragraphs: ['It sets one bit per hash function. A zero bit proves absence.', 'A crawler asks first. Deletion is not possible.'], source: 'model' }

// ---- the tip holder ----------------------------------------------------------------------------------------------------------------------

function clock(start = 1_000_000) { let t = start; return { now: () => t, advance: (ms) => { t += ms } } }
function builtinTipper() {
  const c = clock()
  let n = 0
  const tipper = createTipper({ now: c.now, uuid: () => 'id' + ++n })
  return { tipper, c }
}

test('attach puts the longer text on the current tip, wakes the listeners and says whether the id was current', () => {
  const { tipper } = builtinTipper()
  const tip = tipper.current()
  let woke = 0
  tipper.onChange(() => woke++)
  assert.equal(tipper.attach('nope', DEEPER), false)
  assert.equal(tipper.peek().deeper, undefined)
  assert.equal(woke, 0)
  assert.equal(tipper.attach(tip.id, DEEPER), true)
  assert.deepEqual(tipper.peek().deeper, DEEPER)
  assert.equal(tipper.current().id, tip.id)
  assert.equal(woke, 1)
  assert.equal(tipper.attach(tip.id, { paragraphs: [], source: 'model' }), true, 'a second attach just replaces it')
})

test('a tip with its longer text open is kept past the 5 minute slot, and is replaced once nobody touched it for the hold time', () => {
  const { tipper, c } = builtinTipper()
  const first = tipper.current()
  tipper.attach(first.id, DEEPER)
  c.advance(TIP_TTL_MS + 1)
  assert.equal(tipper.current().id, first.id, 'still the same tip after the slot')
  c.advance(HOLD_MS - TIP_TTL_MS - 10)
  assert.equal(tipper.current().id, first.id, 'still held just before the hold time')
  c.advance(20)
  const next = tipper.current()
  assert.notEqual(next.id, first.id, 'replaced after the hold time')
  assert.equal(next.deeper, undefined)
})

test('hold keeps a tip too (the todo draft), only for the current id, and each hold restarts the time', () => {
  const { tipper, c } = builtinTipper()
  const first = tipper.current()
  assert.equal(tipper.hold('nope'), false)
  assert.equal(tipper.hold(first.id), true)
  c.advance(HOLD_MS - 1000)
  assert.equal(tipper.hold(first.id), true)
  c.advance(HOLD_MS - 1000)
  assert.equal(tipper.current().id, first.id)
  c.advance(2000)
  assert.notEqual(tipper.current().id, first.id)
})

test('a tip that was never held or deepened is replaced after 5 minutes as before', () => {
  const { tipper, c } = builtinTipper()
  const first = tipper.current()
  c.advance(TIP_TTL_MS + 1)
  assert.notEqual(tipper.current().id, first.id)
})

// ---- the service -------------------------------------------------------------------------------------------------------------------------

function fakeSpeaker() { const s = { spoken: [], speak(chunks) { s.spoken.push(chunks); return { ok: true } }, stop() {} }; return s }
function fakeTips(tip = TIP) { return { tip, current: () => tip, peek: () => tip, onChange: () => () => {} } }
function fakeExpand(over = {}) {
  const e = { calls: [], async deeper(id) { e.calls.push(['deeper', id]); return { ok: true, deeper: DEEPER } }, async draft(id, ws, opts) { e.calls.push(['draft', id, ws, ...(opts ? [opts] : [])]); return { ok: true, text: 'Apply the idea here.', workspaceId: ws, source: 'model' } }, ...over }
  return e
}
function setup({ tips = fakeTips(), speaker = fakeSpeaker(), tipExpand = fakeExpand(), log } = {}) {
  let t = 1000
  const store = createStore({ now: () => ++t })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => undefined, tips, speaker, tipExpand, log, now: () => 5000 })
  return { queue, speaker, tipExpand }
}

test('the snapshot carries the longer text of the tip', () => {
  const { queue } = setup({ tips: fakeTips({ ...TIP, deeper: DEEPER }) })
  assert.deepEqual(queue.snapshot({ tip: true }).tip.deeper, DEEPER)
})

test('readTip reads the title, the body and then the longer text, one chunk per sentence', () => {
  const { queue, speaker } = setup({ tips: fakeTips({ ...TIP, deeper: DEEPER }) })
  assert.deepEqual(queue.readTip('tip1'), { ok: true })
  assert.deepEqual(speaker.spoken[0], ['Bloom filters.', 'A Bloom filter is a bit array.', 'It never gives a false negative.', 'It sets one bit per hash function.', 'A zero bit proves absence.', 'A crawler asks first.', 'Deletion is not possible.'])
})

test('readTip without longer text is unchanged', () => {
  const { queue, speaker } = setup()
  queue.readTip('tip1')
  assert.deepEqual(speaker.spoken[0], ['Bloom filters.', 'A Bloom filter is a bit array.', 'It never gives a false negative.'])
})

test('tipTodo hands the caller title (hub mode) on to the expander', async () => {
  const { queue, tipExpand } = setup()
  await queue.tipTodo('tip1', 'ab12/w1', { title: 'Alpha' })
  assert.deepEqual(tipExpand.calls, [['draft', 'tip1', 'ab12/w1', { title: 'Alpha' }]])
})

test('tipDeeper and tipTodo hand the id (and workspace) to the expander and return its answer', async () => {
  const { queue, tipExpand } = setup()
  assert.deepEqual(await queue.tipDeeper('tip1'), { ok: true, deeper: DEEPER })
  assert.deepEqual(await queue.tipTodo('tip1', 'w1'), { ok: true, text: 'Apply the idea here.', workspaceId: 'w1', source: 'model' })
  assert.deepEqual(tipExpand.calls, [['deeper', 'tip1'], ['draft', 'tip1', 'w1']])
})

test('an unexpected throw is logged by its code or name only, never its message (a provider message can carry an endpoint or a key)', async () => {
  const logs = []
  const err = Object.assign(new Error('secret https://x/?key=sk-abcdefghijklmnop1234'), { code: 'ECONNRESET' })
  const { queue } = setup({ log: (l) => logs.push(l), tipExpand: fakeExpand({ deeper: async () => { throw err } }) })
  await queue.tipDeeper('tip1')
  assert.ok(logs.length, 'something is logged')
  assert.doesNotMatch(logs.join('\n'), /secret|https|sk-abc/)
  assert.match(logs.join('\n'), /ECONNRESET/)
})

test('without an expander both say no model available; an expander that throws gives a generic LLM error and never throws', async () => {
  const { queue } = setup({ tipExpand: null })
  assert.deepEqual(await queue.tipDeeper('tip1'), { ok: false, error: 'no model available' })
  assert.deepEqual(await queue.tipTodo('tip1', 'w1'), { ok: false, error: 'no model available' })
  const boom = setup({ tipExpand: fakeExpand({ deeper: async () => { throw new Error('secret https://x/?key=1') }, draft: async () => { throw new Error('x') } }) })
  assert.deepEqual(await boom.queue.tipDeeper('tip1'), { ok: false, error: 'LLM error' })
  assert.deepEqual(await boom.queue.tipTodo('tip1', 'w1'), { ok: false, error: 'LLM error' })
})

// ---- the routes --------------------------------------------------------------------------------------------------------------------------

async function serve(t, queue) {
  const server = createServer(createRouter({ queue }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const base = 'http://127.0.0.1:' + server.address().port
  const post = async (path, body) => { const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, json: await res.json() } }
  const get = async (path) => (await fetch(base + path)).status
  return { post, get }
}

test('POST /v1/tip-deeper { id } and /v1/tip-todo { id, workspaceId } answer like the other actions', async (t) => {
  const { queue, tipExpand } = setup()
  const { post, get } = await serve(t, queue)
  assert.deepEqual(await post('/v1/tip-deeper', { id: 'tip1' }), { status: 200, json: { ok: true, deeper: DEEPER } })
  assert.deepEqual(await post('/v1/tip-todo', { id: 'tip1', workspaceId: 'w1' }), { status: 200, json: { ok: true, text: 'Apply the idea here.', workspaceId: 'w1', source: 'model' } })
  assert.deepEqual(tipExpand.calls.at(-1), ['draft', 'tip1', 'w1'])
  await post('/v1/tip-todo', { id: 'tip1', workspaceId: '' })
  assert.deepEqual(tipExpand.calls.at(-1), ['draft', 'tip1', undefined], 'an empty workspace id is none')
  assert.equal(await get('/v1/tip-deeper'), 405, 'POST only')
})

test('the routes map the error codes: refusals are 409, a missing or unknown workspace is 400', async (t) => {
  const tipExpand = fakeExpand({ async deeper() { return { ok: false, error: 'not-found' } }, async draft(id, ws) { return { ok: false, error: ws ? 'unknown-workspace' : 'no-workspace' } } })
  const { post } = await serve(t, setup({ tipExpand }).queue)
  assert.deepEqual(await post('/v1/tip-deeper', { id: 'x' }), { status: 409, json: { ok: false, error: 'not-found' } })
  assert.deepEqual(await post('/v1/tip-todo', { id: 'tip1', workspaceId: 'gone' }), { status: 400, json: { ok: false, error: 'unknown-workspace' } })
  assert.deepEqual(await post('/v1/tip-todo', { id: 'tip1' }), { status: 400, json: { ok: false, error: 'no-workspace' } })
  assert.deepEqual(await post('/v1/tip-deeper', {}), { status: 409, json: { ok: false, error: 'not-found' } })
})

// ---- hub mode ----------------------------------------------------------------------------------------------------------------------------

test('in hub mode both tip actions stay with this app: the local service answers and the hub is not asked', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, hubSnap('E:5', [])]
  const { queue, tipExpand } = setup()
  const p = await startProxy(t, { hub, queue })
  assert.deepEqual((await p.post('/v1/tip-deeper', { id: 'tip1' })).json, { ok: true, deeper: DEEPER })
  assert.deepEqual((await p.post('/v1/tip-todo', { id: 'tip1', workspaceId: 'w1' })).json.workspaceId, 'w1')
  assert.deepEqual(tipExpand.calls.map((c) => c[0]), ['deeper', 'draft'])
  assert.equal(hub.requests?.filter((r) => /tip/.test(r.path ?? r.url ?? '')).length ?? 0, 0)
})

// ---- limits on the hold --------------------------------------------------------------------------------------------------------------------

test('repeated holds cannot pin a tip for ever: the hold ends 3 hold times after the first one', () => {
  const { tipper, c } = builtinTipper()
  const first = tipper.current()
  let replacedAt
  for (let minutes = 0; minutes <= 70 && replacedAt === undefined; minutes += 10) {
    tipper.hold(first.id)
    if (tipper.current().id !== first.id) replacedAt = minutes
    c.advance(10 * 60_000)
  }
  assert.ok(replacedAt !== undefined && replacedAt <= 50, 'the tip was replaced although it was held again every 10 minutes (replaced at ' + replacedAt + ')')
  assert.ok(replacedAt >= 40, 'the cap is not shorter than 3 hold times: ' + replacedAt)
})

function gatedLlm(answer) {
  let release
  const gate = new Promise((r) => { release = r })
  const llm = { listProviders: async () => [{ id: 'p' }], listModels: async () => [{ id: 'claude-haiku-x' }], prepareCall: async () => ({ config: {}, stream: async function* () { await gate; yield { type: 'text-delta', text: answer } } }) }
  return { llm, release }
}
test('a tip being generated when the user clicks Go deeper does not replace the held tip', async () => {
  const c = clock()
  let llm
  let n = 0
  const tipper = createTipper({ llm: () => llm, now: c.now, uuid: () => 'id' + ++n })
  const first = tipper.current() // no model: a built-in tip at once
  const gated = gatedLlm(JSON.stringify({ title: 'Consistent hashing', body: 'Keys and servers sit on a ring. A key belongs to the next server clockwise.', category: 'algorithms' }))
  llm = gated.llm
  c.advance(TIP_TTL_MS + 1)
  tipper.current() // the slot ended: a new tip is being generated
  assert.equal(tipper.hold(first.id), true, 'the user clicked while it is being generated')
  gated.release()
  await tipper.idle()
  assert.equal(tipper.current().id, first.id, 'the held tip stays')
})

test('tipTodo works with an expander that only has draft, and tipDeeper with one that only has deeper (each method is checked on its own)', async () => {
  const onlyDraft = setup({ tipExpand: { async draft(id, ws) { return { ok: true, text: 'x', workspaceId: ws, source: 'model' } } } })
  assert.equal((await onlyDraft.queue.tipTodo('tip1', 'w1')).ok, true)
  assert.deepEqual(await onlyDraft.queue.tipDeeper('tip1'), { ok: false, error: 'no model available' })
  const onlyDeeper = setup({ tipExpand: { async deeper() { return { ok: true, deeper: DEEPER } } } })
  assert.equal((await onlyDeeper.queue.tipDeeper('tip1')).ok, true)
  assert.deepEqual(await onlyDeeper.queue.tipTodo('tip1', 'w1'), { ok: false, error: 'no model available' })
})
