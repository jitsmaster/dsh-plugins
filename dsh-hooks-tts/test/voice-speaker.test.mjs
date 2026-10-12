import assert from 'node:assert/strict'
import test from 'node:test'
import { createSpeaker } from '../voice/speaker.js'

function fakeSpawn() {
  const calls = []
  const written = []
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { stdin: { end: (s) => written.push(s) }, unref() { this.unrefd = true }, on() {} }
  }
  return { spawn, calls, written }
}

test('speaks the text as a headline JSON on stdin of stop-speak.ps1', () => {
  const f = fakeSpawn()
  createSpeaker({ spawn: f.spawn, root: 'R', env: { A: '1' } })('Hello there')
  assert.equal(f.calls[0].cmd, 'powershell.exe')
  assert.ok(f.calls[0].args.some((a) => /stop-speak\.ps1$/.test(a)))
  assert.deepEqual(JSON.parse(f.written[0]), { headline: 'Hello there' })
})

test('the child is NOT detached: a detached powershell exits in ~250 ms without speaking on Windows', () => {
  const f = fakeSpawn()
  createSpeaker({ spawn: f.spawn, root: 'R', env: {} })('x')
  assert.notEqual(f.calls[0].opts.detached, true)
  assert.equal(f.calls[0].opts.windowsHide, true)
})

test('a failing spawn is reported, not thrown', () => {
  const errors = []
  const speak = createSpeaker({ spawn: () => { throw new Error('nope') }, root: 'R', env: {}, onError: (e) => errors.push(String(e)) })
  assert.doesNotThrow(() => speak('x'))
  assert.match(errors[0], /nope/)
})
