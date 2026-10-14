import { writeFileSync } from 'node:fs'
import { readdir, stat, unlink as unlinkFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Persistent speak worker (docs/voice-two-stage-flow.md §0 D1): one prewarmed scripts/speak-worker.ps1 process speaks
 * every voice-flow line over a JSON-lines protocol, so PowerShell's cold start (~0.5-1 s) is paid once, not per line.
 *
 * Protocol: request  {"id","text","gender","priority"}\n on stdin;
 *           replies  {"ready":true} | {"id","event":"start","durationMs"?} | {"id","status":"done"|"failed","ms"} on stdout.
 * Timeouts: a line waits at most requestTimeoutMs for its 'start' event (counted from when it reaches the head of its
 * worker's queue, so it covers synthesis and the playback mutex, not earlier lines); on 'start' the timer is re-armed
 * with the WAV duration + playbackMarginMs (playbackFallbackMs when the worker sent no duration).
 * When the worker keeps dying (more than maxRespawns exits within 60 s) every line gets its own process instead
 * (one line, then EOF) for oneShotRetryMs, after which the next line tries a persistent worker again. The child is never detached: a detached PowerShell with piped stdio exits silently on Windows.
 * speak() never rejects; it resolves { status:'done'|'cut'|'failed'|'timeout'|'cancelled'|'muted', ms, startMs? }. 'muted' = tts-muted.flag existed when the worker took the line; it was not spoken. 'cut' = the line was stopped early
 * (the worker saw the stop flag, or exited unexpectedly after the line's start event) and does not count as a worker death.
 * cancel() (a barge-in): lines queued behind the head resolve 'cancelled' at once. Requests are already written to the
 * worker's stdin, so the worker is told through two files in the TTS state dir (the worker cannot read stdin while it
 * speaks): tts-voice-cancel-<worker PID>.json {"before": <next request id>} makes it answer every not-yet-begun line below that id
 * 'cancelled' without speaking, and tts-stop.flag cuts the line in flight (Invoke-KokoroTts polls it and keeps any flag
 * created after the call began). The worker itself is never killed.
 */

const RESPAWN_WINDOW_MS = 60_000
/** One-shot mode is a degraded mode: it ends after this long, and the next line tries a persistent worker again. */
const ONE_SHOT_RETRY_MS = 5 * 60_000
/** A cancel marker only matters around the barge-in that wrote it; one this old belongs to a worker that is long gone. */
const STALE_MARKER_MS = 10 * 60_000
const MARKER_FILE = /^tts-voice-cancel(?:-\d+)?\.json$/
const PRIORITY_FLAG = 'tts-priority-pending.flag'
const STOP_FLAG = 'tts-stop.flag'
/** One cancel marker per worker process (named after its PID): hosts share the state dir and their request ids all restart at 1. */
const cancelMarkerName = (pid) => 'tts-voice-cancel-' + pid + '.json'
/** Windows PowerShell by absolute path: a bare name is looked up on PATH, where a writable directory could shadow it. */
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** The one voice of every voice-flow line (spec §0 D3); flow.js and service.js reuse it. */
export const VOICE = Object.freeze({ gender: 'female', priority: 'High' })

export function createSpeakWorker({
  spawn, root, env, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
  requestTimeoutMs = 45_000, playbackMarginMs = 5_000, playbackFallbackMs = 120_000, maxRespawns = 3,
  unlink = unlinkFile, writeFile = writeFileSync, readDir = readdir, statFile = stat,
  oneShotRetryMs = ONE_SHOT_RETRY_MS, staleMarkerMs = STALE_MARKER_MS,
}) {
  const script = join(root, 'scripts', 'speak-worker.ps1')
  // Same state dir tts-client.ps1 uses for its High-priority flag and its stop flag.
  const stateDir = env?.DSH_TTS_STATE_DIR || join(env?.TEMP || tmpdir(), 'dsh-tts')
  const flagPath = join(stateDir, PRIORITY_FLAG)
  const live = new Set() // every running worker record (the persistent one plus one-shot processes)
  let worker // the persistent worker record, when one is running
  let nextId = 1
  let oneShot = false
  let oneShotSince = 0
  let swept = false
  let deaths = [] // times of unexpected persistent-worker exits

  const note = (stage, data) => { try { log(stage, data) } catch { /* logging is best-effort */ } }

  /** Once per speaker: removes cancel markers that dead workers (a crashed host, a killed process) left in the state dir. */
  function sweepStaleMarkers() {
    if (swept) return
    swept = true
    // A state dir that does not exist yet (nothing was ever spoken) has no markers to sweep: that is not a failure.
    const fail = (error) => { if (error?.code !== 'ENOENT') note('worker.marker-sweep-failed', { error: String(error?.message ?? error) }) }
    Promise.resolve().then(async () => {
      for (const name of await readDir(stateDir)) {
        if (!MARKER_FILE.test(name)) continue
        const path = join(stateDir, name)
        try {
          if (now() - (await statFile(path)).mtimeMs > staleMarkerMs) removeFile(path)
        } catch { /* gone already, or unreadable: leave it */ }
      }
    }).catch(fail)
  }

  /** One-shot mode ends after oneShotRetryMs: the next line tries a persistent worker again. Its deaths have aged out of the 60 s window by then (countDeath prunes), so the count starts fresh without a reset. */
  function leaveOneShotWhenDue() {
    if (!oneShot || now() - oneShotSince < oneShotRetryMs) return
    oneShot = false
    note('worker.one-shot-ended', {})
  }

  /** Starts one worker process; throws when spawn itself throws. */
  function start(single) {
    const t0 = now()
    sweepStaleMarkers()
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env,
    })
    const w = { child, single, pending: new Map(), buf: '', gone: false, killedByUs: false, t0, markerWritten: false }
    live.add(w)
    note('worker.spawn', { oneShot: single })
    child.stdin?.on?.('error', () => {}) // EPIPE after the worker died is handled by its 'exit'
    child.stderr?.on?.('data', (d) => note('worker.stderr', { text: String(d).trim().slice(0, 200) }))
    child.stdout?.on?.('data', (d) => onData(w, d))
    child.on('exit', (code, signal) => onExit(w, { code, signal }))
    child.on('error', (error) => onExit(w, { error: String(error?.message ?? error) }))
    return w
  }

  function ensureWorker() {
    if (!worker) worker = start(false)
    return worker
  }

  function onData(w, chunk) {
    w.buf += String(chunk)
    let i
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const text = w.buf.slice(0, i).trim()
      w.buf = w.buf.slice(i + 1)
      let msg
      try { msg = JSON.parse(text) } catch { continue } // non-protocol output (warnings etc.) is ignored
      if (msg && typeof msg === 'object') onMessage(w, msg)
    }
  }

  function onMessage(w, msg) {
    if (msg.ready === true) return note('worker.ready', { ms: now() - w.t0 })
    const req = w.pending.get(msg.id)
    if (!req) return
    if (msg.event === 'start') return onStart(w, req, msg)
    if (msg.status === undefined) return
    const known = msg.status === 'done' || msg.status === 'cancelled' || msg.status === 'cut' || msg.status === 'muted'
    const result = { status: known ? msg.status : 'failed', ms: Number(msg.ms) || 0 }
    if (req.startAt !== undefined) result.startMs = req.startAt - req.t0
    finish(w, req, result)
  }

  /** Playback began: the wait timer is replaced by a budget for the playback itself (WAV duration + margin). */
  function onStart(w, req, msg) {
    req.startAt = now()
    clearTimer(req.timer)
    const d = msg.durationMs
    const budget = typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d + playbackMarginMs : playbackFallbackMs
    req.timer = setTimer(() => onTimeout(w, req), budget)
  }

  /** Arms the wait timer of the line at the head of the worker's queue (the worker speaks its lines in order). */
  function armHead(w) {
    const head = w.pending.values().next().value
    if (head && head.timer === undefined) head.timer = setTimer(() => onTimeout(w, head), requestTimeoutMs)
  }

  function finish(w, req, result) {
    if (!w.pending.delete(req.id)) return
    clearTimer(req.timer)
    req.resolve(result)
    if (!w.gone) armHead(w)
  }

  function onExit(w, info) {
    if (w.gone) return
    w.gone = true
    live.delete(w)
    note('worker.exit', { ...info, oneShot: w.single })
    if (w.killedByUs && w.ownsFlag) removePriorityFlag()
    if (w.markerWritten) removeFile(join(stateDir, cancelMarkerName(w.child.pid)))
    // An unexpected exit after a line's 'start' event is a cut line (e.g. an external stop killed the process): it
    // resolves 'cut' (spec §0 D2: the flow must not treat a half-heard line as heard) and is not a crash, so it never counts toward the one-shot death limit.
    let cut = false
    for (const req of [...w.pending.values()]) {
      const started = !w.killedByUs && req.startAt !== undefined
      cut ||= started
      const ms = now() - req.t0
      finish(w, req, started ? { status: 'cut', ms, startMs: req.startAt - req.t0 } : { status: 'failed', ms })
    }
    if (w !== worker) return
    worker = undefined
    if (!w.killedByUs && !cut) countDeath()
  }

  /** The (maxRespawns + 1)th unexpected exit within 60 s switches to one-shot mode for good. */
  function countDeath() {
    const t = now()
    deaths = [...deaths.filter((d) => t - d < RESPAWN_WINDOW_MS), t]
    if (deaths.length > maxRespawns && !oneShot) {
      oneShot = true
      oneShotSince = t
      note('worker.one-shot', { deaths: deaths.length })
    }
  }

  /**
   * A worker killed mid-line skips Invoke-KokoroTts's finally block, so its High-priority flag would linger and make
   * Normal-priority hook read-outs wait up to 20 s. midLine = the line being killed was already resolved (timeout).
   */
  function kill(w, midLine = false) {
    w.killedByUs = true
    w.ownsFlag ||= midLine || [...w.pending.values()].some((r) => r.high)
    if (w === worker) worker = undefined
    try { w.child.kill() } catch { /* already gone */ }
  }

  /** A hung line resolves 'timeout' and its worker is killed; the next line goes to a new worker. */
  function onTimeout(w, req) {
    if (!w.pending.has(req.id)) return
    finish(w, req, { status: 'timeout', ms: now() - req.t0 })
    note('worker.timeout', { id: req.id, started: req.startAt !== undefined })
    kill(w, req.high)
  }

  /** Best-effort removal of a state-dir file (a missing file is fine). */
  function removeFile(path) {
    const fail = (error) => {
      if (error?.code !== 'ENOENT') note('worker.file-remove-failed', { error: String(error?.message ?? error) })
    }
    try { Promise.resolve(unlink(path)).catch(fail) } catch (error) { fail(error) }
  }

  /** Best-effort: the flag may not exist (the line never got that far) or be locked; neither may break speaking. */
  function removePriorityFlag() {
    const fail = (error) => {
      if (error?.code !== 'ENOENT') note('worker.flag-remove-failed', { error: String(error?.message ?? error) })
    }
    try { Promise.resolve(unlink(flagPath)).then(() => note('worker.flag-removed', {}), fail) } catch (error) { fail(error) }
  }

  /** Best-effort file write (sync by default so the marker exists before the flag); neither failure mode may break voice. */
  function put(name, content) {
    const fail = (error) => note('worker.cancel-write-failed', { file: name, error: String(error?.message ?? error) })
    try { Promise.resolve(writeFile(join(stateDir, name), content)).catch(fail) } catch (error) { fail(error) }
  }

  /**
   * Barge-in: whatever the worker still has to say must not be heard (the mic is open). The head of each worker's queue
   * is already in the worker, so it is left to resolve itself (cut by the flag, or skipped via the marker); every line
   * behind it that never started resolves 'cancelled' now. Nothing is written when no line is outstanding: the stop flag
   * would otherwise cut an unrelated read-out playing from a hook script.
   */
  function cancel() {
    let queued = 0
    let outstanding = false
    const marked = []
    for (const w of [...live]) {
      outstanding ||= w.pending.size > 0
      if (w.pending.size > 0) marked.push(w)
      for (const req of [...w.pending.values()].slice(1)) {
        if (req.startAt !== undefined) continue
        finish(w, req, { status: 'cancelled', ms: now() - req.t0 })
        queued++
      }
    }
    note('worker.cancel', { queued, outstanding })
    if (!outstanding) return
    // Each worker with lines outstanding gets its own marker: "skip every line below this id".
    for (const w of marked) {
      if (!Number.isInteger(w.child.pid)) continue
      w.markerWritten = true
      put(cancelMarkerName(w.child.pid), JSON.stringify({ before: nextId }))
    }
    put(STOP_FLAG, new Date(now()).toISOString())
  }

  function speak(text, opts = {}) {
    const id = nextId++
    const t0 = now()
    const priority = opts.priority ?? VOICE.priority
    // file (a WAV to play instead of asking the server), speed and pause are optional extras; a plain line keeps its exact shape.
    const extras = {
      ...typeof opts.file === 'string' && opts.file ? { file: opts.file } : {},
      ...typeof opts.speed === 'number' && opts.speed > 0 ? { speed: opts.speed } : {},
      ...typeof opts.pause === 'number' && opts.pause > 0 ? { pause: opts.pause } : {},
    }
    const body = JSON.stringify({ id, text: String(text ?? ''), gender: opts.gender ?? VOICE.gender, priority, ...extras }) + '\n'
    leaveOneShotWhenDue()
    return new Promise((resolve) => {
      let w
      try { w = oneShot ? start(true) : ensureWorker() } catch (error) {
        note('worker.spawn-failed', { error: String(error?.message ?? error) })
        return resolve({ status: 'failed', ms: now() - t0 })
      }
      const req = { id, t0, resolve, high: priority === 'High' }
      w.pending.set(id, req)
      armHead(w)
      try {
        w.child.stdin.write(body)
        if (w.single) w.child.stdin.end()
      } catch (error) {
        note('worker.write-failed', { error: String(error?.message ?? error) })
        finish(w, req, { status: 'failed', ms: now() - t0 })
        kill(w)
      }
    })
  }

  return {
    speak,
    cancel,
    /** Prewarm the persistent worker (no audio). No-op in one-shot mode or when spawning fails. */
    warm() {
      leaveOneShotWhenDue()
      if (oneShot) return
      try { ensureWorker() } catch (error) { note('worker.spawn-failed', { error: String(error?.message ?? error) }) }
    },
    /** Kill every worker; their pending lines resolve 'failed' and nothing respawns until the next speak()/warm(). */
    stop() {
      for (const w of [...live]) kill(w)
    },
  }
}
