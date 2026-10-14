import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanForSpeech } from './voice/sanitize.js'

/**
 * Alert read-outs (Stop, permission request, question) without a PowerShell process per hook.
 *
 * The hooks.json launchers (detach-launcher.ps1 -ScriptPath speak|stop-speak|elicitation-speak.ps1) are still the fallback, but
 * when this module is active the plugin does what those scripts did itself: it builds the same line, asks the Kokoro server for the
 * audio, keeps short phrases as WAV files in a cache (a repeated phrase starts without a server round trip) and hands the file to
 * the persistent speak worker (voice/speaker.js), which plays it under the shared playback mutex. Nothing is spawned per alert.
 * When the server cannot be reached the worker is given the text instead (it starts the server, as the scripts did).
 */

const MODES = { 'speak.ps1': 'speak', 'stop-speak.ps1': 'stop', 'elicitation-speak.ps1': 'elicit' }
const EMPTY_RESULT = Object.freeze({ code: 0, output: {}, stderr: '' })

/** 'speak' | 'stop' | 'elicit' for a hooks.json launcher of one of the three speak scripts, else undefined. */
export function speechModeOf(hook) {
  const args = hook?.args
  if (!Array.isArray(args)) return undefined
  const at = args.indexOf('-ScriptPath')
  if (at < 0 || typeof args[at + 1] !== 'string') return undefined
  return MODES[args[at + 1].split(/[\\/]/).pop()]
}

const leaf = (path) => String(path ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()

/** The spoken location suffix of the old scripts (tts-client.ps1 Get-TtsWhere). */
function whereOf(body) {
  const parts = []
  if (body?.cwd) parts.push('Project : ' + leaf(body.cwd))
  if (body?.session_title) parts.push('Session : ' + body.session_title)
  return parts.join(' ; ')
}

/** What a hook body is spoken as, mirroring stop-speak.ps1, speak.ps1 and elicitation-speak.ps1 (the plugin's headline wins). */
export function alertLine(mode, body = {}) {
  const headline = typeof body.headline === 'string' && body.headline ? body.headline : undefined
  let msg = headline
  if (mode === 'stop') {
    if (!msg) {
      const where = []
      if (body.session_title) where.push('Session: ' + body.session_title)
      const workspace = body.cwd ? leaf(body.cwd) : ''
      if (workspace) where.push('Workspace: ' + workspace)
      msg = 'Done' + (where.length ? ' on: ' + where.join('; ') : '') + '.'
    }
    return { text: cleanForSpeech(msg), gender: 'male', priority: 'Normal', pause: 0.5 }
  }
  if (mode === 'speak') {
    if (!msg) {
      msg = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : 'The agent needs your attention.'
      const where = whereOf(body)
      if (where) msg = msg + ' ' + where
    }
    return { text: cleanForSpeech(msg), gender: 'male', priority: 'Normal' }
  }
  if (!msg) {
    const questions = body.tool_input?.questions
    if (Array.isArray(questions) && questions.length) {
      msg = questions.map((q) => String(q?.question ?? '')).join('. ')
      if (!msg.trim()) msg = 'We have a question for you'
    } else if (typeof body.message === 'string' && body.message.trim()) {
      msg = body.message.trim()
    } else {
      msg = 'The agent has a question for you.'
    }
    const where = whereOf(body)
    if (where) msg = msg + ' ' + where
  }
  return { text: cleanForSpeech(msg), gender: 'female', priority: 'High' }
}

/**
 * speaker: createSpeakWorker's { speak(text, opts) }; stateDir: holds tts-muted.flag; url: the Kokoro /tts endpoint;
 * speed: speaking rate sent to the server (omitted when not a number).
 */
export function createAlertSpeech({
  speaker, stateDir, url, speed, cacheDir = join(stateDir, 'tts-cache'), fetchFn = fetch, timeoutMs = 30_000,
  maxCacheFiles = 300, maxCachedChars = 200, log = () => {},
}) {
  const note = (stage, data) => { try { log(stage, data) } catch { /* logging is best-effort */ } }
  const rate = typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : undefined
  let pruned = false

  /** Keeps the newest maxCacheFiles WAVs; leftovers of crashed writes (.tmp) go too. */
  async function prune() {
    let names
    try { names = await readdir(cacheDir) } catch { return }
    const files = []
    for (const name of names) {
      const path = join(cacheDir, name)
      try { files.push({ path, name, mtime: (await stat(path)).mtimeMs }) } catch { /* gone already */ }
    }
    const stale = files.filter((f) => f.name.endsWith('.tmp')).map((f) => f.path)
    const wavs = files.filter((f) => f.name.endsWith('.wav')).sort((a, b) => b.mtime - a.mtime)
    for (const path of [...stale, ...wavs.slice(maxCacheFiles).map((f) => f.path)]) await unlink(path).catch(() => {})
  }

  /** The WAV for a line: from the cache, else from the server (cached when short). undefined = the worker must synthesise it. */
  async function audioFile({ text, gender, pause }, cacheable) {
    const key = createHash('sha1').update(JSON.stringify([gender, rate ?? null, pause ?? null, text])).digest('hex').slice(0, 32)
    const cached = join(cacheDir, key + '.wav')
    if (cacheable && existsSync(cached)) return { file: cached, temp: false }
    const body = { text, voice_gender: gender, ...rate ? { speed: rate } : {}, ...pause ? { pause_s: pause } : {} }
    let bytes
    try {
      const response = await fetchFn(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) { note('alert.server-status', { status: response.status }); return undefined }
      bytes = Buffer.from(await response.arrayBuffer())
    } catch (error) {
      note('alert.server-unreachable', { error: String(error?.message ?? error) })
      return undefined
    }
    await mkdir(cacheDir, { recursive: true })
    const target = cacheable ? cached : join(cacheDir, 'tmp-' + randomUUID() + '.wav')
    // Written under another name and renamed: a player never sees a half-written file.
    const partial = target + '.' + randomUUID().slice(0, 8) + '.tmp'
    await writeFile(partial, bytes)
    await rename(partial, target)
    if (!pruned) { pruned = true; void prune().catch(() => {}) }
    return { file: target, temp: !cacheable }
  }

  async function say(line) {
    const { text, gender, priority, pause } = line
    if (!text || !String(text).trim()) return { status: 'skipped', ms: 0 }
    if (existsSync(join(stateDir, 'tts-muted.flag'))) return { status: 'muted', ms: 0 }
    let audio
    try { audio = await audioFile(line, text.length <= maxCachedChars) } catch (error) { note('alert.cache-failed', { error: String(error?.message ?? error) }) }
    try {
      if (audio) return await speaker.speak(text, { gender, priority, file: audio.file })
      return await speaker.speak(text, { gender, priority, ...rate ? { speed: rate } : {}, ...pause ? { pause } : {} })
    } finally {
      if (audio?.temp) await unlink(audio.file).catch(() => {})
    }
  }

  /** Runs one hook the way a launched script would: resolves when it is spoken (or when the signal aborts), never rejects. */
  function run(mode, body, { signal } = {}) {
    const spoken = say(alertLine(mode, body)).catch((error) => { note('alert.failed', { error: String(error?.message ?? error) }) }).then(() => EMPTY_RESULT)
    if (!signal) return spoken
    if (signal.aborted) return Promise.resolve(EMPTY_RESULT)
    return Promise.race([spoken, new Promise((resolve) => signal.addEventListener('abort', () => resolve(EMPTY_RESULT), { once: true }))])
  }

  return { say, run, prune }
}
