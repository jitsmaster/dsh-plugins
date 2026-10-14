// The answer guard and the EXECUTE hold timer must never give up before the STT daemon does: its max_utterance_s is 120 s
// (the STT project's config.example.toml) plus transcription time. window_s sent to STT (10 s) only bounds how long it waits for
// speech to BEGIN; the plugin's total is windowS*1000 + guardExtraMs = 10 s + 130 s = 140 s.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ANSWER_GUARD_EXTRA_MS, createVoiceFlow } from '../voice/flow.js'

const STT_MAX_UTTERANCE_MS = 120_000
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(setImmediate) }

/** A flow on a fake clock: advance(ms) fires every timer that falls due, in order. Speaks and listens resolve at once. */
function harness() {
  const h = { spoken: [], logs: [], listens: [], timers: [], clock: 0, executes: [] }
  let tid = 0
  h.flow = createVoiceFlow({
    speak: async (text) => { h.spoken.push(text); return { status: 'done', ms: 1 } },
    listen: async (arg) => { h.listens.push(arg); return { started: true } },
    decide: async () => ({ ok: true, raw: { action: 'prompt', sessionId: 'a', title: 'Voice Work', text: 'fix the parser' } }),
    validate: (raw) => ({ ok: true, action: { ...raw } }),
    readBack: () => 'send it',
    resultText: () => 'Sent.',
    execute: () => new Promise((resolve) => { h.executes.push(resolve) }),
    classify: (t) => (t.trim() === 'yes' ? 'yes' : 'text'),
    log: (stage) => { h.logs.push(stage) },
    setTimer: (fn, ms) => { const id = ++tid; h.timers.push({ id, fn, due: h.clock + ms, ms }); return id },
    clearTimer: (id) => { h.timers = h.timers.filter((t) => t.id !== id) },
    uuid: () => 'id1',
  })
  h.ctx = () => h.listens.at(-1).context
  h.advance = async (ms) => {
    const to = h.clock + ms
    for (;;) {
      const next = h.timers.filter((t) => t.due <= to).sort((a, b) => a.due - b.due)[0]
      if (!next) break
      h.clock = next.due
      h.timers = h.timers.filter((t) => t !== next)
      next.fn(); await tick()
    }
    h.clock = to
    await tick()
  }
  return h
}

test('G1 the guard total is 140 s and stays above the STT max utterance of 120 s', () => {
  assert.equal(10_000 + ANSWER_GUARD_EXTRA_MS, 140_000)
  assert.ok(10_000 + ANSWER_GUARD_EXTRA_MS > STT_MAX_UTTERANCE_MS)
})

test('G2 window_s sent to STT stays 10 s: only the wait for speech to begin', async () => {
  const h = harness()
  h.flow.handle({ type: 'transcript', revision: 1, text: 'open the parser', context: null }); await tick()
  assert.equal(h.listens[0].window_s, 10)
})

test('G3 the answer guard does not fire at 25 s or 120 s, but does at 140 s', async () => {
  const h = harness()
  h.flow.handle({ type: 'transcript', revision: 1, text: 'open the parser', context: null }); await tick()
  assert.equal(h.flow.snapshot().state, 'ECHO_LISTEN')
  const spoken = h.spoken.length
  await h.advance(25_000)
  assert.equal(h.flow.snapshot().state, 'ECHO_LISTEN', 'still listening at 25 s')
  await h.advance(95_000)
  assert.equal(h.flow.snapshot().state, 'ECHO_LISTEN', 'still listening at 120 s')
  assert.equal(h.spoken.length, spoken)
  assert.ok(!h.logs.includes('guard'))
  await h.advance(20_000)
  assert.ok(h.logs.includes('guard'), 'the guard fires at 140 s')
  assert.equal(h.spoken.at(-1), 'No answer. Cancelled.')
})

test('G4 a transcribing event re-arms the guard for a full 140 s', async () => {
  const h = harness()
  h.flow.handle({ type: 'transcript', revision: 1, text: 'open the parser', context: null }); await tick()
  await h.advance(119_000)
  h.flow.handle({ type: 'transcribing', context: h.ctx() }); await tick()
  await h.advance(139_000)
  assert.ok(!h.logs.includes('guard'), 'the decode of a long answer gets its own window')
  await h.advance(1_000)
  assert.ok(h.logs.includes('guard'))
})

test('G5 the EXECUTE hold timer does not fire at 25 s or 120 s, but does at 140 s', async () => {
  const h = harness()
  h.flow.handle({ type: 'transcript', revision: 1, text: 'open the parser', context: null }); await tick()
  const ask = (text) => h.flow.handle({ type: 'transcript', revision: 1, text, context: h.ctx() })
  ask('yes'); await tick(8) // decide -> read-back -> decision listen
  ask('yes'); await tick() // EXECUTE starts
  assert.equal(h.flow.snapshot().state, 'EXECUTE')
  h.flow.handle({ type: 'listening', context: null }); await tick() // a barge-in mic opens and its end never arrives
  h.executes[0]({}); await tick()
  const spoken = h.spoken.length
  await h.advance(25_000)
  assert.equal(h.spoken.length, spoken, 'held at 25 s')
  await h.advance(95_000)
  assert.equal(h.spoken.length, spoken, 'held at 120 s')
  assert.ok(!h.logs.includes('hold.timeout'))
  await h.advance(20_000)
  assert.ok(h.logs.includes('hold.timeout'), 'released at 140 s')
  assert.equal(h.spoken.at(-1), 'Sent.')
})
