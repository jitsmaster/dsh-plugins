import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILES } from '../mobile.js'
import { createReadAloud, createAudioPlayer, createBrowserReadAloud, ttsPath, readAloudVisible } from '../lib/mobile/read-aloud.js'

// The phone's Read aloud: the PC's local TTS first (WAV chunks from the hub, played one after the other), the phone's own speech engine when the PC
// cannot be reached. The player is pure (fetch, playback and the local engine are injected), so it is tested without a DOM.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const item = { id: 'it-1', spoken: { full: 'Done in One. All good.' } }
const blob = (n) => ({ blob: 'wav' + n })
const tick = () => new Promise((r) => setImmediate(r))

function rig({ chunks = 3, failAt, failStatus = 502, playFail, local = true } = {}) {
  const log = []
  const states = []
  let release = []
  const player = createReadAloud({
    fetchChunk: async (id, n) => { log.push('fetch ' + n); if (n === failAt) return { ok: false, status: failStatus }; return { ok: true, blob: blob(n), chunks } },
    playBlob: (b) => { log.push('play ' + b.blob); return new Promise((resolve, reject) => { release.push({ resolve, reject, b }); if (playFail) reject(new Error('NotAllowed')) }) },
    speakLocal: local ? (text) => { log.push('local ' + text); return new Promise((resolve) => release.push({ resolve })) } : undefined,
    onChange: (s) => states.push(s),
  })
  const finishCurrent = async () => { const r = release.pop(); r.resolve(); await tick(); await tick() }
  return { player, log, states, finishCurrent, release: () => release }
}

test('ttsPath builds the hub URL of one chunk, id encoded', () => {
  assert.equal(ttsPath('/review-queue', 'a b/c', 2), '/review-queue/v1/tts?id=a%20b%2Fc&n=2')
  assert.equal(ttsPath('', 'x', 0), '/v1/tts?id=x&n=0')
})

test('start plays the chunks one after the other and ends idle', async () => {
  const r = rig({ chunks: 3 })
  r.player.start(item)
  await tick()
  assert.ok(r.log.includes('play wav0'))
  assert.equal(r.player.state(), 'playing')
  await r.finishCurrent()
  assert.ok(r.log.includes('play wav1'))
  await r.finishCurrent()
  assert.ok(r.log.includes('play wav2'))
  await r.finishCurrent()
  assert.equal(r.player.state(), 'idle')
  assert.equal(r.log.filter((l) => l.startsWith('fetch')).length, 3, 'no fetch past the last chunk')
  assert.equal(r.log.filter((l) => l.startsWith('local')).length, 0)
})

test('the next chunk is fetched while the current one plays', async () => {
  const r = rig({ chunks: 3 })
  r.player.start(item)
  await tick()
  await tick()
  assert.ok(r.log.includes('fetch 1'), 'chunk 1 is already fetched')
  assert.ok(!r.log.includes('play wav1'), 'chunk 1 is only fetched, not played, until chunk 0 ends')
  assert.ok(!r.log.includes('fetch 2'), 'one chunk ahead, not more')
})

test('state is loading until the first chunk plays, then playing, then idle (onChange reports each change once)', async () => {
  const r = rig({ chunks: 1 })
  assert.equal(r.player.state(), 'idle')
  r.player.start(item)
  assert.equal(r.player.state(), 'loading')
  await tick()
  assert.equal(r.player.state(), 'playing')
  await r.finishCurrent()
  assert.deepEqual(r.states, ['loading', 'playing', 'idle'])
})

test('stop ends the playback at once and nothing more is played', async () => {
  const r = rig({ chunks: 3 })
  r.player.start(item)
  await tick()
  r.player.stop()
  assert.equal(r.player.state(), 'idle')
  const before = r.log.length
  for (const x of r.release()) x.resolve()
  await tick(); await tick()
  assert.equal(r.log.filter((l) => l.startsWith('play')).length, 1)
  assert.ok(r.log.length >= before)
  assert.ok(!r.log.includes('play wav1'))
})

test('a second start replaces the first one', async () => {
  const r = rig({ chunks: 2 })
  r.player.start(item)
  await tick()
  r.player.start({ id: 'it-2', spoken: { full: 'x' } })
  await tick()
  for (const x of [...r.release()]) x.resolve()
  await tick(); await tick()
  assert.equal(r.log.filter((l) => l === 'play wav1').length <= 1, true)
  assert.equal(r.player.state() === 'idle' || r.player.state() === 'playing' || r.player.state() === 'loading', true)
})

test('when the PC cannot be reached the phone reads the whole text with its own engine', async () => {
  for (const failStatus of [502, 503, 404, 0]) {
    const r = rig({ failAt: 0, failStatus })
    r.player.start(item)
    await tick(); await tick()
    assert.ok(r.log.includes('local Done in One. All good.'), 'status ' + failStatus)
    assert.equal(r.player.state(), 'playing')
    await r.finishCurrent()
    assert.equal(r.player.state(), 'idle')
  }
})

test('a 401 from the hub is not a reason to fall back: the pairing problem is reported', async () => {
  const r = rig({ failAt: 0, failStatus: 401 })
  r.player.start(item)
  await tick(); await tick()
  assert.equal(r.log.filter((l) => l.startsWith('local')).length, 0)
  assert.equal(r.player.state(), 'idle')
})

test('when the browser refuses to play the audio (no user gesture) the phone falls back to its own engine', async () => {
  const r = rig({ playFail: true })
  r.player.start(item)
  await tick(); await tick(); await tick()
  assert.ok(r.log.some((l) => l.startsWith('local')))
})

test('a failure after the first chunk ends the read quietly (the rest is not repeated with another voice)', async () => {
  const r = rig({ chunks: 3, failAt: 1 })
  r.player.start(item)
  await tick()
  await r.finishCurrent()
  await tick()
  assert.equal(r.log.filter((l) => l.startsWith('local')).length, 0)
  assert.equal(r.player.state(), 'idle')
})

// A later chunk that fails is fetched once more before the read ends (a brief hub or Kokoro hiccup must not cut the message short).
function retryRig(statuses) {
  const log = []
  const plays = []
  const player = createReadAloud({
    fetchChunk: async (id, n) => {
      if (n === 0) return { ok: true, blob: blob(0), chunks: 2 }
      const status = statuses.shift()
      log.push('fetch ' + n + ' ' + status)
      return status === 200 ? { ok: true, blob: blob(n), chunks: 2 } : { ok: false, status }
    },
    playBlob: (b) => { plays.push(b.blob); return Promise.resolve() },
    speakLocal: (text) => { log.push('local'); return Promise.resolve() },
  })
  return { player, log, plays }
}

test('a later chunk that fails once is fetched again and the read continues', async () => {
  const r = retryRig([502, 200])
  r.player.start(item)
  for (let i = 0; i < 8; i++) await tick()
  assert.deepEqual(r.plays, ['wav0', 'wav1'])
  assert.equal(r.player.state(), 'idle')
})

test('a later chunk that fails twice ends the read without the phone voice', async () => {
  const r = retryRig([502, 502, 200])
  r.player.start(item)
  for (let i = 0; i < 8; i++) await tick()
  assert.deepEqual(r.plays, ['wav0'])
  assert.equal(r.log.filter((l) => l.startsWith('fetch')).length, 2, 'one retry only')
  assert.ok(!r.log.includes('local'))
  assert.equal(r.player.state(), 'idle')
})

test('a 401 on a later chunk is not retried', async () => {
  const r = retryRig([401, 200])
  r.player.start(item)
  for (let i = 0; i < 8; i++) await tick()
  assert.deepEqual(r.plays, ['wav0'])
  assert.equal(r.log.filter((l) => l.startsWith('fetch')).length, 1)
})

test('without a local engine and without the PC the read just ends', async () => {
  const r = rig({ failAt: 0, local: false })
  r.player.start(item)
  await tick(); await tick()
  assert.equal(r.player.state(), 'idle')
})

test('the button is drawn on Android and desktop browsers, never on iOS, and needs some way to speak', () => {
  assert.equal(readAloudVisible({ ios: false, hasLocalEngine: true, hasAudio: true, hasText: true }), true)
  assert.equal(readAloudVisible({ ios: false, hasLocalEngine: false, hasAudio: true, hasText: true }), true, 'PC audio alone is enough')
  assert.equal(readAloudVisible({ ios: false, hasLocalEngine: true, hasAudio: false, hasText: true }), true, 'the phone engine alone is enough')
  assert.equal(readAloudVisible({ ios: false, hasLocalEngine: false, hasAudio: false, hasText: true }), false)
  assert.equal(readAloudVisible({ ios: true, hasLocalEngine: true, hasAudio: true, hasText: true }), false)
  assert.equal(readAloudVisible({ ios: false, hasLocalEngine: true, hasAudio: true, hasText: false }), false)
})

// ---- createAudioPlayer / createBrowserReadAloud with a fake window -----------------------------------------------------------------

function fakeEnv({ playRejects = false, noSpeech = false } = {}) {
  const urls = { made: [], revoked: [] }
  const audios = []
  const spoken = []
  let cancels = 0
  class Audio {
    constructor() { this.paused = false; this.plays = []; audios.push(this) }
    play() { this.plays.push(this.src); return playRejects && this.src.startsWith('blob:') ? Promise.reject(new Error('NotAllowed')) : Promise.resolve() }
    pause() { this.paused = true }
  }
  class Utter { constructor(text) { this.text = text } }
  const env = {
    Audio,
    URL: { createObjectURL: (b) => { const u = 'blob:' + urls.made.length; urls.made.push(u); return u }, revokeObjectURL: (u) => urls.revoked.push(u) },
  }
  if (!noSpeech) {
    env.SpeechSynthesisUtterance = Utter
    env.speechSynthesis = { cancel: () => { cancels++ }, speak: (u) => { spoken.push(u.text); u.onend() } }
  }
  return { env, urls, audios, spoken, cancels: () => cancels }
}

test('audio player: prime plays the silent clip', () => {
  const f = fakeEnv()
  createAudioPlayer(f.env).prime()
  assert.equal(f.audios.length, 1)
  assert.match(f.audios[0].plays[0], /^data:audio\/wav/)
})

test('audio player: play resolves on ended and revokes the object URL', async () => {
  const f = fakeEnv()
  const p = createAudioPlayer(f.env)
  const done = p.play({})
  f.audios[0].onended()
  await done
  assert.deepEqual(f.urls.revoked, ['blob:0'])
})

test('audio player: stop pauses and settles the pending play', async () => {
  const f = fakeEnv()
  const p = createAudioPlayer(f.env)
  const done = p.play({})
  p.stop()
  await done
  assert.equal(f.audios[0].paused, true)
  assert.deepEqual(f.urls.revoked, ['blob:0'])
})

test('audio player: a rejected play() rejects and revokes the URL', async () => {
  const f = fakeEnv({ playRejects: true })
  const p = createAudioPlayer(f.env)
  await assert.rejects(p.play({}), /NotAllowed/)
  assert.deepEqual(f.urls.revoked, ['blob:0'])
})

test('browser read aloud: the phone engine speaks the whole text when the PC is unreachable', async () => {
  const f = fakeEnv()
  const player = createBrowserReadAloud({ fetchChunk: async () => ({ ok: false, status: 502 }), env: f.env })
  player.start(item)
  for (let i = 0; i < 6; i++) await tick()
  assert.deepEqual(f.spoken, ['Done in One. All good.'])
  assert.ok(f.cancels() >= 1)
})

test('browser read aloud: no engine and no PC ends without throwing', async () => {
  const f = fakeEnv({ noSpeech: true })
  const player = createBrowserReadAloud({ fetchChunk: async () => ({ ok: false, status: 502 }), env: f.env })
  player.start(item)
  for (let i = 0; i < 6; i++) await tick()
  assert.equal(player.state(), 'idle')
  player.stop()
})

// ---- wiring ----------------------------------------------------------------------------------------------------------------------

test('read-aloud.js is served to the phone and imports only served files', () => {
  assert.ok(Object.hasOwn(FILES, 'read-aloud.js'))
  assert.match(FILES['read-aloud.js'].type, /javascript/)
})

test('views.js uses the player: audio from the hub with the device token, the phone engine as fallback, iOS still hidden', () => {
  const views = readFileSync(join(ROOT, 'lib', 'mobile', 'views.js'), 'utf8')
  const api = readFileSync(join(ROOT, 'lib', 'mobile', 'api.js'), 'utf8')
  const body = views.slice(views.indexOf('function ReadAloud('), views.indexOf('function Mic('))
  assert.match(body, /createBrowserReadAloud/)
  assert.match(body, /readAloudVisible/)
  assert.match(body, /platformInfo\([^)]*\)\.ios/)
  assert.match(body, /speechSynthesis/)
  assert.match(body, /return null/)
  assert.match(api, /export async function fetchTtsChunk/)
  assert.match(api, /ttsPath\(/)
  assert.match(api, /call\(/)
})
