import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { LIMIT_SIGNIN, RESUME_CONCURRENCY, RESUME_PROMPT } from '../paused.js'
import { startPhoneHub, P } from './hub-device-helpers.mjs'

const speaker = { speak: () => ({ ok: true }), stop() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function make({ limitSignIn, prompt } = {}) {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const prompts = []
  const controller = { prompt: prompt ?? (async (req) => { prompts.push(req) }) }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, speaker, limitSignIn, uuid: () => 'u' + ++n })
  const paused = (sessionId, kinds) => store.add({ type: 'paused', sessionId, sessionTitle: sessionId, workspace: 'w', payload: { kinds, reason: 'r' } })
  const pinned = () => store.add({ type: 'paused', sessionId: '', sessionTitle: 'Session limit reached', workspace: '', payload: { kinds: [LIMIT_SIGNIN], count: 2, state: 'signed-in', note: '' } })
  return { store, queue, prompts, paused, pinned }
}

// ---- service ------------------------------------------------------------------------------------------------------------------------------
test('limit sign-in methods delegate to the injected limitSignIn', async () => {
  const calls = []
  const limitSignIn = { start: async (a) => { calls.push(['start', a]); return { ok: true, email: 'a@b.co' } }, code: async (c) => { calls.push(['code', c]); return { ok: true } }, cancel: async () => { calls.push(['cancel']); return { ok: true } } }
  const { queue, pinned } = make({ limitSignIn }); pinned()
  assert.deepEqual(await queue.limitSignInStart({ email: 'a@b.co' }), { ok: true, email: 'a@b.co' })
  assert.deepEqual(await queue.limitSignInCode({ code: 'xyz#1' }), { ok: true })
  assert.deepEqual(await queue.limitSignInCancel(), { ok: true })
  assert.deepEqual(calls, [['start', { email: 'a@b.co' }], ['code', 'xyz#1'], ['cancel']])
})

// Peer review Medium: an app with no open pinned card of its own (hub mode, another app owns it) must not start a run it cannot show.
test('limitSignInStart without an open pinned card is refused (no-limit-card) and starts nothing; with one it delegates', async () => {
  const calls = []
  const limitSignIn = { start: async (a) => { calls.push(a); return { ok: true, email: 'a@b.co' } }, state: () => ({ running: false }) }
  const { queue, pinned } = make({ limitSignIn })
  assert.deepEqual(await queue.limitSignInStart({ email: 'a@b.co' }), { ok: false, error: 'no-limit-card' })
  assert.deepEqual(calls, [])
  pinned()
  assert.deepEqual(await queue.limitSignInStart({ email: 'a@b.co' }), { ok: true, email: 'a@b.co' })
  assert.equal(calls.length, 1)
})

test('without a limitSignIn the three methods answer no-limit-signin', async () => {
  const { queue } = make()
  for (const r of [await queue.limitSignInStart({ email: 'a@b.co' }), await queue.limitSignInCode({ code: 'x' }), await queue.limitSignInCancel()]) assert.deepEqual(r, { ok: false, error: 'no-limit-signin' })
})

test('limitResume resumes only open limit items: not restart items, not the pinned item, none before it is called', async () => {
  const { queue, prompts, paused, pinned, store } = make()
  const a = paused('s1', ['limit']); paused('s2', ['limit', 'pending-inbox']); paused('s3', ['disposed']); paused('s4', ['interrupted']); const pin = pinned()
  assert.equal(prompts.length, 0)
  assert.deepEqual(await queue.limitResume(), { ok: true, resumed: 2, failed: 0 })
  assert.deepEqual(prompts.map((p) => p.sessionId).sort(), ['s1', 's2'])
  for (const p of prompts) assert.equal(p.content[0].text, RESUME_PROMPT)
  assert.equal(store.get(a.id).status, 'resolved')
  assert.equal(store.get(pin.id).status, 'open')
  assert.deepEqual(store.list({ status: 'open' }).filter((i) => !i.payload.kinds.includes('limit') && !i.payload.kinds.includes(LIMIT_SIGNIN)).length, 2)
})

test('limitResume runs at most RESUME_CONCURRENCY at a time and counts failures', async () => {
  let live = 0; let peak = 0; let calls = 0
  const { queue, paused } = make({ prompt: async () => { const me = ++calls; live++; peak = Math.max(peak, live); await sleep(15); live--; if (me === 2) throw new Error('boom') } })
  for (let i = 0; i < 8; i++) paused('s' + i, ['limit'])
  assert.deepEqual(await queue.limitResume(), { ok: true, resumed: 7, failed: 1 })
  assert.equal(peak, RESUME_CONCURRENCY)
})

test('limitResume with nothing to resume answers resumed 0', async () => {
  const { queue, pinned } = make(); pinned()
  assert.deepEqual(await queue.limitResume(), { ok: true, resumed: 0, failed: 0 })
})

// ---- routes -------------------------------------------------------------------------------------------------------------------------------
async function serve(t, queue) {
  const router = createRouter({ queue })
  const server = createServer((req, res) => router(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const base = 'http://127.0.0.1:' + server.address().port
  return async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
}

test('routes: start/code/cancel/resume reach the queue and answer 200', async (t) => {
  const seen = []
  const limitSignIn = { start: async (a) => { seen.push(a); return { ok: true, email: a.email } }, code: async (c) => { seen.push(c); return { ok: true } }, cancel: async () => ({ ok: true }) }
  const { queue, paused, pinned } = make({ limitSignIn }); paused('s1', ['limit']); pinned()
  const post = await serve(t, queue)
  assert.deepEqual(await post('/v1/limit-signin-start', { email: 'a@b.co' }), { status: 200, json: { ok: true, email: 'a@b.co' } })
  assert.deepEqual(await post('/v1/limit-signin-code', { code: 'abc#def' }), { status: 200, json: { ok: true } })
  assert.deepEqual(await post('/v1/limit-signin-cancel', {}), { status: 200, json: { ok: true } })
  assert.deepEqual(await post('/v1/limit-resume', {}), { status: 200, json: { ok: true, resumed: 1, failed: 0 } })
})

test('routes: non-string email/code are 400 bad-email/bad-code without reaching the queue', async (t) => {
  let reached = 0
  const limitSignIn = { start: async () => { reached++; return { ok: true } }, code: async () => { reached++; return { ok: true } }, cancel: async () => ({ ok: true }) }
  const post = await serve(t, make({ limitSignIn }).queue)
  for (const body of [{}, { email: 5 }, { email: ['a@b.co'] }]) assert.deepEqual(await post('/v1/limit-signin-start', body), { status: 400, json: { ok: false, error: 'bad-email' } })
  for (const body of [{}, { code: 5 }, { code: {} }]) assert.deepEqual(await post('/v1/limit-signin-code', body), { status: 400, json: { ok: false, error: 'bad-code' } })
  assert.equal(reached, 0)
})

test('routes: error codes map consistently (bad-* 400, busy / no-run 409, no-limit-signin 409)', async (t) => {
  const limitSignIn = { start: async () => ({ ok: false, error: 'busy' }), code: async () => ({ ok: false, error: 'no-run' }), cancel: async () => ({ ok: false, error: 'no-run' }) }
  const m1 = make({ limitSignIn }); m1.pinned()
  const post = await serve(t, m1.queue)
  assert.deepEqual(await post('/v1/limit-signin-start', { email: 'a@b.co' }), { status: 409, json: { ok: false, error: 'busy' } })
  assert.deepEqual(await post('/v1/limit-signin-code', { code: 'x' }), { status: 409, json: { ok: false, error: 'no-run' } })
  assert.deepEqual(await post('/v1/limit-signin-cancel', {}), { status: 409, json: { ok: false, error: 'no-run' } })
  const bad = { start: async () => ({ ok: false, error: 'bad-email' }), code: async () => ({ ok: false, error: 'bad-code' }), cancel: async () => ({ ok: true }) }
  const m2 = make({ limitSignIn: bad }); m2.pinned()
  const post2 = await serve(t, m2.queue)
  assert.equal((await post2('/v1/limit-signin-start', { email: 'x' })).status, 400)
  assert.equal((await post2('/v1/limit-signin-code', { code: 'x' })).status, 400)
  const none = await serve(t, make().queue)
  assert.deepEqual(await none('/v1/limit-signin-start', { email: 'a@b.co' }), { status: 409, json: { ok: false, error: 'no-limit-signin' } })
})

test('the code never appears in an answer or a log line, a rejected code included', async (t) => {
  const SECRET_CODE = 'sEcReT-code-123#state456'
  const logs = []
  const limitSignIn = { start: async () => ({ ok: true }), code: async () => ({ ok: false, error: 'no-run', echo: SECRET_CODE }), cancel: async () => ({ ok: true }) }
  let n = 0
  const queue = createReviewQueue({ store: createStore({ uuid: () => 'i' + ++n }), capture: {}, controllerOf: () => ({}), speaker, limitSignIn, log: (l) => logs.push(l) })
  const post = await serve(t, queue)
  const r = await post('/v1/limit-signin-code', { code: SECRET_CODE })
  assert.ok(!JSON.stringify(r).includes(SECRET_CODE))
  assert.ok(!logs.join('\n').includes(SECRET_CODE))
})

// ---- hub: desktop only, and the app that serves the request runs them ---------------------------------------------------------------------------
test('hub mode: the four actions run in this app and never go through the hub; the code stays out of the mirror and items', async () => {
  const hubCalls = []
  const local = make({ limitSignIn: { start: async (a) => ({ ok: true, email: a.email }), code: async () => ({ ok: true }), cancel: async () => ({ ok: true }) } })
  local.paused('s1', ['limit']); local.pinned()
  const client = { state: 'connected', mirror: { ready: true, snapshot: () => ({ snapshotId: 'E:1', serverNow: 1, open: [], resolved: [] }), workspaces: () => [], onChange() {} }, call: async (k, b) => { hubCalls.push([k, b]); return { ok: true } } }
  const hq = createHubQueue({ local: local.queue, client })
  assert.deepEqual(await hq.limitSignInStart({ email: 'a@b.co' }), { ok: true, email: 'a@b.co' })
  assert.deepEqual(await hq.limitSignInCode({ code: 'c#s' }), { ok: true })
  assert.deepEqual(await hq.limitSignInCancel(), { ok: true })
  assert.deepEqual(await hq.limitResume(), { ok: true, resumed: 1, failed: 0 })
  assert.deepEqual(hubCalls, [])
  assert.ok(!JSON.stringify(local.store.list()).includes('c#s'))
})

test('the proxy serves the four routes locally in hub mode (no request reaches the hub)', async (t) => {
  const { startFakeHub, startProxy } = await import('./agent-proxy-helpers.mjs')
  const hub = await startFakeHub(t)
  const limitSignIn = { start: async (a) => ({ ok: true, email: a.email }), code: async () => ({ ok: true }), cancel: async () => ({ ok: true }) }
  const { createReviewQueue: crq } = await import('../service.js')
  let n = 0
  const pstore = createStore({ uuid: () => 'p' + ++n })
  pstore.add({ type: 'paused', sessionId: '', sessionTitle: 'Session limit reached', workspace: '', payload: { kinds: [LIMIT_SIGNIN], count: 1, state: 'idle', note: '' } })
  const queue = crq({ store: pstore, capture: {}, controllerOf: () => ({ prompt: async () => ({}) }), speaker, limitSignIn })
  const p = await startProxy(t, { mode: 'hub', hub, queue })
  assert.deepEqual((await p.post('/v1/limit-signin-start', { email: 'a@b.co' })).json, { ok: true, email: 'a@b.co' })
  assert.deepEqual((await p.post('/v1/limit-signin-code', { code: 'x#y' })).json, { ok: true })
  assert.deepEqual((await p.post('/v1/limit-signin-cancel', {})).json, { ok: true })
  assert.deepEqual((await p.post('/v1/limit-resume', {})).json, { ok: true, resumed: 0, failed: 0 })
  assert.equal(hub.requests.length, 0)
})

test('a phone gets 403 desktop-only on every limit action; the desktop gets 403 local-only (the hub never runs them)', async (t) => {
  const h = await startPhoneHub(t)
  const phone = await h.pairPhone()
  for (const kind of ['limit-signin-start', 'limit-signin-code', 'limit-signin-cancel', 'limit-resume']) {
    const r = await phone.call('POST', P + '/v1/' + kind, { email: 'a@b.co', code: 'c' })
    assert.deepEqual([r.status, r.json], [403, { error: 'desktop-only' }], kind)
    const d = await h.desktop('POST', P + '/v1/' + kind, { email: 'a@b.co', code: 'c' })
    assert.equal(d.status, 403, kind)
    assert.equal(d.json.error, 'local-only', kind)
  }
})

// ---- review 2 findings: dismiss during a run, resume during a run, double resume ---------------------------------------------------------------
test('dismissing the pinned card while a sign-in runs is refused; after the run it is allowed', () => {
  let running = true
  const limitSignIn = { start: async () => ({ ok: true }), code: async () => ({ ok: true }), cancel: async () => ({ ok: true }), state: () => ({ running }) }
  const { queue, pinned, store } = make({ limitSignIn })
  const pin = pinned()
  assert.deepEqual(queue.dismissPaused(pin.id), { ok: false, error: 'sign-in-running' })
  assert.equal(store.get(pin.id).status, 'open')
  running = false
  assert.deepEqual(queue.dismissPaused(pin.id), { ok: true })
})

test('limitResume is refused while a sign-in runs and prompts nothing', async () => {
  const limitSignIn = { start: async () => ({ ok: true }), code: async () => ({ ok: true }), cancel: async () => ({ ok: true }), state: () => ({ running: true }) }
  const { queue, prompts, paused } = make({ limitSignIn })
  paused('s1', ['limit'])
  assert.deepEqual(await queue.limitResume(), { ok: false, error: 'sign-in-running' })
  assert.equal(prompts.length, 0)
})

test('two limitResume calls at once share one run: every session prompted once, at most RESUME_CONCURRENCY at a time', async () => {
  let live = 0; let peak = 0; const seen = []
  const { queue, paused } = make({ prompt: async (req) => { seen.push(req.sessionId); live++; peak = Math.max(peak, live); await sleep(15); live-- } })
  for (let i = 0; i < 6; i++) paused('s' + i, ['limit'])
  const [a, b] = await Promise.all([queue.limitResume(), queue.limitResume()])
  assert.deepEqual(a, { ok: true, resumed: 6, failed: 0 })
  assert.deepEqual(b, a)
  assert.equal(seen.length, 6)
  assert.ok(peak <= RESUME_CONCURRENCY)
})
