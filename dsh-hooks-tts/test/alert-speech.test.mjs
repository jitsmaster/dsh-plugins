// Alert read-outs (Stop, permission, question) go through the persistent speak worker instead of one PowerShell process per hook:
// the plugin asks the Kokoro server itself, keeps short phrases as WAV files in a cache, and hands the worker a file to play.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alertLine, createAlertSpeech, speechModeOf } from '../alert-speech.js'

const ps = (script) => ({ command: 'powershell.exe', args: ['-NoProfile', '-File', 'C:/p/scripts/detach-launcher.ps1', '-ScriptPath', 'C:\\p\\scripts\\' + script] })
const WAV = Buffer.from('RIFFxxxxWAVEfake')

test('A1 the three launcher hooks are recognised by their script, anything else is not', () => {
  assert.equal(speechModeOf(ps('speak.ps1')), 'speak')
  assert.equal(speechModeOf(ps('stop-speak.ps1')), 'stop')
  assert.equal(speechModeOf(ps('elicitation-speak.ps1')), 'elicit')
  assert.equal(speechModeOf(ps('session-start-obsidian-note.ps1')), undefined)
  assert.equal(speechModeOf({ command: 'hook-cmd', args: ['scripts/detach-launcher.ps1'] }), undefined)
  assert.equal(speechModeOf({ command: 'x' }), undefined)
})

test('A2 the headline is the line; the voices, priority and pause match the PowerShell scripts', () => {
  assert.deepEqual(alertLine('stop', { headline: 'Done on: **A**.' }), { text: 'Done on: A.', gender: 'male', priority: 'Normal', pause: 0.5 })
  assert.deepEqual(alertLine('speak', { headline: 'Approve run command?' }), { text: 'Approve run command?', gender: 'male', priority: 'Normal' })
  assert.deepEqual(alertLine('elicit', { headline: 'Question: which?' }), { text: 'Question: which?', gender: 'female', priority: 'High' })
})

test('A3 without a headline: stop says where and never the response, speak and elicit use the old wording', () => {
  assert.equal(alertLine('stop', { last_assistant_message: 'LONG', session_title: 'S', cwd: 'D:\\x\\proj' }).text, 'Done on: Session: S; Workspace: proj.')
  assert.equal(alertLine('stop', {}).text, 'Done.')
  assert.equal(alertLine('speak', { message: ' needs you ', cwd: 'D:\\x\\proj', session_title: 'S' }).text, 'needs you Project : proj ; Session : S')
  assert.equal(alertLine('speak', {}).text, 'The agent needs your attention.')
  assert.equal(alertLine('elicit', { tool_input: { questions: [{ question: 'A?' }, { question: 'B?' }] } }).text, 'A?. B?')
  assert.equal(alertLine('elicit', { tool_input: { questions: [{}] } }).text, 'We have a question for you')
  assert.equal(alertLine('elicit', {}).text, 'The agent has a question for you.')
})

function harness(over = {}) {
  const h = { fetches: [], speaks: [], dir: mkdtempSync(join(tmpdir(), 'alert-speech-')), failFetch: false, status: 200 }
  h.cacheDir = join(h.dir, 'tts-cache')
  h.speaker = { speak: async (text, opts) => { h.speaks.push({ text, opts, fileExisted: opts.file ? existsSync(opts.file) : undefined }); return { status: 'done', ms: 1 } } }
  h.fetchFn = async (url, init) => {
    h.fetches.push({ url, body: JSON.parse(init.body) })
    if (h.failFetch) throw new Error('ECONNREFUSED')
    return { ok: h.status === 200, status: h.status, arrayBuffer: async () => WAV }
  }
  h.speech = createAlertSpeech({ speaker: h.speaker, stateDir: h.dir, cacheDir: h.cacheDir, url: 'http://tts/tts', speed: 1.2, fetchFn: h.fetchFn, ...over })
  return h
}
const stop = { text: 'Done on: A.', gender: 'male', priority: 'Normal', pause: 0.5 }

test('A4 a miss asks the server (text, voice, speed, pause), caches the WAV and plays that file', async () => {
  const h = harness()
  const res = await h.speech.say(stop)
  assert.equal(res.status, 'done')
  assert.deepEqual(h.fetches, [{ url: 'http://tts/tts', body: { text: 'Done on: A.', voice_gender: 'male', speed: 1.2, pause_s: 0.5 } }])
  assert.equal(h.speaks.length, 1)
  const { file, ...rest } = h.speaks[0].opts
  assert.deepEqual(rest, { gender: 'male', priority: 'Normal' })
  assert.equal(h.speaks[0].text, 'Done on: A.')
  assert.equal(h.speaks[0].fileExisted, true)
  assert.deepEqual(readdirSync(h.cacheDir), [file.split('\\').pop()])
})

test('A5 a repeat is a hit: no server request, the same file; a different voice or speed is a different file', async () => {
  const h = harness()
  await h.speech.say(stop)
  await h.speech.say(stop)
  assert.equal(h.fetches.length, 1)
  assert.equal(h.speaks[0].opts.file, h.speaks[1].opts.file)
  await h.speech.say({ ...stop, gender: 'female' })
  assert.equal(h.fetches.length, 2)
  const h2 = harness({ speed: 1.0 })
  await h2.speech.say(stop)
  assert.equal('speed' in h2.fetches[0].body, true)
  const h3 = harness({ speed: undefined })
  await h3.speech.say({ text: 'x', gender: 'male', priority: 'Normal' })
  assert.deepEqual(h3.fetches[0].body, { text: 'x', voice_gender: 'male' }, 'no speed and no pause are sent when not set')
})

test('A6 when the server cannot be reached, or answers an error, the worker gets the text (it starts the server itself)', async () => {
  for (const mode of ['reject', 'status']) {
    const h = harness()
    if (mode === 'reject') h.failFetch = true; else h.status = 500
    const res = await h.speech.say(stop)
    assert.equal(res.status, 'done')
    assert.equal(h.speaks.length, 1)
    assert.deepEqual(h.speaks[0].opts, { gender: 'male', priority: 'Normal', speed: 1.2, pause: 0.5 })
    assert.equal(existsSync(h.cacheDir) ? readdirSync(h.cacheDir).length : 0, 0, 'nothing cached from a failed request')
  }
})

test('A7 muted: nothing is requested or played', async () => {
  const h = harness()
  writeFileSync(join(h.dir, 'tts-muted.flag'), '')
  const res = await h.speech.say(stop)
  assert.equal(res.status, 'muted')
  assert.equal(h.fetches.length + h.speaks.length, 0)
})

test('A8 a long text is played from a temporary file that is removed afterwards, not cached', async () => {
  const h = harness()
  const text = 'word '.repeat(80)
  await h.speech.say({ text, gender: 'male', priority: 'Normal' })
  assert.equal(h.speaks[0].fileExisted, true)
  assert.equal(readdirSync(h.cacheDir).length, 0)
})

test('A9 prune keeps the newest files up to the limit', async () => {
  const h = harness({ maxCacheFiles: 3 })
  await h.speech.say(stop)
  for (let i = 0; i < 4; i++) {
    const f = join(h.cacheDir, 'old' + i + '.wav')
    writeFileSync(f, WAV)
    const t = new Date(Date.now() - (10 - i) * 60_000)
    utimesSync(f, t, t)
  }
  await h.speech.prune()
  const left = readdirSync(h.cacheDir).sort()
  assert.equal(left.length, 3)
  assert.equal(left.includes('old0.wav'), false)
  assert.equal(left.includes('old3.wav'), true)
})

test('A10 run turns a hook body into speech and resolves like a finished hook; an abort ends the wait', async () => {
  const h = harness()
  const res = await h.speech.run('stop', { headline: 'Done on: A.' })
  assert.deepEqual(res, { code: 0, output: {}, stderr: '' })
  assert.equal(h.speaks[0].text, 'Done on: A.')
  const slow = harness()
  slow.speaker.speak = () => new Promise(() => {})
  const ac = new AbortController()
  const p = slow.speech.run('stop', { headline: 'x' }, { signal: ac.signal })
  ac.abort()
  assert.deepEqual(await p, { code: 0, output: {}, stderr: '' })
})
