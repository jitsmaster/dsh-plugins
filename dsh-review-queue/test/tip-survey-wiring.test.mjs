import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter, parseSince, fullStampOf, stampMatches } from '../server.js'
import { createReviewQueuePlugin } from '../index.js'
import { surveyCard, surveyKeyOf } from '../tip-survey.js'
import { hubSnap, startFakeHub, startProxy } from './agent-proxy-helpers.mjs'

// The wiring of "Find places" (tip-survey.js): the service methods, the snapshot field and the long-poll stamp, the route, the proxy (stays local) and the plugin (index.js).
const TIP = { id: 'tip1', title: 'Bloom filters', body: 'A Bloom filter is a bit array. It never gives a false negative.', category: 'algorithms', at: 1, source: 'model' }
const RECORD = {
  id: 's1', tipId: 'tip1', tipTitle: 'Bloom filters', tipBody: 'SECRET-TIP-BODY', workspaceId: 'w1', workspaceTitle: 'Alpha', todoId: 'td1', sessionId: 'sess-1', state: 'ready',
  places: [{ path: 'src/a.js', what: 'Scans a list.', ticket: { id: 901, url: 'https://dev.azure.com/o/p/_workitems/edit/901' } }, { path: 'src/b.js', what: 'Another list.', ticket: { error: 'http-401' } }],
  ticketsDone: true, startedAt: 5,
}

function fakeSurvey(records = []) {
  const s = {
    records, starts: [], listeners: [], stopped: 0,
    start(tipId, ws) { s.starts.push([tipId, ws]); return s.answer ?? { ok: true, survey: { ...RECORD, state: 'running' } } },
    state: () => s.records.map((r) => JSON.parse(JSON.stringify(r))),
    onChange: (fn) => { s.listeners.push(fn) },
    stop: () => { s.stopped++ },
    fire: () => s.listeners.forEach((l) => l()),
  }
  return s
}
function setup({ tipSurvey = fakeSurvey(), log, ...rest } = {}) {
  let t = 1000
  const store = createStore({ now: () => ++t })
  const tips = { tip: TIP, current: () => TIP, peek: () => TIP, onChange: () => () => {} }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => undefined, tips, tipSurvey, log, now: () => 5000, ...rest })
  return { queue, tipSurvey, store }
}

// ---- the card and the stamp key ------------------------------------------------------------------------------------------------------

test('surveyCard keeps only what the card needs: never the tip body, the todo id, the session id or the flags', () => {
  const card = surveyCard({ ...RECORD, error: undefined, ticketNote: 'not-linked' })
  assert.deepEqual(card, {
    id: 's1', tipId: 'tip1', tipTitle: 'Bloom filters', workspaceId: 'w1', workspaceTitle: 'Alpha', state: 'ready',
    places: [{ path: 'src/a.js', what: 'Scans a list.', ticket: { id: 901, url: 'https://dev.azure.com/o/p/_workitems/edit/901' } }, { path: 'src/b.js', what: 'Another list.', ticket: { error: 'http-401' } }],
    ticketNote: 'not-linked',
  })
  const failed = surveyCard({ id: 's2', tipId: 't', tipTitle: 'x', tipBody: 'b', workspaceId: 'w', workspaceTitle: 'W', todoId: 'td', state: 'failed', error: 'timeout' })
  assert.deepEqual(failed, { id: 's2', tipId: 't', tipTitle: 'x', workspaceId: 'w', workspaceTitle: 'W', state: 'failed', error: 'timeout' })
})

test('surveyKeyOf changes with every visible change of a survey and is empty without surveys; it never holds the stamp separator', () => {
  assert.equal(surveyKeyOf(undefined), '')
  assert.equal(surveyKeyOf([]), '')
  const running = surveyCard({ ...RECORD, state: 'running', places: undefined })
  const ready = surveyCard({ ...RECORD, places: [{ path: 'a', what: 'b' }] })
  const ticketed = surveyCard({ ...RECORD, places: [{ path: 'a', what: 'b', ticket: { id: 1, url: 'u' } }] })
  const keys = [running, ready, ticketed].map((c) => surveyKeyOf([c]))
  assert.equal(new Set(keys).size, 3)
  for (const k of keys) assert.doesNotMatch(k, /\|/)
  assert.notEqual(surveyKeyOf([running]), surveyKeyOf([running, ready]))
})

// ---- the service -------------------------------------------------------------------------------------------------------------------------

test('tipSurvey hands the tip id and the workspace to the survey and answers { ok, survey } as the card needs it', async () => {
  const { queue, tipSurvey } = setup()
  const result = await queue.tipSurvey('tip1', 'w1')
  assert.equal(result.ok, true)
  assert.deepEqual(tipSurvey.starts, [['tip1', 'w1']])
  assert.equal(result.survey.id, 's1')
  assert.equal(result.survey.state, 'running')
  for (const key of ['tipBody', 'todoId', 'sessionId']) assert.ok(!(key in result.survey), key)
})

test('tipSurvey maps the refusals: not-found, no-workspace, unknown-workspace, todo-failed, stopped', async () => {
  for (const error of ['not-found', 'no-workspace', 'unknown-workspace', 'todo-failed', 'stopped']) {
    const survey = fakeSurvey()
    survey.answer = { ok: false, error }
    assert.deepEqual(await setup({ tipSurvey: survey }).queue.tipSurvey('tip1', 'w1'), { ok: false, error })
  }
})

test('tipSurvey says "no survey available" without the dependency, and never throws (only a short reason is logged, never the message)', async () => {
  assert.deepEqual(await setup({ tipSurvey: null }).queue.tipSurvey('tip1', 'w1'), { ok: false, error: 'no survey available' })
  const logs = []
  const survey = fakeSurvey()
  survey.start = () => { throw Object.assign(new Error('secret https://x/?key=sk-abcdefghijklmnop1234'), { code: 'ECONNRESET' }) }
  const { queue } = setup({ tipSurvey: survey, log: (l) => logs.push(l) })
  const result = await queue.tipSurvey('tip1', 'w1')
  assert.equal(result.ok, false)
  assert.match(result.error, /^[a-z -]+$/)
  assert.ok(logs.length)
  assert.doesNotMatch(logs.join('\n'), /secret|https|sk-abc/)
  assert.match(logs.join('\n'), /ECONNRESET/)
})

test('tipSurvey coerces a non-string tip id like the other tip methods (an id is always a string)', async () => {
  const { queue, tipSurvey } = setup()
  await queue.tipSurvey(undefined, undefined)
  assert.deepEqual(tipSurvey.starts, [['undefined', undefined]])
})

test('tipSurveyState answers { ok, surveys } as cards (also none, and without the dependency)', () => {
  const { queue } = setup({ tipSurvey: fakeSurvey([RECORD]) })
  const { ok, surveys } = queue.tipSurveyState()
  assert.equal(ok, true)
  assert.deepEqual(surveys, [surveyCard(RECORD)])
  assert.deepEqual(setup().queue.tipSurveyState(), { ok: true, surveys: [] })
  assert.deepEqual(setup({ tipSurvey: null }).queue.tipSurveyState(), { ok: true, surveys: [] })
})

test('the snapshot has a tipSurvey field only when there is a record, with no body, todo id or session id', () => {
  assert.ok(!('tipSurvey' in setup().queue.snapshot()), 'no records: the shape is unchanged')
  assert.ok(!('tipSurvey' in setup({ tipSurvey: null }).queue.snapshot()))
  const snap = setup({ tipSurvey: fakeSurvey([RECORD]) }).queue.snapshot()
  assert.deepEqual(snap.tipSurvey, [surveyCard(RECORD)])
  assert.doesNotMatch(JSON.stringify(snap), /SECRET-TIP-BODY|td1|sess-1/)
})

test('the snapshot card carries ticketsPending while the tickets are made, and only then', () => {
  const pending = setup({ tipSurvey: fakeSurvey([{ ...RECORD, ticketsPending: true }]) }).queue.snapshot()
  assert.equal(pending.tipSurvey[0].ticketsPending, true)
  assert.ok(!('ticketsPending' in setup({ tipSurvey: fakeSurvey([RECORD]) }).queue.snapshot().tipSurvey[0]))
  assert.notEqual(surveyKeyOf([surveyCard({ ...RECORD, ticketsPending: true })]), surveyKeyOf([surveyCard(RECORD)]))
})

test('a throwing survey never breaks the snapshot', () => {
  const survey = fakeSurvey()
  survey.state = () => { throw new Error('x') }
  assert.ok(!('tipSurvey' in setup({ tipSurvey: survey }).queue.snapshot()))
  assert.deepEqual(setup({ tipSurvey: survey }).queue.tipSurveyState(), { ok: true, surveys: [] })
})

test('a survey change wakes the listeners of the queue (the long polls)', () => {
  const { queue, tipSurvey } = setup()
  let woke = 0
  queue.onChange(() => woke++)
  tipSurvey.fire()
  assert.equal(woke, 1)
})

test('the service builds the survey itself from tipSurveyDeps (todos of its own store, change hook on its emit) and stopTipSurvey stops it', async () => {
  let t = 1000
  const store = createStore({ now: () => ++t })
  const timers = { set: () => 1, cleared: 0, clear() { timers.cleared++ } }
  const queue = createReviewQueue({
    store, capture: {}, controllerOf: () => undefined, tips: { current: () => TIP, peek: () => TIP, onChange: () => () => {} }, now: () => 5000,
    registryOf: () => ({ list: () => [{ id: 'w1', title: 'Alpha', path: 'D:/a', sessionIds: [] }], archivedSessionIds: [] }),
    tipSurveyDeps: { readLog: async () => undefined, workspacesOf: () => [{ id: 'w1', title: 'Alpha', path: 'D:/a' }], tipOf: (id) => (id === 'tip1' ? TIP : undefined), timers },
  })
  let woke = 0
  queue.onChange(() => woke++)
  const result = await queue.tipSurvey('tip1', 'w1')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(store.list({ status: 'open' }).filter((i) => i.type === 'todo').length, 1, 'a todo of this store was added')
  assert.ok(woke >= 1, 'the start woke the listeners')
  assert.equal(queue.snapshot().tipSurvey.length, 1)
  queue.stopTipSurvey()
  assert.equal(timers.cleared, 1)
  assert.deepEqual(await queue.tipSurvey('tip1', 'w1'), { ok: false, error: 'stopped' })
  assert.doesNotThrow(() => setup({ tipSurvey: null }).queue.stopTipSurvey())
})

// ---- the stamp ---------------------------------------------------------------------------------------------------------------------------

test('parseSince keeps the survey part, and an older token (fewer parts) still parses and matches', () => {
  assert.equal(parseSince('a|b|c|1|2/3|tip|key|SURV'), 'a|b|c|1|2/3|tip|key|SURV')
  assert.equal(parseSince('a|b|c|1|2/3|tip|key'), 'a|b|c|1|2/3|tip|key')
  assert.equal(parseSince('a|b|c|1'), 'a|b|c|1')
  assert.equal(parseSince('a|b|c|1|x|y|z|w|extra'), 'a|b|c|1|x|y|z|w')
})

test('the stamp holds the survey key; tokens without it still match, tokens with the old key do not', () => {
  const { queue, tipSurvey } = setup()
  const empty = queue.snapshot()
  const emptyStamp = fullStampOf(empty)
  assert.equal(emptyStamp.split('|').length, 8)
  assert.ok(stampMatches(empty, parseSince(emptyStamp)))
  tipSurvey.records.push(RECORD)
  const withSurvey = queue.snapshot()
  assert.notEqual(fullStampOf(withSurvey), emptyStamp)
  assert.ok(!stampMatches(withSurvey, parseSince(emptyStamp)), 'a client that sent the survey part sees the change')
  const seven = emptyStamp.split('|').slice(0, 7).join('|')
  assert.ok(stampMatches(withSurvey, parseSince(seven)), 'an older client (7 parts) is not woken by it and gets no full snapshot for a part it does not know')
  assert.ok(stampMatches(withSurvey, parseSince(fullStampOf(withSurvey))))
  const state2 = { ...RECORD, state: 'running', places: undefined }
  tipSurvey.records[0] = state2
  assert.ok(!stampMatches(queue.snapshot(), parseSince(fullStampOf(withSurvey))), 'a state change changes the stamp')
})

// ---- the routes --------------------------------------------------------------------------------------------------------------------------

async function serve(t, queue) {
  const server = createServer(createRouter({ queue }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const base = 'http://127.0.0.1:' + server.address().port
  const post = async (path, body) => { const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, json: await res.json() } }
  const get = async (path) => { const res = await fetch(base + path); return { status: res.status, json: await res.json().catch(() => undefined) } }
  return { post, get }
}

test('POST /v1/tip-survey { id, workspaceId } answers like /v1/tip-todo and starts the survey', async (t) => {
  const { queue, tipSurvey } = setup()
  const { post, get } = await serve(t, queue)
  const res = await post('/v1/tip-survey', { id: 'tip1', workspaceId: 'w1' })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.survey.id, 's1')
  assert.deepEqual(tipSurvey.starts.at(-1), ['tip1', 'w1'])
  await post('/v1/tip-survey', { id: 'tip1', workspaceId: '' })
  assert.deepEqual(tipSurvey.starts.at(-1), ['tip1', undefined], 'an empty workspace id is none')
  assert.equal((await get('/v1/tip-survey')).status, 405, 'POST only')
})

test('the route maps the error codes like tip-todo: no-workspace and unknown-workspace are 400, a missing tip and the others 409', async (t) => {
  const survey = fakeSurvey()
  const { post } = await serve(t, setup({ tipSurvey: survey }).queue)
  const expect = { 'no-workspace': 400, 'unknown-workspace': 400, 'not-found': 409, 'todo-failed': 409, stopped: 409, 'no survey available': 409 }
  for (const [error, status] of Object.entries(expect)) {
    survey.answer = { ok: false, error }
    assert.deepEqual(await post('/v1/tip-survey', { id: 'tip1', workspaceId: 'w1' }), { status, json: { ok: false, error } }, error)
  }
  assert.deepEqual(await post('/v1/tip-survey', {}), { status: 409, json: { ok: false, error: 'no survey available' } }, 'no id: the survey decides (here the last answer)')
})

test('a survey change wakes a long poll that sent the full token, which then gets the snapshot with the survey; an old 7-part poll stays quiet', async (t) => {
  const { queue, tipSurvey } = setup()
  const { get } = await serve(t, queue)
  const stamp = fullStampOf(queue.snapshot())
  const old = stamp.split('|').slice(0, 7).join('|')
  const started = Date.now()
  const pending = get('/v1/snapshot?wait=5000&since=' + encodeURIComponent(stamp))
  const oldPending = get('/v1/snapshot?wait=700&since=' + encodeURIComponent(old))
  await new Promise((r) => setTimeout(r, 50))
  tipSurvey.records.push(RECORD)
  tipSurvey.fire()
  const woken = await pending
  assert.ok(Date.now() - started < 3000, 'woken, not timed out')
  assert.equal(woken.json.unchanged, undefined)
  assert.equal(woken.json.tipSurvey.length, 1)
  const quiet = await oldPending
  assert.equal(quiet.json.unchanged, true, 'an older client does not get a full snapshot for a part it cannot know')
})

// ---- hub mode: the proxy keeps the route with this app ------------------------------------------------------------------------------------

test('in hub mode /v1/tip-survey stays with this app: the local service answers and the hub is not asked', async (t) => {
  const hub = await startFakeHub(t)
  hub.respond = () => [200, hubSnap('E:5', [])]
  const { queue, tipSurvey } = setup()
  const p = await startProxy(t, { hub, queue })
  const res = await p.post('/v1/tip-survey', { id: 'tip1', workspaceId: 'w1' })
  assert.equal(res.json.ok, true)
  assert.deepEqual(tipSurvey.starts, [['tip1', 'w1']])
  // the fake hub records { method, url, headers, body } (agent-proxy-helpers.mjs): a forwarded call would show up with url '/v1/tip-survey'
  assert.ok(Array.isArray(hub.requests) && hub.requests.every((r) => typeof r.url === 'string'), 'the recorded requests carry a url')
  assert.deepEqual(hub.requests.filter((r) => r.url.includes('tip-survey')), [])
})

// ---- the plugin ----------------------------------------------------------------------------------------------------------------------------

function host(registry) {
  const cleanups = []
  const created = []
  const ctx = {
    on() {},
    get: (name) => ({ workspaceRegistry: registry, sessionController: { create: async () => { created.push(1); return { sessionId: 'sess-1' } }, prompt: async () => {}, rename: async () => {} } })[name],
    effect: (fn) => { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    provide() {},
    logger: { warn() {}, info() {} },
    inject: (_n, fn) => fn({ effect: (f) => f(), connection: { admit: () => ({}) }, webServer: { port: 1, register() {} } }),
  }
  return { ctx, created, stop: async () => { for (const off of cleanups.splice(0)) await off() } }
}
const tmp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'rq-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
const fakeTimers = () => { const f = { live: new Set(), n: 0, set: () => { const id = ++f.n; f.live.add(id); return id }, clear: (id) => { f.live.delete(id) } }; return f }
const REGISTRY = { list: () => [{ id: 'w1', title: 'Alpha', path: 'D:/alpha', sessionIds: [] }], archivedSessionIds: [] }

test('plugin: Find places starts a survey todo in a workspace of this app, shows it in the snapshot and leaves no timer after the plugin stops', async (t) => {
  const h = host(REGISTRY)
  const timers = fakeTimers()
  const plugin = createReviewQueuePlugin(h.ctx, { hub: false, stateDir: tmp(t), taskbarBadge: false, paused: false, tipSurveyDeps: { timers, readLog: async () => undefined } })
  t.after(h.stop)
  const tip = plugin.local.currentTip().tip // a built-in tip: no model in this test
  assert.ok(tip?.id)
  const result = await plugin.local.tipSurvey(tip.id, 'w1')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(plugin.local.snapshot().tipSurvey.length, 1)
  assert.equal(timers.live.size, 1, 'the poll timer runs while the survey runs')
  assert.deepEqual(await plugin.local.tipSurvey('nope', 'w1'), { ok: false, error: 'not-found' })
  assert.deepEqual(await plugin.local.tipSurvey(tip.id, 'zzz'), { ok: false, error: 'unknown-workspace' }, 'a hub workspace (<app>/<id>) is not in this app\'s registry')
  await h.stop()
  assert.equal(timers.live.size, 0, 'no timer is left')
  assert.deepEqual(await plugin.local.tipSurvey(tip.id, 'w1'), { ok: false, error: 'stopped' })
})

test('plugin: config.tipSurveyDeps replaces parts (tipOf, workspacesOf)', async (t) => {
  const h = host({ list: () => [{ id: 'w1', title: 'Alpha', path: 'D:/alpha', sessionIds: [] }, { id: 'x1', title: 'X', path: 'D:/x', sessionIds: [] }], archivedSessionIds: [] })
  const plugin = createReviewQueuePlugin(h.ctx, { hub: false, stateDir: tmp(t), taskbarBadge: false, paused: false, tipSurveyDeps: { timers: fakeTimers(), workspacesOf: () => [{ id: 'x1', title: 'X', path: 'D:/x' }], tipOf: (id) => (id === 'tip1' ? TIP : undefined) } })
  t.after(h.stop)
  assert.equal((await plugin.local.tipSurvey('tip1', 'w1')).error, 'unknown-workspace', 'workspacesOf was replaced')
  assert.equal((await plugin.local.tipSurvey('tip1', 'x1')).ok, true)
})

test('plugin: the queue the plugin provides has both survey methods', async (t) => {
  const h = host(REGISTRY)
  const plugin = createReviewQueuePlugin(h.ctx, { hub: false, stateDir: tmp(t), taskbarBadge: false, paused: false, tipSurveyDeps: { timers: fakeTimers() } })
  t.after(h.stop)
  assert.equal(typeof plugin.queue.tipSurvey, 'function')
  assert.equal(typeof plugin.queue.tipSurveyState, 'function')
})
