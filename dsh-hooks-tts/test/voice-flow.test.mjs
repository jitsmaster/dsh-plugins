// Spec: docs/voice-two-stage-flow.md §1 (state machine, exact spoken lines), §2 (voice/flow.js API), §5 (pseudocode), §7 (F1–F32).
// Shapes chosen where the spec is open (implementer: follow these):
// - createVoiceFlow deps exactly as §2; every dep is a fake here (classify is injected, the real answers.js is not used).
// - The 500 ms retry wait after listen {started:false} (T10) uses the injected setTimer(fn, 500) (there is no sleep dep).
// - The answer guard is setTimer(fn, windowS*1000 + guardExtraMs) = 140000 ms by default (10 s + 130 s: above the STT max utterance of 120 s), armed after listen resolves
//   {started:true}; cleared via clearTimer(id) on answer/idle/error; 'transcribing' with the current context clears and re-arms it.
// - snapshot() exposes at least { state, id, turn, step } (state names as §1: IDLE, ECHO_SPEAK, ECHO_LISTEN, DECIDE, ...).
// - log(stage, data): tests only check the stage names 'stale', 'barge-in', 'speak-dead'.
// - Failure text (T24): "That failed: {msg}." where msg = first sentence of error.message WITHOUT its terminal
//   punctuation, cut to at most 80 chars.
// - speak status 'done' = success; 'failed' | 'timeout' = failure (T25: one retry of the same line, then silent IDLE).
// - The validated action is frozen with Object.freeze (same object passed to readBack and execute).
// - T7a "Please say it again." is spoken with the same voice opts, then listen reopens at the same step with a new turn.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceFlow } from '../voice/flow.js'

const VOICE = { priority: 'High', gender: 'female' }
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(setImmediate) }

function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

const CLASSES = { yes: 'yes', '是的': 'yes', stop: 'stop', cancel: 'stop', '取消': 'stop', '停': 'stop', no: 'no', '不': 'no' }
const fakeClassify = (t) => (t.trim() === '' ? 'empty' : CLASSES[t.trim().toLowerCase()] ?? 'text')

function harness(over = {}) {
  const h = { speaks: [], listens: [], decides: [], executes: [], logs: [], timers: [], validated: [], readBacks: [], results: [], cancels: 0 }
  let tid = 0, u = 0
  const deps = {
    speak: (text, opts) => { const d = deferred(); h.speaks.push({ text, opts, ...d }); return d.promise },
    listen: (arg) => { const d = deferred(); h.listens.push({ arg, ...d }); return d.promise },
    decide: (utterance, opts) => {
      const d = deferred()
      h.decides.push({ utterance, opts: { history: opts.history.map((e) => ({ ...e })) }, ...d })
      return d.promise
    },
    validate: (raw) => { h.validated.push(raw); return raw.invalid ?? { ok: true, action: { ...raw } } },
    readBack: (a) => { h.readBacks.push(a); return 'send to ' + a.title + ': ' + a.text },
    resultText: (a, r) => { h.results.push([a, r]); return r && r.stale ? 'That request changed. Nothing done.' : 'Sent to ' + a.title + '.' },
    execute: (a) => { const d = deferred(); h.executes.push({ action: a, ...d }); return d.promise },
    classify: fakeClassify,
    cancelSpeech: () => { h.cancels++ },
    now: () => 1000,
    log: (stage, data) => { h.logs.push({ stage, data }) },
    setTimer: (fn, ms) => { const id = ++tid; h.timers.push({ id, fn, ms }); return id },
    clearTimer: (id) => { h.timers = h.timers.filter((t) => t.id !== id) },
    uuid: () => 'id' + ++u,
    ...over,
  }
  h.flow = createVoiceFlow(deps)
  h.said = () => h.speaks.map((s) => s.text)
  h.lastSaid = () => h.speaks.at(-1)?.text
  h.ctx = () => h.listens.at(-1).arg.context
  h.state = () => h.flow.snapshot().state
  h.stages = () => h.logs.map((l) => l.stage)
  h.capture = (text, revision = 1) => h.flow.handle({ type: 'transcript', revision, text, context: null, source: 'hotkey', seconds: 1 })
  h.answer = (text, context = h.ctx(), revision = 1) => h.flow.handle({ type: 'transcript', revision, text, context })
  h.idle = (reason, context = h.ctx()) => h.flow.handle({ type: 'idle', reason, context })
  h.bargeIn = () => h.flow.handle({ type: 'listening', context: null })
  h.heldIdle = (reason = 'no_speech') => h.flow.handle({ type: 'idle', reason, context: null })
  h.speakDone = async (status = 'done') => { h.speaks.at(-1).resolve({ status, ms: 100 }); await tick() }
  h.listenStarted = async (started = true) => { h.listens.at(-1).resolve({ started }); await tick() }
  h.decideWith = async (r) => { h.decides.at(-1).resolve(r); await tick() }
  h.fire = async (ms) => {
    const t = h.timers.find((x) => x.ms === ms)
    assert.ok(t, 'an active ' + ms + ' ms timer')
    h.timers = h.timers.filter((x) => x !== t)
    t.fn()
    await tick()
  }
  return h
}

const PROMPT = { action: 'prompt', sessionId: 'a', title: 'Voice Work', text: 'fix the parser' }

async function toEchoListen(h, text = 'open the parser') {
  h.capture(text); await tick()
  await h.speakDone(); await h.listenStarted()
}
async function toDecide(h, text) {
  await toEchoListen(h, text)
  h.answer('yes'); await tick()
}
async function toDecisionListen(h, raw = PROMPT, text) {
  await toDecide(h, text)
  await h.decideWith({ ok: true, raw })
  await h.speakDone() // "Deciding with LLM."
  await h.speakDone() // read-back
  await h.listenStarted()
}
async function toClarifyListen(h, question = 'Which session, Voice Work or PR 6524?') {
  await toDecide(h)
  await h.decideWith({ ok: true, raw: { action: 'clarify', question } })
  await h.speakDone() // "Deciding with LLM."
  await h.speakDone() // question
  await h.listenStarted()
}
async function assertEnds(h, line) {
  assert.equal(h.lastSaid(), line)
  assert.equal(h.flow.active(), true, 'still active while the final line is spoken')
  const n = h.listens.length
  await h.speakDone()
  assert.equal(h.state(), 'IDLE')
  assert.equal(h.flow.active(), false)
  assert.equal(h.listens.length, n, 'no listen after the final line')
}

test('F1 echo is spoken before any decider call', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  assert.deepEqual(h.said(), ['I heard: open the parser. Is that right?'])
  assert.equal(h.decides.length, 0)
  assert.equal(h.listens.length, 0)
  assert.equal(h.state(), 'ECHO_SPEAK')
})

test('F2 listen is called only after the echo speak resolved', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  assert.equal(h.listens.length, 0)
  await h.speakDone()
  assert.equal(h.listens.length, 1)
  const { arg } = h.listens[0]
  assert.deepEqual(Object.keys(arg).sort(), ['context', 'window_s'])
  assert.equal(arg.window_s, 10)
  assert.equal(arg.context.flow, 'voice')
  assert.equal(arg.context.id, 'id1')
  assert.equal(arg.context.step, 'echo')
  assert.equal(typeof arg.context.turn, 'number')
  await h.listenStarted()
  assert.equal(h.state(), 'ECHO_LISTEN')
  assert.equal(h.flow.snapshot().step, 'echo')
})

test('F3 yes at echo speaks Deciding and starts decide in parallel; read-back waits for both', async () => {
  const h = harness()
  await toDecide(h)
  assert.equal(h.lastSaid(), 'Deciding with LLM.')
  assert.equal(h.decides.length, 1, 'decide started while the Deciding line is still playing')
  assert.equal(h.decides[0].utterance, 'open the parser')
  assert.deepEqual(h.decides[0].opts, { history: [] })
  assert.equal(h.state(), 'DECIDE')
  await h.decideWith({ ok: true, raw: PROMPT })
  assert.equal(h.speaks.length, 2, 'no read-back before the Deciding line ended')
  await h.speakDone()
  assert.equal(h.lastSaid(), 'I will send to Voice Work: fix the parser. Shall I do it?')
  assert.equal(h.state(), 'READBACK_SPEAK')
  await h.speakDone()
  assert.equal(h.ctx().step, 'decision')
  assert.equal(h.listens.at(-1).arg.window_s, 10)
})

test('F4 non-yes text at echo restarts at echo with the new text', async () => {
  const h = harness()
  await toEchoListen(h)
  const first = h.ctx()
  h.answer('send it to PR 5'); await tick()
  assert.equal(h.lastSaid(), 'I heard: send it to PR 5. Is that right?')
  assert.equal(h.decides.length, 0)
  await h.speakDone()
  assert.equal(h.ctx().step, 'echo')
  assert.equal(h.ctx().id, first.id)
  assert.ok(h.ctx().turn > first.turn)
  await h.listenStarted()
  h.answer('yes'); await tick()
  assert.equal(h.decides[0].utterance, 'send it to PR 5')
})

test('F5 non-yes text at decision restarts at echo with the new text and drops the action', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('send it to B instead'); await tick()
  assert.equal(h.lastSaid(), 'I heard: send it to B instead. Is that right?')
  assert.equal(h.executes.length, 0)
  await h.speakDone(); await h.listenStarted()
  assert.equal(h.ctx().step, 'echo')
  h.answer('yes'); await tick()
  assert.equal(h.decides.length, 2, 'a yes at the new echo decides again instead of executing the old action')
  assert.equal(h.decides[1].utterance, 'send it to B instead')
  assert.equal(h.executes.length, 0)
  const NEW = { action: 'prompt', sessionId: 'b', title: 'PR 6524', text: 'send it' }
  await h.decideWith({ ok: true, raw: NEW })
  await h.speakDone(); await h.speakDone(); await h.listenStarted()
  h.answer('yes'); await tick()
  assert.deepEqual(h.executes[0].action, NEW)
})

test('F6 yes at decision executes exactly the read-back action', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  assert.equal(h.executes.length, 1)
  assert.equal(h.state(), 'EXECUTE')
  const action = h.executes[0].action
  assert.equal(action, h.readBacks[0], 'same object that was read back')
  assert.ok(Object.isFrozen(action))
  assert.deepEqual(action, PROMPT)
  const result = { requestId: 'voice-1' }
  h.executes[0].resolve(result); await tick()
  assert.equal(h.results[0][0], action)
  assert.equal(h.results[0][1], result)
  await assertEnds(h, 'Sent to Voice Work.')
})

for (const word of ['stop', '取消']) {
  test('F7 stop/cancel at echo aborts with Cancelled. (' + word + ')', async () => {
    const h = harness()
    await toEchoListen(h)
    h.answer(word); await tick()
    assert.equal(h.decides.length, 0)
    await assertEnds(h, 'Cancelled.')
  })
}

for (const word of ['cancel', '停']) {
  test('F8 stop/cancel at decision aborts with Cancelled. (' + word + ')', async () => {
    const h = harness()
    await toDecisionListen(h)
    h.answer(word); await tick()
    assert.equal(h.executes.length, 0)
    await assertEnds(h, 'Cancelled.')
  })
}

for (const word of ['stop', '取消']) {
  test('F9 stop/cancel at clarify aborts with Cancelled. (' + word + ')', async () => {
    const h = harness()
    await toClarifyListen(h)
    h.answer(word); await tick()
    assert.equal(h.decides.length, 1)
    await assertEnds(h, 'Cancelled.')
  })
}

test('F10 stop (and yes) at capture is echoed like any utterance', async () => {
  const h = harness()
  h.capture('stop'); await tick()
  assert.deepEqual(h.said(), ['I heard: stop. Is that right?'])
  const h2 = harness()
  h2.capture('yes'); await tick()
  assert.deepEqual(h2.said(), ['I heard: yes. Is that right?'])
  assert.equal(h2.decides.length, 0)
})

test('F11 every line uses gender female and priority High', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  h.executes[0].resolve({}); await tick()
  await h.speakDone()
  const h2 = harness()
  h2.capture('  '); await tick()
  const all = [...h.speaks, ...h2.speaks]
  assert.equal(all.length, 5)
  for (const s of all) assert.deepEqual(s.opts, VOICE, s.text)
})

test('F12 stale-turn transcript is ignored', async () => {
  const h = harness()
  await toEchoListen(h)
  const old = h.ctx()
  h.answer('send it to B'); await tick()
  await h.speakDone(); await h.listenStarted()
  const pick = ({ state, id, turn, step }) => ({ state, id, turn, step })
  const before = pick(h.flow.snapshot())
  const spoken = h.speaks.length
  h.answer('yes', old); await tick()
  assert.equal(h.decides.length, 0)
  assert.equal(h.speaks.length, spoken)
  assert.deepEqual(pick(h.flow.snapshot()), before)
  assert.ok(h.stages().includes('stale'))
  h.answer('yes'); await tick()
  assert.equal(h.decides.length, 1, 'the current context is still consumed')
})

test('F13 decide result after barge-in is ignored', async () => {
  const h = harness()
  await toDecide(h)
  h.bargeIn(); await tick()
  assert.ok(h.stages().includes('barge-in'))
  assert.equal(h.flow.active(), false)
  await h.decideWith({ ok: true, raw: PROMPT })
  await h.speakDone() // the old "Deciding" line ends
  assert.equal(h.speaks.length, 2, 'no read-back after barge-in')
  assert.equal(h.validated.length, 0)
  assert.equal(h.listens.length, 1)
  assert.ok(h.stages().includes('stale'))
})

test('F14 hotkey barge-in (listening ctx null) aborts; next capture restarts at echo', async () => {
  const h = harness()
  await toEchoListen(h)
  const old = h.ctx()
  h.bargeIn(); await tick()
  assert.ok(h.stages().includes('barge-in'))
  assert.equal(h.speaks.length, 1, 'barge-in speaks nothing')
  assert.equal(h.flow.active(), false)
  h.answer('yes', old); await tick()
  assert.equal(h.decides.length, 0, 'answer for the aborted listen is stale')
  h.capture('second thing'); await tick()
  assert.equal(h.lastSaid(), 'I heard: second thing. Is that right?')
  await h.speakDone()
  assert.equal(h.ctx().id, 'id2')
  assert.equal(h.ctx().step, 'echo')
})

test('F15 barge-in mid-speech: no listen', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  h.bargeIn(); await tick()
  await h.speakDone()
  assert.equal(h.listens.length, 0)
  assert.equal(h.speaks.length, 1)
  assert.equal(h.flow.active(), false)
})

test('F16 empty capture says I did not catch that.', async () => {
  for (const text of ['', '   ']) {
    const h = harness()
    h.capture(text); await tick()
    assert.deepEqual(h.said(), ['I did not catch that.'])
    await assertEnds(h, 'I did not catch that.')
    assert.equal(h.listens.length, 0)
  }
})

for (const reason of ['no_speech', 'too_short', 'cancelled']) {
  test('F17 idle ' + reason + ' while listening ends with No answer. Cancelled.', async () => {
    const h = harness()
    await toEchoListen(h)
    h.idle(reason); await tick()
    await assertEnds(h, 'No answer. Cancelled.')
  })
}

test('F17b empty answer at a listen ends with No answer. Cancelled.', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('  '); await tick()
  assert.equal(h.executes.length, 0)
  await assertEnds(h, 'No answer. Cancelled.')
})

test('F18 guard timeout ends with No answer. Cancelled.; transcribing re-arms it; an answer clears it', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  await h.speakDone()
  assert.equal(h.timers.filter((t) => t.ms === 140000).length, 0, 'guard armed only after listen started')
  await h.listenStarted()
  const guards = h.timers.filter((t) => t.ms === 140000)
  assert.equal(guards.length, 1)
  h.flow.handle({ type: 'transcribing', context: h.ctx() }); await tick()
  const rearmed = h.timers.filter((t) => t.ms === 140000)
  assert.equal(rearmed.length, 1)
  assert.notEqual(rearmed[0].id, guards[0].id)
  await h.fire(140000)
  await assertEnds(h, 'No answer. Cancelled.')

  const h2 = harness()
  await toEchoListen(h2)
  h2.answer('yes'); await tick()
  assert.equal(h2.timers.filter((t) => t.ms === 140000).length, 0, 'answer clears the guard')
})

test('F19 idle error or error event ends with Speech recognition failed. Cancelled.', async () => {
  const h = harness()
  await toEchoListen(h)
  h.idle('error'); await tick()
  await assertEnds(h, 'Speech recognition failed. Cancelled.')
  const h2 = harness()
  await toDecisionListen(h2)
  h2.flow.handle({ type: 'error', message: 'decoder crashed', context: h2.ctx() }); await tick()
  await assertEnds(h2, 'Speech recognition failed. Cancelled.')
})

test('F20 listen started:false twice (retry once after 500 ms) ends with The microphone is busy. Cancelled.', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  await h.speakDone()
  await h.listenStarted(false)
  assert.equal(h.listens.length, 1, 'waits before retrying')
  await h.fire(500)
  assert.equal(h.listens.length, 2)
  assert.deepEqual(h.listens[1].arg, h.listens[0].arg)
  await h.listenStarted(false)
  assert.equal(h.listens.length, 2, 'retries only once')
  await assertEnds(h, 'The microphone is busy. Cancelled.')
})

test('F21 listen rejects ends with Speech service unavailable. Cancelled.', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  await h.speakDone()
  h.listens[0].reject(new Error('connect ECONNREFUSED 127.0.0.1:8765')); await tick()
  await assertEnds(h, 'Speech service unavailable. Cancelled.')
})

for (const [error, line] of [
  ['timeout', 'The LLM did not answer in time. Cancelled.'],
  ['llm', 'The LLM is not available. Cancelled.'],
  ['unparseable', "I could not understand the LLM's answer. Cancelled."],
]) {
  test('F22 decide error ' + error + ' waits for the Deciding line then says: ' + line, async () => {
    const h = harness()
    await toDecide(h)
    await h.decideWith({ ok: false, error })
    assert.equal(h.speaks.length, 2, 'nothing spoken over the Deciding line')
    await h.speakDone()
    assert.equal(h.validated.length, 0)
    await assertEnds(h, line)
  })
}

for (const [invalid, line] of [
  [{ ok: false, error: 'no-session' }, 'No session is known. Cancelled.'],
  [{ ok: false, error: 'no-approval', title: 'PR 6524' }, 'PR 6524 has no pending permission request. Cancelled.'],
  [{ ok: false, error: 'invalid' }, "I could not understand the LLM's answer. Cancelled."],
  [{ ok: false, error: 'not-approvable', title: 'PR 6524' }, 'That request is too long or unclear to approve by voice. Answer it on screen.'],
]) {
  test('F23 validate ' + invalid.error + ' says: ' + line, async () => {
    const h = harness()
    await toDecide(h)
    const raw = { action: 'approve', invalid }
    await h.decideWith({ ok: true, raw })
    await h.speakDone()
    assert.equal(h.validated[0], raw)
    await assertEnds(h, line)
  })
}

test('F24 a third clarify ends with I could not work out what to do. Cancelled.', async () => {
  const h = harness()
  await toClarifyListen(h, 'Which session?')
  h.answer('the second'); await tick()
  await h.speakDone(); await h.listenStarted()
  h.answer('yes'); await tick()
  await h.decideWith({ ok: true, raw: { action: 'clarify', question: 'Send or switch?' } })
  await h.speakDone()
  assert.equal(h.lastSaid(), 'Send or switch?', 'second clarify is still asked')
  await h.speakDone(); await h.listenStarted()
  h.answer('send'); await tick()
  await h.speakDone(); await h.listenStarted()
  h.answer('yes'); await tick()
  await h.decideWith({ ok: true, raw: { action: 'clarify', question: 'Really?' } })
  await h.speakDone()
  assert.ok(!h.said().includes('Really?'))
  await assertEnds(h, 'I could not work out what to do. Cancelled.')
})

for (const [message, line] of [
  ['controller offline', 'That failed: controller offline.'],
  ['Session not found. More details follow here.', 'That failed: Session not found.'],
  ['x'.repeat(120), 'That failed: ' + 'x'.repeat(80) + '.'],
]) {
  test('F25 execute throws says: ' + line.slice(0, 40), async () => {
    const h = harness()
    await toDecisionListen(h)
    h.answer('yes'); await tick()
    h.executes[0].reject(new Error(message)); await tick()
    await assertEnds(h, line)
  })
}

test('F25b stale approval token says That request changed. Nothing done.', async () => {
  const h = harness()
  const APPROVE = { action: 'approve', sessionId: 'b', title: 'PR 6524', toolName: 'pwsh', token: { t: 1 } }
  await toDecisionListen(h, APPROVE)
  h.answer('yes'); await tick()
  assert.equal(h.executes[0].action.token, APPROVE.token)
  h.executes[0].resolve({ stale: true }); await tick()
  assert.deepEqual(h.results[0][1], { stale: true })
  await assertEnds(h, 'That request changed. Nothing done.')
})

test('F26 listen started:false then true on retry proceeds', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  await h.speakDone()
  await h.listenStarted(false)
  await h.fire(500)
  await h.listenStarted(true)
  assert.equal(h.state(), 'ECHO_LISTEN')
  assert.equal(h.speaks.length, 1, 'no end line')
  h.answer('yes'); await tick()
  assert.equal(h.decides.length, 1)
})

test('F27 clarify question is spoken, its answer is echoed, and history reaches decide', async () => {
  const h = harness()
  await toDecide(h)
  await h.decideWith({ ok: true, raw: { action: 'clarify', question: 'Which session, Voice Work or PR 6524?' } })
  await h.speakDone()
  assert.equal(h.lastSaid(), 'Which session, Voice Work or PR 6524?')
  assert.equal(h.state(), 'CLARIFY_SPEAK')
  await h.speakDone()
  assert.equal(h.ctx().step, 'clarify')
  await h.listenStarted()
  h.answer('PR 6524'); await tick()
  assert.equal(h.lastSaid(), 'I heard: PR 6524. Is that right?')
  await h.speakDone(); await h.listenStarted()
  h.answer('yes'); await tick()
  assert.equal(h.decides.length, 2)
  assert.equal(h.decides[1].utterance, 'PR 6524')
  assert.deepEqual(h.decides[1].opts, {
    history: [{ utterance: 'open the parser', question: 'Which session, Voice Work or PR 6524?' }],
  })
})

test('F28 active() true from capture until the final line ends', async () => {
  const h = harness()
  assert.equal(h.flow.active(), false)
  h.capture('open the parser'); await tick()
  assert.equal(h.flow.active(), true)
  await h.speakDone(); assert.equal(h.flow.active(), true)
  await h.listenStarted(); assert.equal(h.flow.active(), true)
  h.answer('yes'); await tick(); assert.equal(h.flow.active(), true)
  await h.decideWith({ ok: true, raw: PROMPT }); await h.speakDone(); assert.equal(h.flow.active(), true)
  await h.speakDone(); await h.listenStarted()
  h.answer('yes'); await tick(); assert.equal(h.flow.active(), true)
  h.executes[0].resolve({}); await tick()
  await assertEnds(h, 'Sent to Voice Work.')
})

test('T26 abort() goes idle without speech and drops pending awaits', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  h.flow.abort('disabled')
  assert.equal(h.flow.active(), false)
  await h.speakDone()
  assert.equal(h.listens.length, 0)
  assert.equal(h.speaks.length, 1)
})

test('F29 revision 2 transcripts are ignored', async () => {
  const h = harness()
  h.capture('open the parser', 2); await tick()
  assert.equal(h.speaks.length, 0)
  assert.equal(h.flow.active(), false)
  await toEchoListen(h)
  h.answer('yes', h.ctx(), 2); await tick()
  assert.equal(h.decides.length, 0)
  assert.equal(h.state(), 'ECHO_LISTEN')
})

test('F30 speak failure retries once then goes idle with speak-dead log', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  await h.speakDone('failed')
  assert.deepEqual(h.said(), ['I heard: open the parser. Is that right?', 'I heard: open the parser. Is that right?'])
  assert.deepEqual(h.speaks[1].opts, VOICE)
  await h.speakDone('timeout')
  assert.equal(h.speaks.length, 2, 'no third attempt and no spoken error')
  assert.equal(h.listens.length, 0)
  assert.equal(h.flow.active(), false)
  assert.ok(h.stages().includes('speak-dead'))

  const h2 = harness()
  h2.capture('open the parser'); await tick()
  await h2.speakDone('failed')
  await h2.speakDone('done')
  assert.equal(h2.listens.length, 1, 'a successful retry proceeds to listen')
  assert.ok(!h2.stages().includes('speak-dead'))
})

test('F31 bare no at echo says Please say it again. and relistens the echo step with the utterance unchanged', async () => {
  const h = harness()
  await toEchoListen(h)
  const old = h.ctx()
  h.answer('no'); await tick()
  assert.equal(h.lastSaid(), 'Please say it again.')
  assert.equal(h.listens.length, 1, 'listen only after the line ended')
  await h.speakDone()
  assert.equal(h.listens.length, 2)
  assert.equal(h.ctx().step, 'echo')
  assert.equal(h.ctx().id, old.id)
  assert.ok(h.ctx().turn > old.turn)
  assert.equal(h.listens[1].arg.window_s, 10)
  await h.listenStarted()
  assert.equal(h.state(), 'ECHO_LISTEN')
  h.answer('yes'); await tick()
  assert.equal(h.decides[0].utterance, 'open the parser')
})

test('F31 bare no at decision says Please say it again. and relistens the decision step with the action unchanged', async () => {
  const h = harness()
  await toDecisionListen(h)
  const old = h.ctx()
  h.answer('不'); await tick()
  assert.equal(h.lastSaid(), 'Please say it again.')
  assert.equal(h.executes.length, 0)
  await h.speakDone()
  assert.equal(h.ctx().step, 'decision')
  assert.ok(h.ctx().turn > old.turn)
  await h.listenStarted()
  assert.equal(h.state(), 'READBACK_LISTEN')
  h.answer('yes', old); await tick()
  assert.equal(h.executes.length, 0, 'the pre-no context is stale')
  h.answer('yes'); await tick()
  assert.equal(h.executes.length, 1)
  assert.equal(h.executes[0].action, h.readBacks[0])
  assert.equal(h.decides.length, 1, 'no new decide')
})

test('F33 speak.start logs playback latency: echo from the capture transcript, other lines from when they were sent', async () => {
  let t = 1000
  const h = harness({ now: () => t })
  h.capture('open the parser'); await tick()
  t = 1900
  h.speaks.at(-1).resolve({ status: 'done', ms: 1500, startMs: 650 }); await tick()
  const echoStart = h.logs.filter((l) => l.stage === 'speak.start')
  assert.equal(echoStart.length, 1)
  assert.equal(echoStart[0].data.step, 'echo')
  assert.equal(echoStart[0].data.latMs, 650, 'echo latency = playback start - capture transcript time')
  await h.listenStarted()
  t = 5000
  h.answer('yes'); await tick()
  t = 6000
  h.speaks.at(-1).resolve({ status: 'done', ms: 900, startMs: 300 }); await tick()
  const starts = h.logs.filter((l) => l.stage === 'speak.start')
  assert.equal(starts.length, 2)
  assert.equal(starts[1].data.latMs, 300, 'Deciding latency = playback start - when it was sent')
})

test('F33 no speak.start is logged when the result carries no startMs', async () => {
  const h = harness()
  await toEchoListen(h)
  assert.equal(h.stages().includes('speak.start'), false)
})

test('F34 a capture during EXECUTE still speaks the result line first, then echoes the new utterance', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  h.bargeIn(); await tick()
  h.capture('second thing'); await tick()
  assert.equal(h.state(), 'EXECUTE', 'the started execute is not abandoned')
  const n = h.speaks.length
  h.executes[0].resolve({}); await tick()
  assert.equal(h.speaks.length, n + 1)
  assert.equal(h.lastSaid(), 'Sent to Voice Work.')
  await h.speakDone()
  assert.equal(h.lastSaid(), 'I heard: second thing. Is that right?')
  assert.equal(h.state(), 'ECHO_SPEAK')
  await h.speakDone()
  assert.equal(h.ctx().id, 'id2')
  assert.equal(h.ctx().step, 'echo')
})

test('F34 execute finishing while the barge-in mic is still open holds the result line until the capture arrives', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  h.bargeIn(); await tick()
  const n = h.speaks.length
  h.executes[0].resolve({}); await tick()
  assert.equal(h.speaks.length, n, 'nothing is spoken into the open mic')
  assert.equal(h.state(), 'EXECUTE')
  assert.equal(h.flow.active(), true)
  assert.equal(h.cancels, 0, 'the hold does not cancel speech: no line is queued')
  h.capture('second thing'); await tick()
  assert.equal(h.speaks.length, n + 1)
  assert.equal(h.lastSaid(), 'Sent to Voice Work.', 'the result line is spoken first')
  assert.equal(h.state(), 'END_SPEAK')
  await h.speakDone()
  assert.equal(h.lastSaid(), 'I heard: second thing. Is that right?')
  assert.equal(h.state(), 'ECHO_SPEAK')
  await h.speakDone()
  assert.equal(h.ctx().id, 'id2')
  assert.equal(h.ctx().step, 'echo')
})

test('F34 a held capture that ends without speech (idle) still gets the result line spoken, then goes idle', async () => {
  for (const reason of ['no_speech', 'too_short', 'cancelled', 'done']) {
    const h = harness()
    await toDecisionListen(h)
    h.answer('yes'); await tick()
    h.bargeIn(); await tick()
    const before = h.speaks.length
    h.executes[0].resolve({}); await tick()
    const n = h.speaks.length
    assert.equal(n, before, 'held while the mic is open')
    h.heldIdle(reason); await tick()
    assert.equal(h.speaks.length, n + 1, reason)
    await assertEnds(h, 'Sent to Voice Work.')
  }
})

test('F34 a held capture with an empty transcript still gets the result line, then I did not catch that.', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  h.bargeIn(); await tick()
  h.executes[0].resolve({}); await tick()
  h.capture('   '); await tick()
  assert.equal(h.lastSaid(), 'Sent to Voice Work.')
  await h.speakDone()
  await assertEnds(h, 'I did not catch that.')
})

test('F34 an STT listen error during the hold also releases the result line', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  h.bargeIn(); await tick()
  h.executes[0].reject(new Error('controller offline')); await tick()
  h.flow.handle({ type: 'error', message: 'decoder crashed', context: null }); await tick()
  await assertEnds(h, 'That failed: controller offline.')
})

test('F34 a listen end that never arrives cannot swallow the result line: the answer-guard time releases it', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  h.bargeIn(); await tick()
  const before = h.speaks.length
  h.executes[0].resolve({}); await tick()
  assert.equal(h.speaks.length, before, 'held while the mic is open')
  await h.fire(140000)
  await assertEnds(h, 'Sent to Voice Work.')
})

test('F34 the hold timer does not outlive the hold, and a result spoken in time leaves it unarmed', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  h.bargeIn(); await tick()
  h.executes[0].resolve({}); await tick()
  h.capture('second thing'); await tick()
  assert.equal(h.timers.filter((t) => t.ms === 140000).length, 0)
})

test('F34 abort() while the result line waits for the held capture speaks nothing', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  h.bargeIn(); await tick()
  h.executes[0].resolve({}); await tick()
  const n = h.speaks.length
  h.flow.abort('disabled'); await tick()
  assert.equal(h.flow.active(), false)
  h.capture('second thing'); await tick()
  assert.equal(h.speaks.length, n + 1, 'only the fresh capture is echoed; the dropped result line is never spoken')
  assert.equal(h.lastSaid(), 'I heard: second thing. Is that right?')
})

test('F34 a bare barge-in during EXECUTE still speaks the result line (once the mic window ended), then goes idle', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  h.bargeIn(); await tick()
  h.executes[0].reject(new Error('controller offline')); await tick()
  h.heldIdle('no_speech'); await tick()
  await assertEnds(h, 'That failed: controller offline.')
})

test('F34 abort() during EXECUTE drops the result line and any held capture', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  h.capture('second thing'); await tick()
  h.flow.abort('disabled')
  const n = h.speaks.length
  h.executes[0].resolve({}); await tick()
  assert.equal(h.speaks.length, n)
  assert.equal(h.flow.active(), false)
})

// --- cancelSpeech: a barge-in/abort silences the speak worker (finding: stale lines played into the open mic).
test('F36 barge-in cancels queued and in-flight speech once, whichever line is being spoken', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  assert.equal(h.cancels, 0, 'nothing is cancelled when the flow starts')
  h.bargeIn(); await tick()
  assert.equal(h.cancels, 1)
  const h2 = harness()
  await toDecide(h2)
  h2.bargeIn(); await tick()
  assert.equal(h2.cancels, 1, 'the Deciding line is cut as well')
  const h3 = harness()
  await toDecisionListen(h3)
  h3.bargeIn(); await tick()
  assert.equal(h3.cancels, 1)
})

test('F36 a barge-in with no flow running cancels nothing; abort() cancels only an active flow', async () => {
  const h = harness()
  h.bargeIn(); await tick()
  assert.equal(h.cancels, 0)
  h.flow.abort('disabled')
  assert.equal(h.cancels, 0, 'abort of an idle flow touches nothing')
  h.capture('open the parser'); await tick()
  h.flow.abort('session closed')
  assert.equal(h.cancels, 1)
  assert.equal(h.flow.active(), false)
})

test('F36 the capture that follows a barge-in speaks a fresh echo and does not cancel it', async () => {
  const h = harness()
  await toEchoListen(h)
  h.bargeIn(); await tick()
  assert.equal(h.cancels, 1)
  h.capture('second thing'); await tick()
  assert.equal(h.cancels, 1, 'the recapture of an idle flow cancels nothing')
  assert.equal(h.lastSaid(), 'I heard: second thing. Is that right?')
})

test('F36 a capture that replaces a running turn without a barge-in event cancels that turn', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  h.capture('second thing'); await tick()
  assert.equal(h.cancels, 1)
  assert.equal(h.lastSaid(), 'I heard: second thing. Is that right?')
})

test('F36 a throwing cancelSpeech never breaks the flow', async () => {
  const h = harness({ cancelSpeech: () => { throw new Error('boom') } })
  h.capture('open the parser'); await tick()
  assert.doesNotThrow(() => h.bargeIn())
  assert.equal(h.flow.active(), false)
  h.capture('again'); await tick()
  assert.equal(h.lastSaid(), 'I heard: again. Is that right?')
})

test('F36 the flow works without a cancelSpeech dep', async () => {
  const h = harness({ cancelSpeech: undefined })
  h.capture('open the parser'); await tick()
  assert.doesNotThrow(() => h.bargeIn())
  assert.equal(h.flow.active(), false)
  h.capture('again'); await tick()
  assert.equal(h.lastSaid(), 'I heard: again. Is that right?')
})

test('F37 a speak that resolves cancelled is a silent stop: no retry, no speak-dead, no listen', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  await h.speakDone('cancelled')
  assert.equal(h.speaks.length, 1, 'no retry of a cancelled line')
  assert.equal(h.listens.length, 0)
  assert.equal(h.flow.active(), false)
  assert.ok(!h.stages().includes('speak-dead'))
})

test('F37 cancelled at the Deciding line and at a final line also end silently', async () => {
  const h = harness()
  await toDecide(h)
  await h.decideWith({ ok: true, raw: PROMPT })
  await h.speakDone('cancelled')
  assert.equal(h.speaks.length, 2, 'no read-back, no retry')
  assert.equal(h.flow.active(), false)
  assert.ok(!h.stages().includes('speak-dead'))
  const g = harness()
  g.capture('  '); await tick()
  await g.speakDone('cancelled')
  assert.equal(g.speaks.length, 1)
  assert.equal(g.flow.active(), false)
  assert.ok(!g.stages().includes('speak-dead'))
})

test('F35 listen.open logs ms since the listen POST; decide.end logs the model and raw cut to 300 chars', async () => {
  let t = 1000
  const h = harness({ now: () => t })
  h.capture('open the parser'); await tick()
  t = 2000
  await h.speakDone()
  t = 2350
  await h.listenStarted()
  h.flow.handle({ type: 'listening', context: h.ctx() }); await tick()
  const open = h.logs.find((l) => l.stage === 'listen.open')
  assert.equal(open.data.ms, 350)
  h.answer('yes'); await tick()
  const raw = { ...PROMPT, text: 'x'.repeat(400) }
  await h.decideWith({ ok: true, raw, model: 'claude-haiku-4-5' })
  await h.speakDone() // decide.end is logged once the "Deciding" line has ended too
  const end = h.logs.find((l) => l.stage === 'decide.end')
  assert.equal(end.data.model, 'claude-haiku-4-5')
  assert.equal(typeof end.data.raw, 'string')
  assert.equal(end.data.raw.length, 300)
  assert.equal(end.data.raw, JSON.stringify(raw).slice(0, 300))
})

test('F32 bare no at clarify is echoed as the answer', async () => {
  const h = harness()
  await toClarifyListen(h, 'Do you mean Voice Work?')
  h.answer('no'); await tick()
  assert.equal(h.lastSaid(), 'I heard: no. Is that right?')
  await h.speakDone()
  assert.equal(h.ctx().step, 'echo')
})

// --- Item 3: a line cut short (Ctrl+Alt+M) at echo/read-back was not fully heard: no mic, no execution.
test('F36 a cut echo line says Cancelled. and ends: no mic opens, nothing is decided', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  await h.speakDone('cut')
  assert.equal(h.listens.length, 0, 'the mic must not open after a half-heard echo')
  assert.equal(h.lastSaid(), 'Cancelled.')
  assert.equal(h.flow.active(), true, 'still active while the final line is spoken')
  await h.speakDone()
  assert.equal(h.state(), 'IDLE')
  assert.equal(h.listens.length, 0)
  assert.equal(h.decides.length, 0)
})

test('F36 a cut read-back line says Cancelled. and ends: no mic, no execution, even after a later yes', async () => {
  const h = harness()
  await toDecide(h)
  await h.decideWith({ ok: true, raw: PROMPT })
  await h.speakDone() // Deciding
  const n = h.listens.length
  await h.speakDone('cut') // read-back, cut
  assert.equal(h.listens.length, n, 'the mic must not open after a half-heard read-back')
  assert.equal(h.lastSaid(), 'Cancelled.')
  await h.speakDone()
  assert.equal(h.state(), 'IDLE')
  h.answer('yes', { flow: 'voice', id: 'id1', turn: 1, step: 'decision' }); await tick()
  assert.equal(h.executes.length, 0)
})

test('F36 a cut line is not retried (it would be spoken a second time)', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  const sent = h.speaks.length
  await h.speakDone('cut')
  assert.deepEqual(h.said().slice(sent), ['Cancelled.'])
})

test('F36 a cut Deciding line, clarify question, result line or end line behaves as before', async () => {
  const d = harness()
  await toDecide(d)
  await d.decideWith({ ok: true, raw: PROMPT })
  await d.speakDone('cut') // Deciding line cut: the flow goes on to the read-back
  assert.match(d.lastSaid(), /^I will send to Voice Work: fix the parser/)
  await d.speakDone(); await d.listenStarted()
  assert.equal(d.ctx().step, 'decision')

  const c = harness()
  await toDecide(c)
  await c.decideWith({ ok: true, raw: { action: 'clarify', question: 'Which one?' } })
  await c.speakDone(); await c.speakDone('cut') // the question is cut: the clarify listen still opens
  assert.equal(c.ctx().step, 'clarify')

  const r = harness()
  await toDecisionListen(r)
  r.answer('yes'); await tick()
  r.executes[0].resolve({}); await tick()
  await r.speakDone('cut') // result line cut
  assert.equal(r.state(), 'IDLE')
  assert.equal(r.flow.active(), false)

  const e = harness()
  e.capture('  '); await tick()
  await e.speakDone('cut')
  assert.equal(e.state(), 'IDLE')
})

// --- Item 5: the read-back step asks for the strict confirmation set.
test('F37 classify is told the step: echo at the echo step, decision at the read-back, clarify at clarify', async () => {
  const steps = []
  const h = harness({ classify: (text, step) => { steps.push(step); return fakeClassify(text) } })
  await toEchoListen(h)
  h.answer('yes'); await tick()
  await h.decideWith({ ok: true, raw: PROMPT })
  await h.speakDone(); await h.speakDone(); await h.listenStarted()
  h.answer('yes'); await tick()
  assert.deepEqual(steps, ['echo', 'decision'])
  const c = harness({ classify: (text, step) => { steps.push('c:' + step); return fakeClassify(text) } })
  await toClarifyListen(c)
  c.answer('which'); await tick()
  assert.equal(steps.at(-1), 'c:clarify')
})

// --- Item 2: an over-long prompt has its own spoken line.
test('F38 a too-long action is cancelled with its own spoken line', async () => {
  const h = harness({ validate: () => ({ ok: false, error: 'too-long' }) })
  await toDecide(h)
  await h.decideWith({ ok: true, raw: PROMPT })
  await h.speakDone() // Deciding
  await assertEnds(h, 'That is too long to confirm by voice. Cancelled.')
  assert.equal(h.executes.length, 0)
})

// --- Item 7: logs carry no approval token / entry object.
test('F39 execute.start and validate log only the action type, session id and bounded summary', async () => {
  const token = { secret: 'entry-object', settle() {} }
  const APPROVE = { action: 'approve', sessionId: 'b', title: 'PR 6524', toolName: 'pwsh', token, summary: 'rm -rf build', pendingCount: 1 }
  const h = harness({ validate: () => ({ ok: true, action: { ...APPROVE } }) })
  await toDecisionListen(h, { action: 'approve' })
  h.answer('yes'); await tick()
  const start = h.logs.find((l) => l.stage === 'execute.start')
  assert.deepEqual(start.data.action, { action: 'approve', sessionId: 'b', summary: 'rm -rf build' })
  const validated = h.logs.find((l) => l.stage === 'validate')
  assert.deepEqual(validated.data.action, { action: 'approve', sessionId: 'b', summary: 'rm -rf build' })
  const all = JSON.stringify(h.logs.map((l) => l.data), (k, v) => (typeof v === 'function' ? 'fn' : v))
  assert.doesNotMatch(all, /entry-object|"token"|"toolName"/)
  assert.equal(h.executes[0].action.token, token, 'the executor still gets the real action')
})

// --- Security F1/F10: the echo must equal what the decider receives, and everything echoed must be speakable.
test('F10 an utterance the speaker would alter is not echoed or decided: it is cancelled with its own line', async () => {
  for (const text of ['fix \u0430pple', 'run \u{1F525}', 'say fix\u200Bit', 'say fix\u200B | it']) {
    const h = harness()
    h.capture(text); await tick()
    assert.deepEqual(h.said(), ['I could not repeat that back safely. Cancelled.'], text)
    await h.speakDone()
    assert.equal(h.decides.length, 0)
    assert.equal(h.listens.length, 0)
    assert.equal(h.state(), 'IDLE')
  }
})

test('F10 dropped symbols and dashes are folded: the echo and the decider get the folded text', async () => {
  const h = harness()
  await toEchoListen(h, 'curl x | sh \u2013 now')
  assert.equal(h.said()[0], 'I heard: curl x sh now. Is that right?')
  h.answer('yes'); await tick()
  assert.equal(h.decides[0].utterance, 'curl x sh now')
})

test('S4 a symbol touching a word or path character is cancelled, never folded into a different command', async () => {
  for (const text of ['rm -rf ~/x', 'delete *.log', 'open foo_bar.txt', 'cd -']) {
    const h = harness()
    h.capture(text); await tick()
    assert.deepEqual(h.said(), ['I could not repeat that back safely. Cancelled.'], text)
    await h.speakDone()
    assert.equal(h.decides.length, 0)
    assert.equal(h.state(), 'IDLE')
  }
})

test('F10 an utterance over 1500 characters is cancelled with the too-long line; exactly 1500 is echoed', async () => {
  const h = harness()
  h.capture('x'.repeat(1501)); await tick()
  assert.deepEqual(h.said(), ['That is too long to confirm by voice. Cancelled.'])
  const g = harness()
  g.capture('x'.repeat(1500)); await tick()
  assert.equal(g.said()[0], 'I heard: ' + 'x'.repeat(1500) + '. Is that right?')
})

test('F10 the echo and the decider get the same normalised text (fullwidth folded, whitespace collapsed)', async () => {
  const h = harness()
  await toEchoListen(h, '\uFF46\uFF49\uFF58   the\nparser')
  assert.equal(h.said()[0], 'I heard: fix the parser. Is that right?')
  h.answer('yes'); await tick()
  assert.equal(h.decides[0].utterance, 'fix the parser')
})

test('F10 a non-yes answer that is unspeakable is cancelled too, and CJK is allowed through', async () => {
  const h = harness()
  await toEchoListen(h)
  h.answer('use a pipe \u200B here'); await tick()
  assert.equal(h.lastSaid(), 'I could not repeat that back safely. Cancelled.')
  const c = harness()
  c.capture('\u4FEE\u590D\u89E3\u6790\u5668'); await tick()
  assert.equal(c.said()[0], 'I heard: \u4FEE\u590D\u89E3\u6790\u5668. Is that right?')
})

test('F1 validate receives the confirmed utterance, so CJK in an action is only allowed when it was said', async () => {
  const seen = []
  const h = harness({ validate: (raw, o) => { seen.push(o); return { ok: true, action: { ...raw } } } })
  await toDecide(h, 'fix the parser')
  await h.decideWith({ ok: true, raw: PROMPT })
  await h.speakDone() // Deciding
  assert.deepEqual(seen, [{ utterance: 'fix the parser' }])
})

// --- Regression R3: a line the worker answers 'muted' (tts-muted.flag at request time) ends the turn silently.
test('R3 a muted line is a silent stop: logged, no retry, no listen, no speak-dead', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  await h.speakDone('muted')
  assert.equal(h.speaks.length, 1, 'no retry of a muted line')
  assert.equal(h.listens.length, 0)
  assert.equal(h.flow.active(), false)
  assert.ok(h.stages().includes('speak-muted'))
  assert.ok(!h.stages().includes('speak-dead'))
})

test('R3 muted at the Deciding line and at a final line also end silently', async () => {
  const h = harness()
  await toDecide(h)
  await h.decideWith({ ok: true, raw: PROMPT })
  await h.speakDone('muted')
  assert.equal(h.speaks.length, 2, 'no read-back, no retry')
  assert.equal(h.flow.active(), false)
  assert.ok(!h.stages().includes('speak-dead'))
  const g = harness()
  g.capture('  '); await tick()
  await g.speakDone('muted')
  assert.equal(g.speaks.length, 1)
  assert.equal(g.flow.active(), false)
})

test('R3 a line cut by the mute toggle does not speak Cancelled. aloud: the Cancelled. line comes back muted and the flow goes idle', async () => {
  const h = harness()
  h.capture('open the parser'); await tick()
  await h.speakDone('cut') // Ctrl+Alt+M cut the echo
  assert.equal(h.lastSaid(), 'Cancelled.')
  await h.speakDone('muted') // the worker refuses to speak while muted
  assert.equal(h.speaks.length, 2, 'Cancelled. is not retried')
  assert.equal(h.state(), 'IDLE')
  assert.equal(h.flow.active(), false)
  assert.equal(h.listens.length, 0)
  assert.ok(!h.stages().includes('speak-dead'))
})

// --- Regression R5: execute() has a timeout (35 s, injectable): a hung call must not leave EXECUTE forever.
test('R5 a hung execute times out after 35 s: That failed: timed out. is spoken and the flow goes idle', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  assert.equal(h.state(), 'EXECUTE')
  const n = h.speaks.length
  await h.fire(35_000)
  assert.equal(h.speaks.length, n + 1)
  assert.equal(h.lastSaid(), 'That failed: timed out.')
  assert.equal(h.flow.active(), true, 'still active while the line is spoken')
  await h.speakDone()
  assert.equal(h.state(), 'IDLE')
  assert.equal(h.flow.active(), false)
  h.executes[0].resolve({ late: true }); await tick()
  assert.equal(h.speaks.length, n + 1, 'a late result is dropped')
})

test('R5 the execute timeout is injectable, and does not outlive an execute that finished in time', async () => {
  const h = harness({ executeTimeoutMs: 1234 })
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  assert.ok(h.timers.some((t) => t.ms === 1234))
  h.executes[0].resolve({}); await tick()
  assert.ok(!h.timers.some((t) => t.ms === 1234), 'the timer is cleared once execute settled')
  assert.equal(h.lastSaid(), 'Sent to Voice Work.')
})

test('R5 a capture held during a hung execute is released after the timeout line and starts the next conversation', async () => {
  const h = harness()
  await toDecisionListen(h)
  h.answer('yes'); await tick()
  h.bargeIn(); await tick()
  h.capture('second thing'); await tick()
  await h.fire(35_000)
  assert.equal(h.lastSaid(), 'That failed: timed out.')
  await h.speakDone()
  assert.equal(h.lastSaid(), 'I heard: second thing. Is that right?')
  assert.equal(h.state(), 'ECHO_SPEAK')
})


test('O6 decide() gets an AbortSignal that a barge-in aborts', async () => {
  let seen
  const h = harness({ decide: (utterance, opts) => { seen = opts.signal; return new Promise(() => {}) } })
  await toDecide(h)
  assert.ok(seen && typeof seen.aborted === 'boolean', 'a signal was passed')
  assert.equal(seen.aborted, false)
  h.bargeIn()
  assert.equal(seen.aborted, true)
})

test('O6 abort() aborts the pending decide signal, and a finished decide leaves the next turn a fresh signal', async () => {
  const seen = []
  const h = harness({ decide: (utterance, opts) => { seen.push(opts.signal); return new Promise(() => {}) } })
  await toDecide(h)
  h.flow.abort('stop')
  assert.equal(seen[0].aborted, true)
  await toDecide(h)
  assert.equal(seen[1].aborted, false)
  assert.notEqual(seen[1], seen[0])
})
