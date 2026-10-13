import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

async function fakeTts() {
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
  return { spoken, dir, env, close: () => server.close() }
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

test('SC1 speak-worker.ps1 is pure ASCII, ignores tts-muted.flag, says ready, then start and status per line in the female voice', opts, async () => {
  const worker = join(SCRIPTS, 'speak-worker.ps1')
  assert.equal(/[^\x00-\x7F]/.test(readFileSync(worker, 'utf8')), false, 'speak-worker.ps1 is pure ASCII')
  const tts = await fakeTts()
  writeFileSync(join(tts.dir, 'tts-muted.flag'), 'muted')
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
    { id: 1, event: 'start' },
    { id: 1, status: 'done', ms: 'n' },
    { id: 2, event: 'start' },
    { id: 2, status: 'done', ms: 'n' },
  ])
  assert.deepEqual(tts.spoken.map((s) => [s.text, s.voice_gender]), [
    ['I heard: fix 项目. Is that right?', 'female'],
    ['Deciding with LLM.', 'female'],
  ])
})

async function runKokoro(lines) {
  const tts = await fakeTts()
  const file = join(tts.dir, 'call.ps1')
  writeFileSync(file, [". '" + join(SCRIPTS, 'tts-client.ps1') + "'", ...lines].join('\r\n'))
  const child = spawn('powershell.exe', [...PS, file], { env: tts.env })
  child.stderr.resume()
  const out = collectLines(child.stdout)
  await new Promise((resolve) => child.on('close', resolve))
  tts.close()
  return { spoken: tts.spoken, out: out.lines }
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
