// voice/service.js builds the flow's chime dep: the bowl WAV played through the speaker (same worker, queue, mute flag and
// barge-in cancel as every spoken line), only when the decideChime setting is on and the file exists. Never throws.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceService } from '../voice/service.js'

function make(extra = {}) {
  const spoken = []
  const seen = { deps: undefined }
  const svc = createVoiceService({
    enabled: () => true, readSecret: () => 's', WebSocketImpl: class { close() {} }, setTimer: () => 1, clearTimer: () => {},
    controller: {}, runSlash: async () => {},
    speaker: { speak: async (text, opts) => { spoken.push([text, opts]); return { status: 'done', ms: 5 } }, warm() {}, stop() {}, cancel() {} },
    createFlow: (deps) => { seen.deps = deps; return { handle() {}, active: () => false, abort() {}, snapshot: () => ({ state: 'IDLE' }) } },
    ...extra,
  })
  return { svc, spoken, seen }
}

test('CS1 the flow gets a chime that plays the bowl WAV through the speaker in the flow voice, with a non-empty placeholder text', async () => {
  const h = make({ chimeFile: '/assets/bowl.wav', decideChime: () => true, fileExists: () => true })
  assert.equal(typeof h.seen.deps.chime, 'function')
  const r = await h.seen.deps.chime()
  assert.equal(r.status, 'done')
  assert.equal(h.spoken.length, 1)
  const [text, opts] = h.spoken[0]
  assert.ok(text.trim().length > 0, 'the worker needs some text; the WAV is played instead of it')
  assert.deepEqual(opts, { gender: 'female', priority: 'High', file: '/assets/bowl.wav' })
})

test('CS2 decideChime false: nothing is played (silent step), read live on every call', async () => {
  let on = false
  const h = make({ chimeFile: '/a/bowl.wav', decideChime: () => on, fileExists: () => true })
  assert.deepEqual(await h.seen.deps.chime(), { status: 'skipped' })
  assert.equal(h.spoken.length, 0)
  on = true
  assert.equal((await h.seen.deps.chime()).status, 'done')
  assert.equal(h.spoken.length, 1)
})

test('CS3 a missing bowl file is skipped (the worker would speak the placeholder text instead)', async () => {
  const h = make({ chimeFile: '/a/bowl.wav', decideChime: () => true, fileExists: () => false })
  assert.deepEqual(await h.seen.deps.chime(), { status: 'skipped' })
  assert.equal(h.spoken.length, 0)
})

test('CS4 a throwing speaker, decideChime or fileExists makes the chime fail quietly (status failed) instead of throwing', async () => {
  const bad = make({ chimeFile: '/a/bowl.wav', decideChime: () => true, fileExists: () => true,
    speaker: { speak: async () => { throw new Error('no player') }, warm() {}, stop() {}, cancel() {} } })
  assert.equal((await bad.seen.deps.chime()).status, 'failed')
  const b2 = make({ chimeFile: '/a/bowl.wav', decideChime: () => { throw new Error('settings') }, fileExists: () => true })
  assert.equal((await b2.seen.deps.chime()).status, 'failed')
  const b3 = make({ chimeFile: '/a/bowl.wav', decideChime: () => true, fileExists: () => { throw new Error('fs') } })
  assert.equal((await b3.seen.deps.chime()).status, 'failed')
})

test('CS5 the muted / cut / cancelled status of the speaker is passed through for the flow to ignore', async () => {
  for (const status of ['muted', 'cut', 'cancelled']) {
    const h = make({ chimeFile: '/a/bowl.wav', decideChime: () => true, fileExists: () => true,
      speaker: { speak: async () => ({ status, ms: 1 }), warm() {}, stop() {}, cancel() {} } })
    assert.equal((await h.seen.deps.chime()).status, status)
  }
})

test('CS6 by default the bowl is the plugin assets/bowl.wav (found relative to the module, no absolute path)', async () => {
  const h = make({ decideChime: () => true })
  await h.seen.deps.chime()
  assert.match(h.spoken[0][1].file.replace(/\\/g, '/'), /\/assets\/bowl\.wav$/)
})
