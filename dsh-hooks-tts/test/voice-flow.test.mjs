// Spec: docs/voice-two-stage-flow.md §1 (state machine, exact spoken lines), §2 (voice/flow.js API), §5 (pseudocode), §7 (F1–F32).
// Shapes chosen where the spec is open (implementer: follow these):
// - createVoiceFlow deps exactly as §2; every dep is a fake here (classify is injected, the real answers.js is not used).
// - The 500 ms retry wait after listen {started:false} (T10) uses the injected setTimer(fn, 500) (there is no sleep dep).
// - The answer guard is setTimer(fn, windowS*1000 + guardExtraMs) = 25000 ms by default, armed after listen resolves
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
  const h = { speaks: [], listens: [], decides: [], executes: [], logs: [], timers: [], validated: [], readBacks: [], results: [] }
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
  assert.equal(h.timers.filter((t) => t.ms === 25000).length, 0, 'guard armed only after listen started')
  await h.listenStarted()
  const guards = h.timers.filter((t) => t.ms === 25000)
  assert.equal(guards.length, 1)
  h.flow.handle({ type: 'transcribing', context: h.ctx() }); await tick()
  const rearmed = h.timers.filter((t) => t.ms === 25000)
  assert.equal(rearmed.length, 1)
  assert.notEqual(rearmed[0].id, guards[0].id)
  await h.fire(25000)
  await assertEnds(h, 'No answer. Cancelled.')

  const h2 = harness()
  await toEchoListen(h2)
  h2.answer('yes'); await tick()
  assert.equal(h2.timers.filter((t) => t.ms === 25000).length, 0, 'answer clears the guard')
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

test('F32 bare no at clarify is echoed as the answer', async () => {
  const h = harness()
  await toClarifyListen(h, 'Do you mean Voice Work?')
  h.answer('no'); await tick()
  assert.equal(h.lastSaid(), 'I heard: no. Is that right?')
  await h.speakDone()
  assert.equal(h.ctx().step, 'echo')
})
