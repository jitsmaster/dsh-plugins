import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createReader } from '../reader.js'

function fakeSpawn() {
  const runs = []
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter()
    const written = []
    child.stdin = Object.assign(new EventEmitter(), { write: (s) => { written.push(String(s)); return true }, end: (s) => { if (s) written.push(String(s)) } })
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')) }
    runs.push({ exe, args, opts, child, written })
    return child
  }
  return { spawn, runs }
}
const base = (over = {}) => {
  const f = fakeSpawn()
  const reader = createReader({ spawn: f.spawn, script: 'C:/rq/read-aloud.ps1', clientScript: 'C:/tts/tts-client.ps1', exists: (p) => !String(p).endsWith('tts-muted.flag'), stateDir: 'C:/tmp/dsh-tts', powershell: 'ps.exe', ...over })
  return { ...f, reader }
}

test('speaks the chunks through one PowerShell process fed as JSON on stdin', () => {
  const { reader, runs } = base()
  const r = reader.speak(['One.', 'Two.'], { onEnd() {} })
  assert.deepEqual(r, { ok: true })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].exe, 'ps.exe')
  assert.ok(runs[0].args.includes('-File') && runs[0].args.includes('C:/rq/read-aloud.ps1'))
  assert.ok(runs[0].args.includes('C:/tts/tts-client.ps1'))
  assert.deepEqual(JSON.parse(runs[0].written.join('')), { chunks: ['One.', 'Two.'] })
  assert.equal(runs[0].opts.windowsHide, true)
})

test('muted voice, a missing script and nothing to say are refused without starting anything', () => {
  const muted = base({ exists: (p) => !String(p).endsWith('tts-muted.flag') ? true : true })
  assert.deepEqual(muted.reader.speak(['x'], {}), { ok: false, error: 'muted' })
  assert.equal(muted.runs.length, 0)
  const missing = base({ exists: (p) => String(p).endsWith('tts-muted.flag') ? false : !String(p).endsWith('tts-client.ps1') })
  assert.deepEqual(missing.reader.speak(['x'], {}), { ok: false, error: 'no-speaker' })
  const none = base({ exists: (p) => !String(p).endsWith('tts-muted.flag') })
  assert.deepEqual(none.reader.speak([], {}), { ok: false, error: 'nothing-to-read' })
  assert.equal(none.runs.length, 0)
})

test('onEnd fires once when the process exits, also for an error', async () => {
  const { reader, runs } = base({ exists: (p) => !String(p).endsWith('tts-muted.flag') })
  let ended = 0
  reader.speak(['x'], { onEnd: () => { ended++ } })
  runs[0].child.emit('exit', 0, null)
  runs[0].child.emit('error', new Error('late'))
  assert.equal(ended, 1)
  const again = base({ exists: (p) => !String(p).endsWith('tts-muted.flag') })
  let e2 = 0
  again.reader.speak(['x'], { onEnd: () => { e2++ } })
  again.runs[0].child.emit('error', new Error('spawn failed'))
  assert.equal(e2, 1)
})

test('stop kills the running process; a new read replaces the old one and the old onEnd does not clear the new', async () => {
  const { reader, runs } = base({ exists: (p) => !String(p).endsWith('tts-muted.flag') })
  const ends = []
  reader.speak(['a'], { onEnd: () => ends.push('first') })
  reader.speak(['b'], { onEnd: () => ends.push('second') })
  assert.equal(runs[0].child.killed, true)
  assert.equal(reader.active(), true)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(ends, ['first'])
  reader.stop()
  assert.equal(runs[1].child.killed, true)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(ends, ['first', 'second'])
  assert.equal(reader.active(), false)
  reader.stop() // nothing running: harmless
})

test('a spawn that throws is reported as an error, not thrown', () => {
  const reader = createReader({ spawn: () => { throw new Error('nope') }, script: 's', clientScript: 'c', exists: (p) => !String(p).endsWith('tts-muted.flag'), stateDir: 'd', powershell: 'p' })
  assert.deepEqual(reader.speak(['x'], {}), { ok: false, error: 'no-speaker' })
})
