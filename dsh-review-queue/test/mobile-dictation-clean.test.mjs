import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Slice 3 (phone side of the Haiku cleanup), pure parts first:
//   punctuation.js dictatedPart(base, full)            -> the text dictated after `base` (trimmed), or '' when the box no longer starts with base
//   punctuation.js applyCleaned({ base, sent, current, cleaned }) -> the new box text, or null (drop the result) when the box changed since `sent`
//   api.js cleanDictation(text, lang)                  -> POST /v1/dictation-clean { text, lang } -> { ok: true, text } | { ok: false, error }
globalThis.location = { pathname: '/review-queue/m/', hash: '#/' }
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
globalThis.document = { hidden: false, addEventListener() {} }
globalThis.window = { addEventListener() {} }
const api = await import('../lib/mobile/api.js')
const { dictatedPart, applyCleaned } = await import('../lib/mobile/punctuation.js')

test('dictatedPart is what was added after the base, trimmed; empty when the base was edited away', () => {
  assert.equal(dictatedPart('Fix the login.', 'Fix the login. And add tests'), 'And add tests')
  assert.equal(dictatedPart('', 'Hello there'), 'Hello there')
  assert.equal(dictatedPart('Fix', 'Fix'), '')
  assert.equal(dictatedPart('Fix the login', 'Something else'), '')
  assert.equal(dictatedPart(undefined, 'Hi'), 'Hi')
})

test('applyCleaned swaps only the dictated part, keeping the base and the separator', () => {
  assert.equal(applyCleaned({ base: 'Notes:', sent: 'Notes: fix the login please', current: 'Notes: fix the login please', cleaned: 'Fix the login, please.' }), 'Notes: Fix the login, please.')
  assert.equal(applyCleaned({ base: '', sent: 'fix it', current: 'fix it', cleaned: 'Fix it.' }), 'Fix it.')
  assert.equal(applyCleaned({ base: 'Line\n', sent: 'Line\nnext', current: 'Line\nnext', cleaned: 'Next.' }), 'Line\nNext.')
})

test('applyCleaned drops the result (null) when the box changed since the text was sent, or the cleaned text is empty', () => {
  assert.equal(applyCleaned({ base: '', sent: 'fix it', current: 'fix it now', cleaned: 'Fix it.' }), null)
  assert.equal(applyCleaned({ base: '', sent: 'fix it', current: '', cleaned: 'Fix it.' }), null)
  assert.equal(applyCleaned({ base: '', sent: 'fix it', current: 'fix it', cleaned: '  ' }), null)
  assert.equal(applyCleaned({ base: 'abc', sent: 'abc x', current: 'zzz x', cleaned: 'X.' }), null)
})

let calls
beforeEach(() => {
  calls = []
  store.clear()
  store.set('rq-m.token', 'rqd_' + 'C'.repeat(43))
  api.setCoreForTests({ errorText: (s) => 'E' + s, pruneSaved: (saved) => saved })
})
const respond = (status, body) => { globalThis.fetch = async (url, init) => { calls.push([url, init]); return { ok: status < 400, status, headers: { get: () => null }, json: async () => body } } }

test('cleanDictation posts the text and the language to /v1/dictation-clean and returns the cleaned text', async () => {
  respond(200, { ok: true, text: 'Fix the login.' })
  const out = await api.cleanDictation('fix the login', 'en-US')
  assert.deepEqual(out, { ok: true, text: 'Fix the login.' })
  assert.match(calls[0][0], /\/v1\/dictation-clean$/)
  assert.equal(calls[0][1].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0][1].body), { text: 'fix the login', lang: 'en-US' })
})

test('cleanDictation carries an abort signal and gives up just above the hub\'s 25 s command timeout, answering { ok: false, error: failed }', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = (url, init) => {
    calls.push([url, init])
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  }
  const pending = api.cleanDictation('fix the login', 'en')
  assert.ok(calls[0][1].signal instanceof AbortSignal, 'the request carries a signal')
  t.mock.timers.tick(24999)
  assert.equal(calls[0][1].signal.aborted, false, 'not before the hub has had its 25 s')
  t.mock.timers.tick(5001)
  assert.deepEqual(await pending, { ok: false, error: 'failed' })
  assert.equal(calls[0][1].signal.aborted, true)
})

test('cleanDictation aborts its request when the caller\'s signal aborts, answering { ok: false, error: failed } without throwing', async () => {
  globalThis.fetch = (url, init) => {
    calls.push([url, init])
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  }
  const outer = new AbortController()
  const pending = api.cleanDictation('fix the login', 'en', outer.signal)
  assert.equal(calls[0][1].signal.aborted, false)
  outer.abort()
  assert.equal(calls[0][1].signal.aborted, true, 'the request is cancelled at once')
  assert.deepEqual(await pending, { ok: false, error: 'failed' })
})

test('cleanDictation sends no request when the caller\'s signal is already aborted', async () => {
  respond(200, { ok: true, text: 'x' })
  const outer = new AbortController()
  outer.abort()
  assert.deepEqual(await api.cleanDictation('fix the login', 'en', outer.signal), { ok: false, error: 'failed' })
  assert.equal(calls.length, 0)
})

test('cleanDictation answers { ok: false, error: failed } when the fetch rejects with an AbortError', async () => {
  globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
  assert.deepEqual(await api.cleanDictation('fix the login', 'en'), { ok: false, error: 'failed' })
})

test('cleanDictation answers { ok: false } for a refusal, a rate limit and a network failure; it never throws and sends nothing for blank text', async () => {
  respond(409, { ok: false, error: 'unusable' })
  assert.deepEqual(await api.cleanDictation('fix the login', 'en'), { ok: false, error: 'unusable' })
  respond(429, { error: 'rate-limited' })
  assert.equal((await api.cleanDictation('fix the login', 'en')).ok, false)
  globalThis.fetch = async () => { throw new Error('offline') }
  assert.equal((await api.cleanDictation('fix the login', 'en')).ok, false)
  calls = []
  respond(200, { ok: true, text: 'x' })
  assert.deepEqual(await api.cleanDictation('   ', 'en'), { ok: false, error: 'empty' })
  assert.equal(calls.length, 0)
})
