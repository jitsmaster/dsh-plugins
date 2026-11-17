import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHub } from '../hub/hub.js'
import { createTts, loopbackTtsUrl, DEFAULT_TTS_URL } from '../hub/tts.js'
import { loadHubConfig } from '../hub/config.js'
import { chunkForSpeech, fullTextFor } from '../speech.js'
import { freePort, tmpDir } from './hub-helpers.mjs'

// The phone's Read aloud asks the hub for WAV audio (GET /review-queue/v1/tts?id&n), one speech chunk per request, made by the PC's local TTS server
// (Kokoro, a loopback URL). The hub never fetches any other host, never follows a redirect and answers a bounded number of syntheses at once.
const P = '/review-queue'
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WAVEfmt ')])
const LONG = Array.from({ length: 40 }, (_, i) => 'Sentence number ' + i + ' is right here.').join(' ')

function fakeKokoro(t, { status = 200, body = WAV, headers = { 'content-type': 'audio/wav' } } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    const parts = []
    req.on('data', (c) => parts.push(c))
    req.on('end', () => {
      let json
      try { json = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { /* not JSON */ }
      requests.push({ method: req.method, url: req.url, json })
      res.writeHead(status, headers)
      res.end(body)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.closeAllConnections?.(); server.close() })
    resolve({ url: 'http://127.0.0.1:' + server.address().port + '/tts', requests })
  }))
}

async function startHub(t, { ttsUrl, ...over } = {}) {
  const dir = tmpDir(t)
  if (ttsUrl) writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ ttsUrl }))
  const hub = createHub({ stateDir: dir, port: 0, tickMs: 0, log: () => {}, ...over })
  await hub.start()
  t.after(() => hub.stop())
  return { hub, port: hub.port }
}
const feed = (hub, over = {}) => hub.store.applyOp({ op: 'add', item: { type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'Did X.', payload: { reply: 'r' }, ...over } }, { owner: 'A1' }).id

/** One request, binary body kept (the test helper raw() decodes text). */
const getBin = (port, path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
    const parts = []
    res.on('data', (c) => parts.push(c))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }))
  })
  req.on('error', reject)
  req.end()
})
const json = (res) => JSON.parse(res.body.toString('utf8'))

// ---- the route -----------------------------------------------------------------------------------------------------------------

test('GET /v1/tts?id&n answers one WAV chunk of the card read-out, made by the local TTS server', async (t) => {
  const k = await fakeKokoro(t)
  const { hub, port } = await startHub(t, { ttsUrl: k.url })
  const id = feed(hub, { payload: { reply: LONG } })
  const pieces = chunkForSpeech(fullTextFor(hub.store.get(id)))
  assert.ok(pieces.length >= 3, 'the long reply makes several chunks')
  const res = await getBin(port, P + '/v1/tts?id=' + id + '&n=1')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /^audio\/wav/)
  assert.equal(res.headers['x-tts-chunks'], String(pieces.length))
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.deepEqual(res.body, WAV)
  assert.equal(k.requests.length, 1)
  assert.equal(k.requests[0].method, 'POST')
  assert.deepEqual(k.requests[0].json, { text: pieces[1], voice_gender: 'male' })
})

test('the chunks together are the whole message, in order', async (t) => {
  const k = await fakeKokoro(t)
  const { hub, port } = await startHub(t, { ttsUrl: k.url })
  const id = feed(hub, { payload: { reply: LONG } })
  const total = Number((await getBin(port, P + '/v1/tts?id=' + id + '&n=0')).headers['x-tts-chunks'])
  for (let n = 1; n < total; n++) await getBin(port, P + '/v1/tts?id=' + id + '&n=' + n)
  const said = k.requests.map((r) => r.json.text).join(' ')
  assert.equal(said.replace(/\s+/g, ' '), chunkForSpeech(fullTextFor(hub.store.get(id))).join(' ').replace(/\s+/g, ' '))
})

test('an unknown id is 404, a missing id or a bad chunk number is 400, a chunk past the end is 404', async (t) => {
  const k = await fakeKokoro(t)
  const { hub, port } = await startHub(t, { ttsUrl: k.url })
  const id = feed(hub)
  assert.equal((await getBin(port, P + '/v1/tts?id=nope&n=0')).status, 404)
  assert.deepEqual(json(await getBin(port, P + '/v1/tts?id=nope&n=0')), { error: 'not-found' })
  assert.equal((await getBin(port, P + '/v1/tts?n=0')).status, 400)
  for (const n of ['abc', '-1', '1.5', '', '99999999999']) assert.equal((await getBin(port, P + '/v1/tts?id=' + id + '&n=' + n)).status, 400, 'n=' + n)
  const past = await getBin(port, P + '/v1/tts?id=' + id + '&n=50')
  assert.equal(past.status, 404)
  assert.deepEqual(json(past), { error: 'no-chunk' })
  assert.equal(k.requests.length, 0, 'nothing was synthesised for a refused request')
})

test('n defaults to the first chunk', async (t) => {
  const k = await fakeKokoro(t)
  const { hub, port } = await startHub(t, { ttsUrl: k.url })
  const id = feed(hub)
  assert.equal((await getBin(port, P + '/v1/tts?id=' + id)).status, 200)
  assert.equal(k.requests[0].json.text, chunkForSpeech(fullTextFor(hub.store.get(id)))[0])
})

test('only GET; POST is 405', async (t) => {
  const k = await fakeKokoro(t)
  const { hub, port } = await startHub(t, { ttsUrl: k.url })
  const id = feed(hub)
  assert.equal((await getBin(port, P + '/v1/tts?id=' + id + '&n=0', { method: 'POST', headers: { 'content-type': 'application/json' } })).status, 405)
})

test('a paired phone may call it; nobody (no role) may not', async (t) => {
  const k = await fakeKokoro(t)
  let role = 'device'
  const { hub, port } = await startHub(t, { ttsUrl: k.url, roleOf: () => role })
  const id = feed(hub)
  assert.equal((await getBin(port, P + '/v1/tts?id=' + id + '&n=0')).status, 200)
  role = undefined
  assert.equal((await getBin(port, P + '/v1/tts?id=' + id + '&n=0')).status, 401)
})

test('a local TTS server that is down, or answers an error, is 502 tts-unavailable (the phone then falls back to its own voice)', async (t) => {
  const down = await startHub(t, { ttsUrl: 'http://127.0.0.1:' + (await freePort()) + '/tts' })
  const a = await getBin(down.port, P + '/v1/tts?id=' + feed(down.hub) + '&n=0')
  assert.equal(a.status, 502)
  assert.deepEqual(json(a), { error: 'tts-unavailable' })
  const bad = await fakeKokoro(t, { status: 500, body: Buffer.from('boom') })
  const broken = await startHub(t, { ttsUrl: bad.url })
  assert.equal((await getBin(broken.port, P + '/v1/tts?id=' + feed(broken.hub) + '&n=0')).status, 502)
})

test('the TTS server URL comes from hub.config.json ttsUrl; a URL that is not loopback is ignored', () => {
  const dir = tmpDir()
  writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ ttsUrl: 'http://127.0.0.1:9999/speak' }))
  assert.equal(loadHubConfig(dir).ttsUrl, 'http://127.0.0.1:9999/speak')
  writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ ttsUrl: 'http://evil.example/tts' }))
  assert.equal(loadHubConfig(dir).ttsUrl, undefined)
})

test('ttsVoice is male or female from hub.config.json, anything else is ignored', () => {
  const dir = tmpDir()
  for (const [value, want] of [['female', 'female'], ['male', 'male'], ['robot', undefined], [3, undefined], [undefined, undefined]]) {
    writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ ttsVoice: value }))
    assert.equal(loadHubConfig(dir).ttsVoice, want, String(value))
  }
})

test('the TTS URL order is hub.config.json, then DSH_TTS_URL (loopback only), else undefined (hub uses the default)', () => {
  const dir = tmpDir()
  writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({}))
  assert.equal(loadHubConfig(dir, { env: { DSH_TTS_URL: 'http://127.0.0.1:7777/tts' } }).ttsUrl, 'http://127.0.0.1:7777/tts')
  assert.equal(loadHubConfig(dir, { env: { DSH_TTS_URL: 'http://evil.example/tts' } }).ttsUrl, undefined)
  assert.equal(loadHubConfig(dir, { env: {} }).ttsUrl, undefined)
  writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ ttsUrl: 'http://127.0.0.1:9999/speak' }))
  assert.equal(loadHubConfig(dir, { env: { DSH_TTS_URL: 'http://127.0.0.1:7777/tts' } }).ttsUrl, 'http://127.0.0.1:9999/speak', 'config wins over env')
})

test('the hub makes its TTS with the configured voice', async (t) => {
  const k = await fakeKokoro(t)
  const { hub } = await startHub(t, { ttsUrl: k.url })
  assert.equal(hub.tts.gender, 'male', 'default voice')
})

// ---- loopbackTtsUrl --------------------------------------------------------------------------------------------------------------

test('loopbackTtsUrl accepts only http(s) URLs on this PC without credentials', () => {
  assert.equal(DEFAULT_TTS_URL, 'http://127.0.0.1:8880/tts')
  for (const ok of ['http://127.0.0.1:8880/tts', 'http://localhost:9000/x', 'http://[::1]:8880/tts', 'https://127.0.0.1/tts']) assert.equal(loopbackTtsUrl(ok), new URL(ok).href, ok)
  for (const bad of ['http://evil.example/tts', 'https://192.168.1.5/tts', 'ftp://127.0.0.1/', 'not a url', 42, undefined, null, 'http://user:pw@127.0.0.1/tts', 'http://127.0.0.1.evil.example/tts', 'http://0.0.0.0:8880/tts']) assert.equal(loopbackTtsUrl(bad), undefined, String(bad))
})

// ---- createTts -------------------------------------------------------------------------------------------------------------------

const audioResponse = (body = WAV, init = { status: 200, headers: { 'content-type': 'audio/wav' } }) => new Response(body, init)

test('synth posts the text as JSON to the URL, follows no redirect, and has a time limit', async () => {
  const calls = []
  const tts = createTts({ url: 'http://127.0.0.1:8880/tts', fetchFn: async (url, init) => { calls.push({ url, init }); return audioResponse() } })
  const r = await tts.synth('Hello there.')
  assert.equal(r.ok, true)
  assert.deepEqual(r.wav, WAV)
  assert.equal(calls[0].url, 'http://127.0.0.1:8880/tts')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Hello there.', voice_gender: 'male' })
  assert.ok(calls[0].init.signal, 'an abort signal is passed')
})

test('synth refuses an answer that is not audio, is too large, or failed', async () => {
  const run = (response, extra = {}) => createTts({ url: DEFAULT_TTS_URL, ...extra, fetchFn: async () => response }).synth('x')
  assert.deepEqual(await run(audioResponse('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } })), { ok: false, error: 'tts-unavailable' })
  assert.deepEqual(await run(audioResponse(Buffer.alloc(11)), { maxBytes: 10 }), { ok: false, error: 'too-large' })
  assert.deepEqual(await run(audioResponse(WAV, { status: 500, headers: { 'content-type': 'audio/wav' } })), { ok: false, error: 'tts-unavailable' })
  assert.deepEqual(await createTts({ url: DEFAULT_TTS_URL, fetchFn: async () => { throw new Error('ECONNREFUSED') } }).synth('x'), { ok: false, error: 'tts-unavailable' })
})

test('synth answers busy when maxActive syntheses are already running, and frees the slot afterwards', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const tts = createTts({ url: DEFAULT_TTS_URL, maxActive: 1, fetchFn: async () => { await gate; return audioResponse() } })
  const first = tts.synth('one')
  assert.deepEqual(await tts.synth('two'), { ok: false, error: 'busy' })
  release()
  assert.equal((await first).ok, true)
  assert.equal((await tts.synth('three')).ok, true)
})

test('synth frees its slot when the TTS server fails', async () => {
  const tts = createTts({ url: DEFAULT_TTS_URL, maxActive: 1, fetchFn: async () => { throw new Error('down') } })
  await tts.synth('a')
  await tts.synth('b')
  assert.deepEqual(await tts.synth('c'), { ok: false, error: 'tts-unavailable' }, 'never stuck on busy')
})

test('chunksOf is the read-out text of the item cut for speech, capped in count', () => {
  const tts = createTts({ url: DEFAULT_TTS_URL, fetchFn: async () => audioResponse() })
  const item = { type: 'completed', sessionTitle: 'One', summary: 'Did X.', payload: { reply: LONG } }
  assert.deepEqual(tts.chunksOf(item), chunkForSpeech(fullTextFor(item)))
  const huge = { type: 'completed', sessionTitle: 'One', summary: 'Did X.', payload: { reply: Array.from({ length: 3000 }, (_, i) => 'Word' + i + ' goes on and on here.').join(' ') } }
  assert.ok(tts.chunksOf(huge).length <= 200)
})

test('chunksOf is cached per item so a read does not re-chunk the text for every chunk; fresh=true recomputes', () => {
  const tts = createTts({ url: DEFAULT_TTS_URL, fetchFn: async () => audioResponse() })
  const item = { id: 'cache-1', type: 'completed', sessionTitle: 'One', summary: 'Did X.', payload: { reply: LONG } }
  const a = tts.chunksOf(item)
  assert.equal(tts.chunksOf(item), a, 'same chunks for the following requests of the read')
  item.payload = { reply: 'Changed text. Entirely.' }
  assert.equal(tts.chunksOf(item), a, 'a text change mid-read does not shift the chunks')
  assert.notEqual(tts.chunksOf(item, true), a, 'the first chunk of a new read recomputes')
})

test('synth stops and frees its slot when the caller aborts (the phone went away)', async () => {
  const ac = new AbortController()
  const tts = createTts({ url: DEFAULT_TTS_URL, maxActive: 1, fetchFn: (url, init) => new Promise((resolve, reject) => { if (init.signal.aborted) return reject(new Error('aborted')); init.signal.addEventListener('abort', () => reject(new Error('aborted'))) }) })
  const p = tts.synth('x', { signal: ac.signal })
  ac.abort()
  assert.deepEqual(await p, { ok: false, error: 'tts-unavailable' })
  assert.deepEqual(await tts.synth('z', { signal: AbortSignal.abort() }), { ok: false, error: 'tts-unavailable' }, 'slot was freed, not busy')
})
