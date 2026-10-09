import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
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

test('Stop without a headline says Done, still not the response', opts, async () => {
  const spoken = await speak('stop-speak.ps1', { last_assistant_message: 'The whole answer.' })
  assert.deepEqual(spoken.map((s) => s.text), ['Done.'])
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
