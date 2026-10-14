// The "Deciding with LLM." line is replaced by a singing-bowl sound: an optional flow dep chime() -> Promise<{status}> that
// runs next to decide(). It is best-effort: a failed, muted, cut or missing chime never ends or aborts the flow; the flow still
// waits for both the decision and the chime attempt before it reads the action back.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceFlow } from '../voice/flow.js'

const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(setImmediate) }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const PROMPT = { action: 'prompt', sessionId: 'a', title: 'Voice Work', text: 'fix the parser' }
const CLASSES = { yes: 'yes', stop: 'stop' }

function harness(over = {}) {
  const h = { speaks: [], listens: [], decides: [], chimes: [], logs: [], cancels: 0 }
  const deps = {
    speak: (text, opts) => { const d = deferred(); h.speaks.push({ text, opts, ...d }); return d.promise },
    listen: (arg) => { const d = deferred(); h.listens.push({ arg, ...d }); return d.promise },
    decide: () => { const d = deferred(); h.decides.push(d); return d.promise },
    validate: (raw) => ({ ok: true, action: { ...raw } }),
    readBack: (a) => 'send to ' + a.title,
    resultText: () => 'Sent.',
    execute: async () => ({}),
    classify: (t) => CLASSES[t.trim().toLowerCase()] ?? 'text',
    chime: () => { const d = deferred(); h.chimes.push(d); return d.promise },
    cancelSpeech: () => { h.cancels++ },
    log: (stage, data) => { h.logs.push({ stage, data }) },
    setTimer: () => 1, clearTimer: () => {}, uuid: () => 'id1',
    ...over,
  }
  h.flow = createVoiceFlow(deps)
  h.said = () => h.speaks.map((s) => s.text)
  h.stages = () => h.logs.map((l) => l.stage)
  h.state = () => h.flow.snapshot().state
  h.speakDone = async (status = 'done') => { h.speaks.at(-1).resolve({ status, ms: 100 }); await tick() }
  h.toDecide = async () => {
    h.flow.handle({ type: 'transcript', revision: 1, text: 'open the parser', context: null }); await tick()
    await h.speakDone(); h.listens.at(-1).resolve({ started: true }); await tick()
    h.flow.handle({ type: 'transcript', revision: 1, text: 'yes', context: h.listens.at(-1).arg.context }); await tick()
  }
  return h
}

test('C1 yes at the echo plays the chime and decides in parallel; no spoken "Deciding with LLM." line', async () => {
  const h = harness()
  await h.toDecide()
  assert.equal(h.state(), 'DECIDE')
  assert.equal(h.chimes.length, 1, 'the chime is requested once')
  assert.equal(h.decides.length, 1, 'decide started at once, next to the chime')
  assert.deepEqual(h.said(), ['I heard: open the parser. Is that right?'], 'nothing is spoken while the decision runs')
  assert.ok(!h.said().includes('Deciding with LLM.'))
})

test('C2 the read-back waits for BOTH the decision and the chime, whichever ends first', async () => {
  const a = harness()
  await a.toDecide()
  a.decides[0].resolve({ ok: true, raw: PROMPT }); await tick()
  assert.equal(a.speaks.length, 1, 'decision done, chime still ringing: no read-back yet')
  a.chimes[0].resolve({ status: 'done', ms: 1700 }); await tick()
  assert.equal(a.said().at(-1), 'I will send to Voice Work. Shall I do it?')

  const b = harness()
  await b.toDecide()
  b.chimes[0].resolve({ status: 'done', ms: 1700 }); await tick()
  assert.equal(b.speaks.length, 1, 'chime done, decision still running: no read-back yet')
  b.decides[0].resolve({ ok: true, raw: PROMPT }); await tick()
  assert.equal(b.said().at(-1), 'I will send to Voice Work. Shall I do it?')
})

test('C3 a chime that fails, times out, is muted, cut or cancelled counts as done: the decision still flows', async () => {
  for (const status of ['failed', 'timeout', 'muted', 'cut', 'cancelled', 'skipped', undefined]) {
    const h = harness({ chime: async () => (status === undefined ? undefined : { status }) })
    await h.toDecide()
    h.decides[0].resolve({ ok: true, raw: PROMPT }); await tick()
    assert.equal(h.said().at(-1), 'I will send to Voice Work. Shall I do it?', 'chime status ' + status)
    assert.ok(h.flow.active())
    assert.ok(!h.stages().includes('speak-dead') && !h.stages().includes('speak-muted'), 'chime status ' + status)
  }
})

test('C4 a chime that throws or rejects never aborts the flow and is logged', async () => {
  for (const chime of [() => { throw new Error('no player') }, () => Promise.reject(new Error('no player'))]) {
    const h = harness({ chime })
    await h.toDecide()
    h.decides[0].resolve({ ok: true, raw: PROMPT }); await tick()
    assert.equal(h.said().at(-1), 'I will send to Voice Work. Shall I do it?')
    assert.ok(h.stages().includes('chime.error'))
  }
})

test('C5 a failed chime is not retried (a second bowl would be noise)', async () => {
  let calls = 0
  const h = harness({ chime: async () => { calls++; return { status: 'failed' } } })
  await h.toDecide()
  h.decides[0].resolve({ ok: true, raw: PROMPT }); await tick()
  assert.equal(calls, 1)
})

test('C6 no chime dep (decideChime off): the step is silent, and the decision still flows', async () => {
  const h = harness({ chime: undefined })
  await h.toDecide()
  assert.deepEqual(h.said(), ['I heard: open the parser. Is that right?'])
  h.decides[0].resolve({ ok: true, raw: PROMPT }); await tick()
  assert.equal(h.said().at(-1), 'I will send to Voice Work. Shall I do it?')
})

test('C7 decision errors and clarify questions still flow with a chime (a failed decision speaks its error line after the chime)', async () => {
  const h = harness()
  await h.toDecide()
  h.decides[0].resolve({ ok: false, error: 'timeout' }); await tick()
  assert.equal(h.speaks.length, 1, 'waits for the chime too')
  h.chimes[0].resolve({ status: 'done' }); await tick()
  assert.equal(h.said().at(-1), 'The LLM did not answer in time. Cancelled.')
  const c = harness()
  await c.toDecide()
  c.chimes[0].resolve({ status: 'muted' }); c.decides[0].resolve({ ok: true, raw: { action: 'clarify', question: 'Which one?' } }); await tick()
  assert.equal(c.said().at(-1), 'Which one?')
})

test('C8 a barge-in while the bowl rings silences speech, aborts the decision and drops the late chime', async () => {
  const h = harness()
  await h.toDecide()
  h.flow.handle({ type: 'listening', context: null }); await tick()
  assert.equal(h.cancels, 1, 'cancelSpeech also cuts the bowl')
  assert.equal(h.flow.active(), false)
  h.chimes[0].resolve({ status: 'cancelled' }); h.decides[0].resolve({ ok: true, raw: PROMPT }); await tick()
  assert.equal(h.speaks.length, 1, 'the late decision speaks nothing')
})

test('C9 the chime is logged with its status', async () => {
  const h = harness()
  await h.toDecide()
  h.chimes[0].resolve({ status: 'muted', ms: 5 }); await tick()
  const end = h.logs.find((l) => l.stage === 'chime.end')
  assert.equal(end.data.status, 'muted')
  assert.ok(h.stages().includes('chime.sent'))
})
