import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BATTERY } from './fixtures/speech-battery.mjs'
import { cleanForSpeech } from '../voice/sanitize.js'
import { fileURLToPath } from 'node:url'

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url))
const skip = process.platform === 'win32' ? false : 'the hook scripts are Windows PowerShell'
const opts = { skip, timeout: 60_000 }

function silentWav(ms = 50) {
  const rate = 8000
  const data = Math.floor((rate * ms) / 1000) * 2
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(data, 40)
  return b
}

/** Run a hook script with the payload on stdin; returns what it asked the (fake) TTS to say. */
async function speak(script, payload, { codepage, launcher } = {}) {
  const spoken = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      spoken.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'audio/wav' })
      res.end(silentWav())
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = mkdtempSync(join(tmpdir(), 'speak-'))
  const env = {
    ...process.env,
    DSH_TTS_URL: `http://127.0.0.1:${server.address().port}/tts`,
    DSH_TTS_STATE_DIR: dir,
    DSH_TTS_HOTKEY_DIR: dir,
    DSH_TTS_SERVER_SCRIPT: '',
  }
  const ps = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
  const file = launcher ? [join(SCRIPTS, 'detach-launcher.ps1'), join(SCRIPTS, script)] : [join(SCRIPTS, script)]
  // Under a legacy console code page the child would decode stdin wrongly unless the script reads it as UTF-8.
  const child = codepage
    ? spawn('cmd.exe', ['/c', `chcp ${codepage} >nul & powershell.exe ${[...ps, ...file.map((f) => '"' + f + '"')].join(' ')}`], { env, windowsVerbatimArguments: true })
    : spawn('powershell.exe', [...ps, ...file], { env })
  child.stdout.resume()
  child.stderr.resume()
  child.stdin.end(JSON.stringify(payload), 'utf8')
  await new Promise((resolve) => child.on('close', resolve))
  // The launcher returns at once; the detached speak script reaches the server a moment later.
  for (let i = 0; launcher && spoken.length === 0 && i < 300; i++) await new Promise((r) => setTimeout(r, 100))
  server.close()
  return spoken
}

test('Stop speaks the headline and never the response', opts, async () => {
  const spoken = await speak('stop-speak.ps1', {
    headline: 'Three, dsh-plugins, done.',
    last_assistant_message: 'A very long answer. '.repeat(50),
    cwd: 'D:\\dev\\ai\\dsh-plugins', session_title: 'Voice work',
  })
  assert.deepEqual(spoken.map((s) => s.text), ['Three, dsh-plugins, done.'])
  assert.equal(spoken[0].voice_gender, 'male')
})

test('Stop is spoken at the normal pace with a pause between sentences; the other alerts keep the normal pace', opts, async () => {
  const [stop] = await speak('stop-speak.ps1', { headline: 'Done on: Session: A; Workspace: B. Text.' })
  assert.equal('speed' in stop, false)
  assert.equal(stop.pause_s, 0.5)
  const [perm] = await speak('speak.ps1', { headline: 'Four, approve write file?' })
  assert.equal('speed' in perm || 'pause_s' in perm, false)
  const [ask] = await speak('elicitation-speak.ps1', { headline: 'Two, question: Which one?' })
  assert.equal('speed' in ask || 'pause_s' in ask, false)
})

test('Stop without a headline still says where, and never reads the response itself', opts, async () => {
  const spoken = await speak('stop-speak.ps1', { last_assistant_message: 'The whole answer.', session_title: 'S', cwd: 'D:\\x\\proj' })
  assert.deepEqual(spoken.map((s) => s.text), ['Done on: Session: S; Workspace: proj.'])
  assert.deepEqual((await speak('stop-speak.ps1', { last_assistant_message: 'The whole answer.' })).map((s) => s.text), ['Done.'])
})

test('a Chinese project name reaches the TTS intact, also from a legacy console code page', opts, async () => {
  for (const codepage of [undefined, 936, 437]) {
    const spoken = await speak('stop-speak.ps1', { headline: 'Three, 项目, done.' }, { codepage })
    assert.deepEqual(spoken.map((s) => s.text), ['Three, 项目, done.'], 'code page ' + codepage)
  }
})

test('the detached launcher passes a Chinese headline on intact from a legacy code page', opts, async () => {
  const spoken = await speak('stop-speak.ps1', { headline: 'Three, 项目, done.' }, { codepage: 936, launcher: true })
  assert.deepEqual(spoken.map((s) => s.text), ['Three, 项目, done.'])
})

test('a permission alert speaks the headline, and falls back to the old wording without one', opts, async () => {
  const withHeadline = await speak('speak.ps1', { headline: 'Four, approve write file?', message: 'old wording' })
  assert.deepEqual(withHeadline.map((s) => s.text), ['Four, approve write file?'])
  const fallback = await speak('speak.ps1', { message: 'The agent needs your permission to use write', cwd: 'D:\\x\\proj' })
  assert.match(fallback[0].text, /permission to use write/)
  assert.match(fallback[0].text, /Project : proj/)
})

test('a question alert speaks the headline in the female priority voice, and falls back to the questions', opts, async () => {
  const withHeadline = await speak('elicitation-speak.ps1', { headline: 'Two, question: Which one?' })
  assert.deepEqual(withHeadline.map((s) => [s.text, s.voice_gender]), [['Two, question: Which one?', 'female']])
  const fallback = await speak('elicitation-speak.ps1', { tool_input: { questions: [{ question: 'A?' }, { question: 'B?' }] } })
  assert.match(fallback[0].text, /A\?\. B\?/)
})

test('the scripts stay pure ASCII and the Stop script no longer reads the response or Insights', () => {
  for (const f of ['tts-client.ps1', 'stop-speak.ps1', 'speak.ps1', 'elicitation-speak.ps1']) {
    assert.equal(/[^\x00-\x7F]/.test(readFileSync(join(SCRIPTS, f), 'utf8')), false, f)
  }
  const stop = readFileSync(join(SCRIPTS, 'stop-speak.ps1'), 'utf8')
  assert.doesNotMatch(stop, /last_assistant_message|Insights/)
  assert.match(stop, /\.headline/)
})

// --- Voice two-stage flow (docs/voice-two-stage-flow.md §2 speak-worker.ps1 / Invoke-KokoroTts -OnPlaybackStart, §7 SC1–SC2).
// Shapes chosen where the spec is open (implementer: follow these):
// - speak-worker.ps1 writes ONLY JSON lines to stdout: {"ready":true} once, then per request {"id":<as sent>,"event":"start"}
//   (from -OnPlaybackStart) and {"id":<as sent>,"status":"done"|"failed","ms":<number>}; EOF on stdin -> exit code 0.
// - Request line: {"id","text","gender","priority"} UTF-8; the TTS gets Clean-ForSpeech(text) and voice_gender = gender.
// - -OnPlaybackStart is a [scriptblock] invoked once per call right before playback; Invoke-KokoroTts still returns $true.
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

/** wavMs = length of the audio every request gets; onRequest(dir) runs while the request is being "synthesised". */
async function fakeTts({ wavMs = 50, onRequest } = {}) {
  let wavLen = wavMs
  const spoken = []
  const dirRef = { dir: '' }
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      spoken.push(JSON.parse(body))
      onRequest?.(dirRef.dir)
      res.writeHead(200, { 'Content-Type': 'audio/wav' })
      res.end(silentWav(wavLen))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = dirRef.dir = mkdtempSync(join(tmpdir(), 'speak-'))
  const env = {
    ...process.env,
    DSH_TTS_URL: `http://127.0.0.1:${server.address().port}/tts`,
    DSH_TTS_STATE_DIR: dir,
    DSH_TTS_HOTKEY_DIR: dir,
    DSH_TTS_SERVER_SCRIPT: '',
  }
  return { spoken, dir, env, close: () => server.close(), setWavMs: (ms) => { wavLen = ms } }
}

/** Collects non-empty stdout lines; until(pred) waits (polling) for pred(lines), the stream end, or a timeout. */
function collectLines(stream) {
  const lines = []
  let buf = ''
  let ended = false
  stream.setEncoding('utf8')
  stream.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (l.trim()) lines.push(l)
    }
  })
  stream.on('end', () => { ended = true })
  const until = async (pred, ms = 40_000) => {
    for (let t = 0; !pred(lines) && !ended && t < ms; t += 50) await new Promise((r) => setTimeout(r, 50))
  }
  return { lines, until }
}

const statusCount = (lines) => lines.filter((l) => l.includes('"status"')).length

test('SC1 speak-worker.ps1 is pure ASCII, says ready, then start and status per line in the female voice', opts, async () => {
  const worker = join(SCRIPTS, 'speak-worker.ps1')
  assert.equal(/[^\x00-\x7F]/.test(readFileSync(worker, 'utf8')), false, 'speak-worker.ps1 is pure ASCII')
  const tts = await fakeTts()
  const child = spawn('powershell.exe', [...PS, worker], { env: tts.env })
  child.stderr.resume()
  const out = collectLines(child.stdout)
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  try {
    await out.until((l) => l.length >= 1)
    child.stdin.write(JSON.stringify({ id: 1, text: 'I heard: **fix** 项目. Is that right?', gender: 'female', priority: 'High' }) + '\n', 'utf8')
    await out.until((l) => statusCount(l) >= 1)
    child.stdin.write(JSON.stringify({ id: 2, text: 'Deciding with LLM.', gender: 'female', priority: 'High' }) + '\n', 'utf8')
    await out.until((l) => statusCount(l) >= 2)
    child.stdin.end()
    assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 20_000))]), 0, 'EOF exits 0')
  } finally {
    child.kill()
    tts.close()
  }
  const msgs = out.lines.map((l) => JSON.parse(l))
  for (const m of msgs.filter((x) => 'status' in x)) assert.equal(typeof m.ms, 'number')
  assert.deepEqual(msgs.map((m) => ('ms' in m ? { ...m, ms: 'n' } : m)), [
    { ready: true },
    { id: 1, event: 'start', durationMs: 50 },
    { id: 1, status: 'done', ms: 'n' },
    { id: 2, event: 'start', durationMs: 50 },
    { id: 2, status: 'done', ms: 'n' },
  ])
  assert.deepEqual(tts.spoken.map((s) => [s.text, s.voice_gender]), [
    ['I heard: fix 项目. Is that right?', 'female'],
    ['Deciding with LLM.', 'female'],
  ])
  // The Ctrl+Alt+M hotkey kills every PID in audio.pids; the worker must never list itself there (only tts-stop.flag cuts it).
  assert.equal(existsSync(join(tts.dir, 'audio.pids')), false, 'the worker never writes its PID to audio.pids')
})

test('SC4 speak-worker.ps1 removes a stale (older than 20 s) tts-priority-pending.flag (left by a killed worker) at start-up', opts, async () => {
  const tts = await fakeTts()
  const flag = join(tts.dir, 'tts-priority-pending.flag')
  writeFileSync(flag, 'stale')
  const old = new Date(Date.now() - 60_000)
  utimesSync(flag, old, old)
  const child = spawn('powershell.exe', [...PS, join(SCRIPTS, 'speak-worker.ps1')], { env: tts.env })
  child.stderr.resume()
  const out = collectLines(child.stdout)
  try {
    await out.until((l) => l.length >= 1)
    assert.deepEqual(out.lines, ['{"ready":true}'])
    assert.equal(existsSync(flag), false, 'the stale flag is gone before the worker says ready')
  } finally {
    child.stdin.end()
    child.kill()
    tts.close()
  }
})

async function runKokoro(lines, { before, ...ttsOpts } = {}) {
  const tts = await fakeTts(ttsOpts)
  before?.(tts.dir)
  const file = join(tts.dir, 'call.ps1')
  writeFileSync(file, [". '" + join(SCRIPTS, 'tts-client.ps1') + "'", ...lines].join('\r\n'))
  const child = spawn('powershell.exe', [...PS, file], { env: tts.env })
  child.stderr.resume()
  const out = collectLines(child.stdout)
  await new Promise((resolve) => child.on('close', resolve))
  tts.close()
  return { spoken: tts.spoken, out: out.lines, dir: tts.dir }
}

test('SC2 Invoke-KokoroTts without -OnPlaybackStart is unchanged', opts, async () => {
  const r = await runKokoro([
    "$r = Invoke-KokoroTts -Text 'Plain line.' -Gender female -Priority High",
    "[Console]::Out.WriteLine('RESULT=' + $r)",
  ])
  assert.deepEqual(r.out, ['RESULT=True'])
  assert.deepEqual(r.spoken, [{ text: 'Plain line.', voice_gender: 'female' }])
})

test('SC2 Invoke-KokoroTts -OnPlaybackStart runs the callback once before playback and still returns true', opts, async () => {
  const r = await runKokoro([
    "$r = Invoke-KokoroTts -Text 'Callback line.' -Gender female -Priority High -OnPlaybackStart { [Console]::Out.WriteLine('PLAYBACK-START') }",
    "[Console]::Out.WriteLine('RESULT=' + $r)",
  ])
  assert.deepEqual(r.out, ['PLAYBACK-START', 'RESULT=True'])
  assert.deepEqual(r.spoken, [{ text: 'Callback line.', voice_gender: 'female' }])
})

test('SC3 Invoke-KokoroTts -NoPidFile keeps its PID out of audio.pids; without it the PID is still recorded', opts, async () => {
  const quiet = await runKokoro([
    "$r = Invoke-KokoroTts -Text 'No pid line.' -Gender female -Priority High -NoPidFile",
    "[Console]::Out.WriteLine('RESULT=' + $r)",
  ])
  assert.deepEqual(quiet.out, ['RESULT=True'])
  assert.equal(existsSync(join(quiet.dir, 'audio.pids')), false, '-NoPidFile writes no audio.pids')
  const plain = await runKokoro([
    "$r = Invoke-KokoroTts -Text 'Pid line.' -Gender female -Priority High",
    "[Console]::Out.WriteLine('RESULT=' + $r)",
  ])
  assert.deepEqual(plain.out, ['RESULT=True'])
  assert.match(readFileSync(join(plain.dir, 'audio.pids'), 'utf8'), /^\d+\s*$/, 'existing callers still record their PID')
})

// --- Barge-in must cut a line that is still being synthesised / queued (finding: stale flow lines played into the open mic).
// The STT daemon touches tts-stop.flag when it starts listening. Invoke-KokoroTts used to delete that flag just before
// playback, so a flag created DURING synthesis was lost; now it removes only flags older than the call itself.
const PLAY_MARK = "-OnPlaybackStart { $global:playAt = Get-Date }"
const elapsedLines = [
  "[Console]::Out.WriteLine('ELAPSED=' + [int]((Get-Date) - $global:playAt).TotalMilliseconds)",
]
const elapsedOf = (out) => Number(out.find((l) => l.startsWith('ELAPSED='))?.slice(8))

test('SC5 a stop flag created while the line is being synthesised still cuts its playback', opts, async () => {
  const r = await runKokoro([
    "$r = Invoke-KokoroTts -Text 'Long stale line.' -Gender female -Priority High -KeepNewerStopFlag " + PLAY_MARK,
    ...elapsedLines,
    "[Console]::Out.WriteLine('RESULT=' + $r)",
  ], { wavMs: 8000, onRequest: (dir) => writeFileSync(join(dir, 'tts-stop.flag'), 'barge-in') })
  assert.ok(r.out.includes('RESULT=True'), r.out.join('|'))
  assert.ok(elapsedOf(r.out) < 4000, 'cut at once instead of playing 8 s, took ' + elapsedOf(r.out) + ' ms')
  assert.equal(existsSync(join(r.dir, 'tts-stop.flag')), false, 'the flag is consumed by the cut')
})

test('SC5 a stop flag left over from before the call is still deleted and the line plays in full', opts, async () => {
  const r = await runKokoro([
    "$r = Invoke-KokoroTts -Text 'Fresh line.' -Gender female -Priority High -KeepNewerStopFlag " + PLAY_MARK,
    ...elapsedLines,
    "[Console]::Out.WriteLine('RESULT=' + $r)",
  ], {
    wavMs: 1500,
    before: (dir) => {
      const flag = join(dir, 'tts-stop.flag')
      writeFileSync(flag, 'old')
      const old = new Date(Date.now() - 60_000)
      utimesSync(flag, old, old)
    },
  })
  assert.ok(r.out.includes('RESULT=True'), r.out.join('|'))
  assert.ok(elapsedOf(r.out) >= 1200, 'a stale flag must not cut a new line, took ' + elapsedOf(r.out) + ' ms')
  assert.equal(existsSync(join(r.dir, 'tts-stop.flag')), false, 'the stale flag was cleaned up')
})

// --- Regression R1: legacy callers (stop-speak/speak/elicitation-speak) clear tts-stop.flag when they get the playback mutex.
// Only the speak worker passes -KeepNewerStopFlag; without it a flag created after the call began is cleared as before, so
// Ctrl+Alt+M / the mute toggle never cut or eat the NEXT queued alert.
test('R1 without -KeepNewerStopFlag a stop flag created after the call started is cleared and the line plays in full', opts, async () => {
  const r = await runKokoro([
    "$r = Invoke-KokoroTts -Text 'Legacy alert.' -Gender female -Priority High " + PLAY_MARK,
    ...elapsedLines,
    "[Console]::Out.WriteLine('RESULT=' + $r + ' CUT=' + $script:TtsLastCut)",
  ], { wavMs: 1500, onRequest: (dir) => writeFileSync(join(dir, 'tts-stop.flag'), 'mute-toggle') })
  assert.ok(r.out.includes('RESULT=True CUT=False'), r.out.join('|'))
  assert.ok(elapsedOf(r.out) >= 1200, 'a legacy caller is not cut by a flag raised before it got the mutex, took ' + elapsedOf(r.out) + ' ms')
  assert.equal(existsSync(join(r.dir, 'tts-stop.flag')), false, 'the flag was cleared')
})

test('R1 speak-worker.ps1 passes -KeepNewerStopFlag to Invoke-KokoroTts (and nothing else does)', () => {
  assert.match(readFileSync(join(SCRIPTS, 'speak-worker.ps1'), 'utf8'), /Invoke-KokoroTts[^\r\n]*-KeepNewerStopFlag/)
  for (const f of ['stop-speak.ps1', 'speak.ps1', 'elicitation-speak.ps1']) {
    assert.doesNotMatch(readFileSync(join(SCRIPTS, f), 'utf8'), /KeepNewerStopFlag/, f)
  }
})

// --- Regression R3: voice-flow lines honour tts-muted.flag (checked at request time); R9: a live High-priority flag survives worker start.
test('R3 speak-worker.ps1 answers muted, without synthesis or start event, while tts-muted.flag exists; speaks again once unmuted', opts, async () => {
  const tts = await fakeTts()
  writeFileSync(join(tts.dir, 'tts-muted.flag'), 'muted')
  const child = spawn('powershell.exe', [...PS, join(SCRIPTS, 'speak-worker.ps1')], { env: tts.env })
  child.stderr.resume()
  const out = collectLines(child.stdout)
  try {
    await out.until((l) => l.length >= 1)
    child.stdin.write(JSON.stringify({ id: 1, text: 'Cancelled.', gender: 'female', priority: 'High' }) + '\n', 'utf8')
    await out.until((l) => statusCount(l) >= 1)
    rmSync(join(tts.dir, 'tts-muted.flag'))
    child.stdin.write(JSON.stringify({ id: 2, text: 'audible', gender: 'female', priority: 'High' }) + '\n', 'utf8')
    await out.until((l) => statusCount(l) >= 2)
  } finally {
    child.stdin.end()
    child.kill()
    tts.close()
  }
  const msgs = out.lines.map((l) => JSON.parse(l))
  assert.deepEqual(msgs.filter((m) => 'status' in m).map((m) => [m.id, m.status]), [[1, 'muted'], [2, 'done']])
  assert.deepEqual(msgs.filter((m) => m.event === 'start').map((m) => m.id), [2], 'no playback start for a muted line')
  assert.deepEqual(tts.spoken.map((s) => s.text), ['audible'], 'a muted line never reaches the TTS server')
})

test('R9 speak-worker.ps1 keeps a fresh tts-priority-pending.flag (a live High-priority alert) at start-up', opts, async () => {
  const tts = await fakeTts()
  const flag = join(tts.dir, 'tts-priority-pending.flag')
  writeFileSync(flag, 'live')
  const child = spawn('powershell.exe', [...PS, join(SCRIPTS, 'speak-worker.ps1')], { env: tts.env })
  child.stderr.resume()
  const out = collectLines(child.stdout)
  try {
    await out.until((l) => l.length >= 1)
    assert.deepEqual(out.lines, ['{"ready":true}'])
    assert.equal(existsSync(flag), true, 'a flag younger than 20 s may belong to a live elicitation-speak')
  } finally {
    child.stdin.end()
    child.kill()
    tts.close()
  }
})

test('SC6 speak-worker.ps1 answers cancelled, without speaking, for lines below the tts-voice-cancel.json marker; later lines are spoken', opts, async () => {
  const tts = await fakeTts()
  const child = spawn('powershell.exe', [...PS, join(SCRIPTS, 'speak-worker.ps1')], { env: tts.env })
  child.stderr.resume()
  const out = collectLines(child.stdout)
  try {
    await out.until((l) => l.length >= 1)
    writeFileSync(join(tts.dir, 'tts-voice-cancel-' + child.pid + '.json'), JSON.stringify({ before: 3 }))
    for (const id of [1, 2, 3]) child.stdin.write(JSON.stringify({ id, text: 'line ' + id, gender: 'female', priority: 'High' }) + '\n', 'utf8')
    await out.until((l) => statusCount(l) >= 3)
  } finally {
    child.stdin.end()
    child.kill()
    tts.close()
  }
  const msgs = out.lines.map((l) => JSON.parse(l))
  const statuses = msgs.filter((m) => 'status' in m).map((m) => [m.id, m.status])
  assert.deepEqual(statuses, [[1, 'cancelled'], [2, 'cancelled'], [3, 'done']])
  assert.deepEqual(tts.spoken.map((s) => s.text), ['line 3'], 'cancelled lines never reach the TTS server')
  assert.deepEqual(msgs.filter((m) => m.event === 'start').map((m) => m.id), [3], 'no playback start for a cancelled line')
})

test('SC6 a tts-voice-cancel-<pid>.json left by an earlier worker with the same PID (older than this worker) is removed at start-up and skips nothing', opts, async () => {
  const tts = await fakeTts()
  const child = spawn('powershell.exe', [...PS, join(SCRIPTS, 'speak-worker.ps1')], { env: tts.env })
  const marker = join(tts.dir, 'tts-voice-cancel-' + child.pid + '.json')
  // The worker needs a moment to start, so a marker written right now is NOT older than the process: backdate it.
  writeFileSync(marker, JSON.stringify({ before: 999 }))
  const old = new Date(Date.now() - 600_000)
  utimesSync(marker, old, old)
  child.stderr.resume()
  const out = collectLines(child.stdout)
  try {
    await out.until((l) => l.length >= 1)
    assert.equal(existsSync(marker), false, 'the stale marker is gone before the worker says ready')
    child.stdin.write(JSON.stringify({ id: 1, text: 'first line', gender: 'female', priority: 'High' }) + '\n', 'utf8')
    await out.until((l) => statusCount(l) >= 1)
  } finally {
    child.stdin.end()
    child.kill()
    tts.close()
  }
  assert.deepEqual(out.lines.map((l) => JSON.parse(l)).filter((m) => 'status' in m).map((m) => m.status), ['done'])
  assert.deepEqual(tts.spoken.map((s) => s.text), ['first line'])
})

test('SC6 the scripts changed for the barge-in cut stay pure ASCII', () => {
  for (const f of ['speak-worker.ps1', 'tts-client.ps1']) {
    assert.equal(/[^\x00-\x7F]/.test(readFileSync(join(SCRIPTS, f), 'utf8')), false, f)
  }
})

test('SC6 a cancel marker of another worker (other PID) skips nothing in this worker', opts, async () => {
  const tts = await fakeTts()
  const child = spawn('powershell.exe', [...PS, join(SCRIPTS, 'speak-worker.ps1')], { env: tts.env })
  child.stderr.resume()
  const out = collectLines(child.stdout)
  try {
    await out.until((l) => l.length >= 1)
    writeFileSync(join(tts.dir, 'tts-voice-cancel-' + (child.pid + 1) + '.json'), JSON.stringify({ before: 99 }))
    writeFileSync(join(tts.dir, 'tts-voice-cancel.json'), JSON.stringify({ before: 99 }))
    for (const id of [1, 2]) child.stdin.write(JSON.stringify({ id, text: 'line ' + id, gender: 'female', priority: 'High' }) + '\n', 'utf8')
    await out.until((l) => statusCount(l) >= 2)
  } finally {
    child.stdin.end()
    child.kill()
    tts.close()
  }
  assert.deepEqual(out.lines.map((l) => JSON.parse(l)).filter((m) => 'status' in m).map((m) => m.status), ['done', 'done'])
  assert.deepEqual(tts.spoken.map((s) => s.text), ['line 1', 'line 2'])
})

// --- Item 3: the worker tells a line cut short by the stop flag (Ctrl+Alt+M) from one played in full.
test('SC7 speak-worker.ps1 answers cut when the stop flag ended the line early, done when it played to the end', opts, async () => {
  const tts = await fakeTts({ wavMs: 6000, onRequest: (dir) => { if (tts.spoken.length === 1) writeFileSync(join(dir, 'tts-stop.flag'), 'hotkey') } })
  const child = spawn('powershell.exe', [...PS, join(SCRIPTS, 'speak-worker.ps1')], { env: tts.env })
  child.stderr.resume()
  const out = collectLines(child.stdout)
  try {
    await out.until((l) => l.length >= 1)
    child.stdin.write(JSON.stringify({ id: 1, text: 'cut me', gender: 'female', priority: 'High' }) + '\n', 'utf8')
    await out.until((l) => statusCount(l) >= 1)
    tts.setWavMs(300)
    child.stdin.write(JSON.stringify({ id: 2, text: 'play me', gender: 'female', priority: 'High' }) + '\n', 'utf8')
    await out.until((l) => statusCount(l) >= 2)
  } finally {
    child.stdin.end()
    child.kill()
    tts.close()
  }
  const statuses = out.lines.map((l) => JSON.parse(l)).filter((m) => 'status' in m).map((m) => [m.id, m.status])
  assert.deepEqual(statuses, [[1, 'cut'], [2, 'done']])
})

const r0 = { done: false }
test('SC7 Invoke-KokoroTts still returns true for a cut line and records the cut in $script:TtsLastCut', opts, async () => {
  const r = await runKokoro([
    "$r = Invoke-KokoroTts -Text 'Cut line.' -Gender female -Priority High -KeepNewerStopFlag",
    "[Console]::Out.WriteLine('RESULT=' + $r + ' CUT=' + $script:TtsLastCut)",
    "$r = Invoke-KokoroTts -Text 'Full line.' -Gender female -Priority High",
    "[Console]::Out.WriteLine('RESULT=' + $r + ' CUT=' + $script:TtsLastCut)",
  ], { wavMs: 1500, onRequest: (dir) => { if (!r0.done) { r0.done = true; writeFileSync(join(dir, 'tts-stop.flag'), 'x') } } })
  assert.deepEqual(r.out, ['RESULT=True CUT=True', 'RESULT=True CUT=False'])
})

// --- Item 2: Clean-ForSpeech has a quadratic link regex; its input is capped before cleaning.
test('SC8 Clean-ForSpeech caps its input at 4000 characters before cleaning (bounded time on hostile text)', opts, async () => {
  const r = await runKokoro([
    "$long = '[' * 20000",
    "$sw = [System.Diagnostics.Stopwatch]::StartNew()",
    "$c = Clean-ForSpeech $long",
    "[Console]::Out.WriteLine('LEN=' + $c.Length)",
    "[Console]::Out.WriteLine('FAST=' + ($sw.Elapsed.TotalSeconds -lt 10))",
    "[Console]::Out.WriteLine('SHORT=' + (Clean-ForSpeech 'plain words'))",
  ])
  assert.ok(Number(r.out.find((l) => l.startsWith('LEN='))?.slice(4)) <= 4000, r.out.join('|'))
  assert.ok(r.out.includes('FAST=True'), r.out.join('|'))
  assert.ok(r.out.includes('SHORT=plain words'), r.out.join('|'))
})

// --- Security F1: voice/sanitize.js cleanForSpeech is a JS port of Clean-ForSpeech; both must agree on the shared battery.
test('SC9 the JS port of Clean-ForSpeech gives the same result as the real PowerShell function', opts, async () => {
  const json = JSON.stringify(BATTERY).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  const r = await runKokoro([
    "$items = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'in.json') | ConvertFrom-Json",
    "$res = @(); foreach ($i in $items) { $res += ,(Clean-ForSpeech $i) }",
    "[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'out.json'), (ConvertTo-Json -Compress -InputObject $res), (New-Object Text.UTF8Encoding $false))",
  ], { before: (dir) => writeFileSync(join(dir, 'in.json'), json) })
  const got = JSON.parse(readFileSync(join(r.dir, 'out.json'), 'utf8'))
  assert.equal(got.length, BATTERY.length)
  BATTERY.forEach((text, i) => assert.equal(cleanForSpeech(text), got[i], JSON.stringify(text)))
})
