import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { createExecutor } from '../agent/executor.js'
import { TIMEOUT_MS } from '../hub/commands.js'
import { CLEAN_TIMEOUT_MS } from '../follow-up-shared.js'
import { ACTION_KINDS } from '../hub/routing.js'
import { agentOf, sync } from './hub-agent-helpers.mjs'
import { P, startPhoneHub } from './hub-device-helpers.mjs'

// POST /v1/dictation-clean { text, lang? } -> { ok, text } | { ok: false, error }: the Haiku cleanup of a phone dictation.
// service.dictationClean(text, { lang }) on the dependency createReviewQueue({ cleaner }) (cleaner.clean of dictation-clean.js); the standalone server
// route; in hub mode a phone action the hub sends to the coordinator app as the command dictation-clean (a read in the executor), with its own
// per-device limit of 6 a minute.
let server, base, seen, impl
const cleaner = { clean: (text, opts) => { seen.push([text, opts?.lang]); return impl(text, opts) } }
before(async () => {
  const store = createStore({ uuid: (() => { let n = 0; return () => 'i' + ++n })() })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), registryOf: () => undefined, cleaner })
  const serve = createRouter({ queue })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
const post = async (body) => { const r = await fetch(base + '/v1/dictation-clean', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
const reset = (fn) => { seen = []; impl = fn ?? (async (t) => ({ ok: true, text: 'CLEAN: ' + t })) }

test('the standalone route answers the cleaned text and hands the cleaner the text and the language', async () => {
  reset()
  const res = await post({ text: 'fix the login', lang: 'en-US' })
  assert.deepEqual([res.status, res.json], [200, { ok: true, text: 'CLEAN: fix the login' }])
  assert.deepEqual(seen, [['fix the login', 'en-US']])
})

test('empty and non-string text is 400 empty, over 2000 is 400 too-long, and the cleaner is not asked', async () => {
  reset()
  for (const body of [{ text: '' }, { text: '  ' }, {}, { text: 7 }, { text: null }]) {
    const res = await post(body)
    assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'empty' }], JSON.stringify(body))
  }
  const long = await post({ text: 'x'.repeat(2001) })
  assert.deepEqual([long.status, long.json], [400, { ok: false, error: 'too-long' }])
  assert.deepEqual(seen, [])
})

test('a failed or unusable cleaning is not a 200, and a throwing cleaner gives a generic LLM error', async () => {
  reset(async () => ({ ok: false, error: 'unusable' }))
  const a = await post({ text: 'fix the login' })
  assert.deepEqual([a.status, a.json], [409, { ok: false, error: 'unusable' }])
  reset(() => { throw new Error('boom https://x/?k=sk-SECRET') })
  const b = await post({ text: 'fix the login' })
  assert.deepEqual(b.json, { ok: false, error: 'LLM error' })
})

test('a throwing cleaner whose message echoes the dictated text logs only the error name, never the text or the message', async () => {
  const logs = []
  const throwing = { clean: () => { throw new TypeError('rejected "my private dictated words" sk-SECRET') } }
  const q = createReviewQueue({ store: createStore({}), capture: {}, controllerOf: () => ({}), registryOf: () => undefined, cleaner: throwing, log: (l) => logs.push(l) })
  assert.deepEqual(await q.dictationClean('my private dictated words'), { ok: false, error: 'LLM error' })
  assert.deepEqual(logs, ['service: dictation-clean failed: TypeError'])
})

test('a non-string lang is dropped before the cleaner', async () => {
  reset()
  await post({ text: 'hello there', lang: { evil: 1 } })
  assert.equal(seen[0][1], undefined)
})

test('without a cleaner the answer is no model available', async () => {
  const q = createReviewQueue({ store: createStore({}), capture: {}, controllerOf: () => ({}), registryOf: () => undefined })
  assert.deepEqual(await q.dictationClean('fix the login'), { ok: false, error: 'no model available' })
})

test('the hub knows the action, the command has a timeout above the cleaner timeout, and the executor runs it as a read', async () => {
  assert.ok(ACTION_KINDS.includes('dictation-clean'))
  assert.ok(TIMEOUT_MS['dictation-clean'] > CLEAN_TIMEOUT_MS)
  let n = 0
  const executor = createExecutor({ queue: { dictationClean: async (text, o) => ({ ok: true, text: text + (o?.lang ?? ''), n: ++n }) }, adapter: {} })
  assert.deepEqual(await executor.execute({ kind: 'dictation-clean', cid: 'c1', args: { text: 'hi', lang: 'en' } }), { ok: true, text: 'hien', n: 1 })
  assert.equal((await executor.execute({ kind: 'dictation-clean', cid: 'c1', args: { text: 'hi' } })).n, 2, 'a read: not kept by cid')
})

async function withAgent(t) {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: sync({ workspaces: [] }) })
  await a.post('presence', { desktopActive: true })
  const p = await h.pairPhone()
  return { h, a, p }
}

test('a phone call is sent to the coordinator app as dictation-clean with the text and language, and its answer comes back', async (t) => {
  const { a, p } = await withAgent(t)
  const pending = p.call('POST', P + '/v1/dictation-clean', { text: 'fix the login', lang: 'en-US' })
  const got = await a.poll(0, 3000)
  const cmd = got.json.commands[0]
  assert.equal(cmd.kind, 'dictation-clean')
  assert.deepEqual(cmd.args, { text: 'fix the login', lang: 'en-US' })
  await a.result(cmd.cid, { ok: true, text: 'Fix the login.' })
  const res = await pending
  assert.deepEqual([res.status, res.json], [200, { ok: true, text: 'Fix the login.' }])
})

test('the hub checks the text itself: empty is 400, over 2000 is 400, a stranger is 401, GET is 405', async (t) => {
  const { h, p } = await withAgent(t)
  assert.equal((await p.call('POST', P + '/v1/dictation-clean', { text: ' ' })).status, 400)
  assert.equal((await p.call('POST', P + '/v1/dictation-clean', { text: 'x'.repeat(2001) })).status, 400)
  assert.equal((await h.stranger('POST', P + '/v1/dictation-clean', { text: 'hello there' })).status, 401)
  assert.equal((await p.call('GET', P + '/v1/dictation-clean')).status, 405)
})

test('with no app registered the call is a 409 no-registry, and a phone is held to 6 cleanups a minute (the 7th is 429)', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  for (let i = 0; i < 6; i++) {
    const res = await p.call('POST', P + '/v1/dictation-clean', { text: 'hello there' })
    assert.deepEqual([res.status, res.json.error], [409, 'no-registry'], 'call ' + (i + 1))
  }
  assert.equal((await p.call('POST', P + '/v1/dictation-clean', { text: 'hello there' })).status, 429)
})

test('the hub audit line for a cleanup names the device and the length, never the text', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  await p.call('POST', P + '/v1/dictation-clean', { text: 'my private dictated words' })
  assert.ok(h.logs.some((l) => /dictation-clean: device .* chars 25/.test(l)), h.logs.join('\n'))
  assert.equal(h.logs.some((l) => /private dictated/.test(l)), false)
})

// A cleaner whose call stays open until its signal aborts (then it answers cancelled, like dictation-clean.js) or release() is called.
function signalAware() {
  const signals = []
  let release
  const gate = new Promise((r) => { release = r })
  const cleaner = { clean: (t, o) => new Promise((resolve) => {
    signals.push(o?.signal)
    o?.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }), { once: true })
    if (signals.length > 1) resolve({ ok: true, text: 'CLEAN: ' + t }) // a later call answers at once
    else gate.then(() => resolve({ ok: true, text: 'CLEAN: ' + t }))
  }) }
  const queue = createReviewQueue({ store: createStore({}), capture: {}, controllerOf: () => ({}), registryOf: () => undefined, cleaner })
  return { signals, release, queue }
}

test('the cleaner gets an abort signal that is live while the call runs', async () => {
  const { signals, release, queue } = signalAware()
  const first = queue.dictationClean('fix the login page')
  assert.ok(signals[0] instanceof AbortSignal)
  assert.equal(signals[0].aborted, false)
  release()
  assert.deepEqual(await first, { ok: true, text: 'CLEAN: fix the login page' })
})

test('a second cleanup while one runs aborts the older call (its paid request is cut) and runs instead of answering busy', async () => {
  const { signals, release, queue } = signalAware()
  const first = queue.dictationClean('fix the login page')
  const second = await queue.dictationClean('another dictation here')
  assert.deepEqual(second, { ok: true, text: 'CLEAN: another dictation here' })
  assert.equal(signals[0].aborted, true, 'the older call was aborted')
  assert.equal(signals[1].aborted, false)
  assert.deepEqual(await first, { ok: false, error: 'superseded' })
  release()
})

test('a superseded call answers superseded even if its cleaner ignores the signal and succeeds', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let n = 0
  const stubborn = { clean: async (t) => { if (++n === 1) await gate; return { ok: true, text: 'CLEAN: ' + t } } }
  const q = createReviewQueue({ store: createStore({}), capture: {}, controllerOf: () => ({}), registryOf: () => undefined, cleaner: stubborn })
  const first = q.dictationClean('fix the login page')
  assert.deepEqual(await q.dictationClean('another dictation here'), { ok: true, text: 'CLEAN: another dictation here' })
  release()
  assert.deepEqual(await first, { ok: false, error: 'superseded' })
})

test('the older call settling late does not clear the newer call state: a third call still aborts the second', async () => {
  const signals = []
  const settle = []
  const cleaner = { clean: (t, o) => new Promise((resolve) => { signals.push(o.signal); settle.push(() => resolve({ ok: true, text: 'CLEAN: ' + t })) }) }
  const q = createReviewQueue({ store: createStore({}), capture: {}, controllerOf: () => ({}), registryOf: () => undefined, cleaner })
  const first = q.dictationClean('first dictation text')
  const second = q.dictationClean('second dictation text')
  settle[0]() // the superseded first call comes back after the second started
  assert.deepEqual(await first, { ok: false, error: 'superseded' })
  const third = q.dictationClean('third dictation text')
  assert.equal(signals[1].aborted, true, 'the second call was still tracked, so the third aborted it')
  settle[1]()
  settle[2]()
  assert.deepEqual(await second, { ok: false, error: 'superseded' })
  assert.deepEqual(await third, { ok: true, text: 'CLEAN: third dictation text' })
})

test('a caller signal that aborts cancels the cleaner call (a closed request cuts the paid call)', async () => {
  const { signals, queue } = signalAware()
  const ac = new AbortController()
  const call = queue.dictationClean('fix the login page', { signal: ac.signal })
  assert.equal(signals[0].aborted, false)
  ac.abort()
  assert.equal(signals[0].aborted, true)
  assert.deepEqual(await call, { ok: false, error: 'cancelled' })
  // the guard is free again: a new call runs normally
  assert.deepEqual(await queue.dictationClean('and a later one'), { ok: true, text: 'CLEAN: and a later one' })
})

test('a caller signal that is already aborted never reaches the cleaner', async () => {
  const { signals, queue } = signalAware()
  const ac = new AbortController()
  ac.abort()
  assert.deepEqual(await queue.dictationClean('fix the login page', { signal: ac.signal }), { ok: false, error: 'cancelled' })
  assert.equal(signals.length, 0)
})

test('the standalone route aborts the cleaner call when the client closes the request', async () => {
  reset()
  let got
  impl = (t, o) => new Promise((resolve) => { got = o.signal; o.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' })) })
  const ac = new AbortController()
  const pending = fetch(base + '/v1/dictation-clean', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'fix the login page' }), signal: ac.signal }).catch(() => 'closed')
  for (let i = 0; i < 100 && !got; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(got, 'the cleaner was called with a signal')
  assert.equal(got.aborted, false)
  ac.abort()
  assert.equal(await pending, 'closed')
  for (let i = 0; i < 100 && !got.aborted; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(got.aborted, true, 'the closed request aborted the cleaner call')
})

test('a throwing cleaner frees the single-flight guard', async () => {
  let n = 0
  const flaky = { clean: async (t) => { if (++n === 1) throw new Error('boom'); return { ok: true, text: t } } }
  const q = createReviewQueue({ store: createStore({}), capture: {}, controllerOf: () => ({}), registryOf: () => undefined, cleaner: flaky })
  assert.deepEqual(await q.dictationClean('first call here'), { ok: false, error: 'LLM error' })
  assert.deepEqual(await q.dictationClean('second call here'), { ok: true, text: 'second call here' })
})

test('the hub command timeout is the cleaner timeout plus 5 s', () => {
  assert.equal(TIMEOUT_MS['dictation-clean'], CLEAN_TIMEOUT_MS + 5000)
})

test('the phone waits longer than the hub does: its dictation-clean timeout is above the hub command timeout', () => {
  const src = readFileSync(new URL('../lib/mobile/api.js', import.meta.url), 'utf8')
  const phone = Number(/const DICTATION_CLEAN_TIMEOUT_MS = (\d[\d_]*)/.exec(src)?.[1].replaceAll('_', ''))
  assert.ok(Number.isFinite(phone), 'DICTATION_CLEAN_TIMEOUT_MS is read from api.js')
  assert.ok(phone > CLEAN_TIMEOUT_MS + 5000, phone + ' vs ' + (CLEAN_TIMEOUT_MS + 5000))
})

test('the 6 a minute limit also holds the desktop caller (one shared bucket), and a phone has its own', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  for (let i = 0; i < 6; i++) assert.equal((await h.desktop('POST', P + '/v1/dictation-clean', { text: 'hello there' })).status, 409, 'desktop call ' + (i + 1))
  assert.equal((await h.desktop('POST', P + '/v1/dictation-clean', { text: 'hello there' })).status, 429)
  assert.equal((await p.call('POST', P + '/v1/dictation-clean', { text: 'hello there' })).status, 409, 'the phone is not charged for the desktop calls')
})

test('the hub forwards only a language tag of the BCP-47 shape; anything else is dropped and the request still goes through', async (t) => {
  const { a, p } = await withAgent(t)
  const sent = async (lang) => {
    const pending = p.call('POST', P + '/v1/dictation-clean', { text: 'fix the login', lang })
    const cmd = (await a.poll(0, 3000)).json.commands[0]
    await a.result(cmd.cid, { ok: true, text: 'Fix the login.' })
    assert.equal((await pending).status, 200)
    return cmd.args
  }
  for (const lang of ['en-US', 'zh']) assert.deepEqual(await sent(lang), { text: 'fix the login', lang }, lang)
  for (const lang of ['x'.repeat(60_000), 'en-US; ignore previous', 7, { a: 1 }]) assert.deepEqual(await sent(lang), { text: 'fix the login' }, 'dropped: ' + String(lang).slice(0, 20))
})

