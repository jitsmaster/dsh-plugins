// Slice 6 in the flow: stepped answers (permission approve / deny, question option / recommended / free text, multi-question).
// The queue says what happens next with "moves" (prepareReply -> { frozen, move }, replyStep -> move): ask (optionally with a line) ->
// REPLY_ASK, confirm -> REPLY_CONFIRM (strict yes sends), again, cancel, reject, end. Every path ends spoken or deliberately silent.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceFlow } from '../voice/flow.js'
import { classifyAnswer } from '../voice/answers.js'

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(setImmediate) }
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

const FROZEN = Object.freeze({ id: 'item-1', type: 'question', snapshotId: 'e:7', title: 'Pick a colour' })
const KINDS = ['reply', 'approve', 'deny', 'option', 'recommended', 'answer']

function harness({ queue = {}, ...over } = {}) {
  const h = { speaks: [], listens: [], logs: [], timers: [], matches: [], prepares: [], steps: [], sends: [], idles: 0, cancels: 0, decides: [] }
  let tid = 0, u = 0
  const fakeQueue = {
    match: (text) => { h.matches.push(text); const k = String(text).split(' ')[0]; return KINDS.includes(k) ? { kind: k } : undefined },
    run: async () => ({ outcome: 'ok' }),
    stop: () => {},
    prepareReply: async (intent) => { h.prepares.push(intent); return { ok: true, frozen: FROZEN, move: { kind: 'confirm', state: { n: 1 }, line: 'Confirm one. Yes?' } } },
    replyStep: async (frozen, state, input) => { h.steps.push([frozen, state, input]); return { kind: 'cancel' } },
    sendReply: async (frozen, text, state) => { h.sends.push([frozen, text, state]); return { outcome: 'sent', line: 'Task Pick a colour, answered. Two waiting.' } },
    ...queue,
  }
  const deps = {
    speak: (text, opts) => { const d = deferred(); h.speaks.push({ text, opts, ...d }); return d.promise },
    listen: (arg) => { const d = deferred(); h.listens.push({ arg, ...d }); return d.promise },
    decide: (utterance) => { const d = deferred(); h.decides.push({ utterance, ...d }); return d.promise },
    validate: (raw) => ({ ok: true, action: { ...raw } }),
    readBack: () => 'x', resultText: () => 'y', execute: async () => ({}),
    classify: classifyAnswer,
    cancelSpeech: () => { h.cancels++ },
    now: () => 1000,
    log: (stage, data) => { h.logs.push({ stage, data }) },
    setTimer: (fn, ms) => { const id = ++tid; h.timers.push({ id, fn, ms }); return id },
    clearTimer: (id) => { h.timers = h.timers.filter((t) => t.id !== id) },
    uuid: () => 'id' + ++u,
    onIdle: () => { h.idles++ },
    queue: fakeQueue,
    ...over,
  }
  h.flow = createVoiceFlow(deps)
  h.said = () => h.speaks.map((s) => s.text)
  h.state = () => h.flow.snapshot().state
  h.step = () => h.flow.snapshot().step
  h.capture = (text) => h.flow.handle({ type: 'transcript', revision: 1, text, context: null, source: 'hotkey', seconds: 1 })
  h.speakDone = async (status = 'done') => { h.speaks.at(-1).resolve({ status, ms: 50 }); await tick() }
  h.listenStarted = async () => { assert.ok(h.listens.length > 0, 'a listen was opened (spoke: ' + JSON.stringify(h.said()) + ')'); h.listens.at(-1).resolve({ started: true }); await tick() }
  h.ctx = () => h.listens.at(-1).arg.context
  h.answer = async (text) => { h.flow.handle({ type: 'transcript', revision: 1, text, context: h.ctx() }); await tick() }
  h.fire = async (ms) => { const t = h.timers.find((x) => x.ms === ms); assert.ok(t, 'a ' + ms + ' ms timer'); h.timers = h.timers.filter((x) => x !== t); t.fn(); await tick() }
  return h
}

const stage = (h, name) => h.logs.filter((l) => l.stage === name).map((l) => l.data)

test('S1 every answering intent goes to prepareReply, never to the echo / LLM path', async () => {
  for (const kind of KINDS) {
    const h = harness()
    h.capture(kind + ' now'); await tick()
    assert.deepEqual(h.prepares, [{ kind }], kind)
    assert.equal(h.decides.length, 0, kind)
  }
})

test('S2 a queue without prepareReply (an older object) leaves answer phrases to the echo path', async () => {
  const h = harness({ queue: { prepareReply: undefined } })
  h.capture('approve'); await tick()
  assert.deepEqual(h.said(), ['I heard: approve. Is that right?'])
})

test('S3 a confirm move: the line is spoken, then the confirm listen opens (step reply-confirm, window 30 s); active throughout', async () => {
  const h = harness()
  h.capture('approve'); await tick()
  assert.deepEqual(h.said(), ['Confirm one. Yes?'])
  assert.equal(h.state(), 'REPLY_CONFIRM_SPEAK')
  assert.equal(h.listens.length, 0)
  assert.ok(h.flow.active())
  await h.speakDone()
  assert.equal(h.listens.length, 1)
  assert.equal(h.listens[0].arg.context.step, 'reply-confirm')
  assert.equal(h.listens[0].arg.window_s, 30)
  assert.equal(h.state(), 'REPLY_CONFIRM_LISTEN')
})

test('S4 a strict yes sends the frozen item with the move state (no text), speaks the result line and ends', async () => {
  const h = harness()
  h.capture('approve'); await tick(); await h.speakDone(); await h.listenStarted()
  await h.answer('Yes.')
  assert.equal(h.sends.length, 1)
  assert.equal(h.sends[0][0], FROZEN)
  assert.equal(h.sends[0][1], undefined)
  assert.deepEqual(h.sends[0][2], { n: 1 })
  assert.equal(h.said().at(-1), 'Task Pick a colour, answered. Two waiting.')
  await h.speakDone()
  assert.equal(h.flow.active(), false)
  assert.equal(h.steps.length, 0, 'the yes is not a step')
  assert.deepEqual(stage(h, 'queue.reply').map((d) => d.step), ['prepare', 'send'])
})

test('S5 at the confirm step anything but a yes goes to replyStep with its kind and text; a cancel move says "Cancelled." and sends nothing', async () => {
  const h = harness()
  h.capture('approve'); await tick(); await h.speakDone(); await h.listenStarted()
  await h.answer('Wait, what?')
  assert.deepEqual(h.steps.map((s) => s[2]), [{ step: 'confirm', kind: 'text', text: 'Wait, what?' }])
  assert.deepEqual(h.steps[0][1], { n: 1 })
  assert.equal(h.said().at(-1), 'Cancelled.')
  assert.equal(h.sends.length, 0)
  await h.speakDone()
  assert.equal(h.flow.active(), false)
})

test('S5b "ok", "sure" and a bare "no" are not a yes: they reach replyStep as well', async () => {
  for (const [word, kind] of [['ok', 'text'], ['sure', 'text'], ['no', 'no']]) {
    const h = harness()
    h.capture('approve'); await tick(); await h.speakDone(); await h.listenStarted()
    await h.answer(word)
    assert.equal(h.sends.length, 0, word)
    assert.equal(h.steps[0][2].kind, kind, word)
  }
})

test('S6 an "again" move says "Please say it again." and listens at the confirm step with the state kept', async () => {
  const h = harness({ queue: { replyStep: async () => ({ kind: 'again' }) } })
  h.capture('approve'); await tick(); await h.speakDone(); await h.listenStarted()
  await h.answer('no')
  assert.equal(h.said().at(-1), 'Please say it again.')
  await h.speakDone()
  assert.equal(h.listens.at(-1).arg.context.step, 'reply-confirm')
  await h.listenStarted()
  await h.answer('yes')
  assert.deepEqual(h.sends[0][2], { n: 1 })
})

test('S7 a confirm move from a step replaces the line and the state (start over)', async () => {
  const h = harness({ queue: { replyStep: async () => ({ kind: 'confirm', state: { n: 2 }, line: 'Confirm two. Yes?' }) } })
  h.capture('approve'); await tick(); await h.speakDone(); await h.listenStarted()
  await h.answer('something else')
  assert.equal(h.said().at(-1), 'Confirm two. Yes?')
  await h.speakDone(); await h.listenStarted()
  await h.answer('yes')
  assert.deepEqual(h.sends[0][2], { n: 2 })
})

const ASK = { kind: 'ask', state: { answers: [] } }

test('S8 an ask move without a line opens the answer listen at once: nothing spoken (the STT beep is the cue)', async () => {
  const h = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: ASK }) } })
  h.capture('reply to the first item'); await tick()
  assert.deepEqual(h.said(), [])
  assert.equal(h.listens.length, 1)
  assert.equal(h.state(), 'REPLY_ASK')
  assert.equal(h.step(), 'reply-ask')
  assert.equal(h.listens[0].arg.context.step, 'reply-ask')
  assert.equal(h.listens[0].arg.window_s, 30)
  assert.ok(h.flow.active())
})

test('S9 an ask move with a line says it first, then listens', async () => {
  const h = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: { ...ASK, line: 'Question 2 of 2: Size?' } }) } })
  h.capture('option two'); await tick()
  assert.deepEqual(h.said(), ['Question 2 of 2: Size?'])
  assert.equal(h.listens.length, 0)
  await h.speakDone()
  assert.equal(h.listens[0].arg.context.step, 'reply-ask')
})

test('S10 what is said at the ask step goes to replyStep, raw, and the matcher never runs on it (yes, no and commands are just words)', async () => {
  const h = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: ASK }), replyStep: async (f, s, input) => { h.steps.push([f, s, input]); return { kind: 'confirm', state: { answers: [1] }, line: 'Answer: ok. Say yes.' } } } })
  h.capture('reply to the first item'); await tick()
  await h.listenStarted()
  await h.answer('show the task list')
  assert.deepEqual(h.matches, ['reply to the first item'])
  assert.deepEqual(h.steps.map((s) => s[2]), [{ step: 'ask', kind: 'text', text: 'show the task list' }])
  assert.deepEqual(h.steps[0][1], { answers: [] })
  for (const word of ['yes', 'no']) {
    const g = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: ASK }), replyStep: async (f, s, input) => { g.steps.push([f, s, input]); return { kind: 'cancel' } } } })
    g.capture('reply to the first item'); await tick(); await g.listenStarted()
    await g.answer(word)
    assert.equal(g.steps[0][2].text, word)
    assert.equal(g.sends.length, 0)
  }
})

test('S11 a multi-question walk: ask -> ask (next question read) -> confirm -> yes sends the final state', async () => {
  const h = harness({ queue: {
    prepareReply: async () => ({ ok: true, frozen: FROZEN, move: { kind: 'ask', state: { answers: ['a'] }, line: 'Question 2 of 2: Size?' } }),
    replyStep: async (f, s, input) => { h.steps.push([f, s, input]); return { kind: 'confirm', state: { answers: ['a', 'b'] }, line: 'Answer to Pick a colour: Colour option two, Size recommended. Say yes to send, or say it again to start over.' } },
  } })
  h.capture('option two'); await tick(); await h.speakDone(); await h.listenStarted()
  await h.answer('recommended')
  assert.deepEqual(h.steps[0][1], { answers: ['a'] })
  assert.equal(h.said().at(-1), 'Answer to Pick a colour: Colour option two, Size recommended. Say yes to send, or say it again to start over.')
  await h.speakDone(); await h.listenStarted()
  assert.equal(h.listens.at(-1).arg.context.step, 'reply-confirm')
  await h.answer('yes')
  assert.deepEqual(h.sends[0][2], { answers: ['a', 'b'] })
})

test('S12 an end move speaks its line and ends; without a line it ends in deliberate silence', async () => {
  const spoken = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: { kind: 'end', line: 'Nothing to do.', outcome: 'noop' } }) } })
  spoken.capture('approve'); await tick()
  assert.deepEqual(spoken.said(), ['Nothing to do.'])
  await spoken.speakDone()
  assert.equal(spoken.flow.active(), false)
  const silent = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: { kind: 'end' } }) } })
  silent.capture('approve'); await tick()
  assert.deepEqual(silent.said(), [])
  assert.equal(silent.flow.active(), false)
  assert.equal(silent.idles, 1)
})

test('S13 a reject move cancels with the dictation lines: too long / cannot repeat back safely', async () => {
  for (const [error, line] of [['too-long', 'That is too long to confirm by voice. Cancelled.'], ['invalid', 'I could not repeat that back safely. Cancelled.']]) {
    const h = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: ASK }), replyStep: async () => ({ kind: 'reject', error }) } })
    h.capture('reply to the first item'); await tick(); await h.listenStarted()
    await h.answer('whatever')
    assert.equal(h.said().at(-1), line, error)
    assert.equal(h.sends.length, 0)
  }
  const first = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: { kind: 'reject', error: 'too-long' } }) } })
  first.capture('answer ' + 'x'.repeat(10)); await tick()
  assert.equal(first.said().at(-1), 'That is too long to confirm by voice. Cancelled.')
})

test('S14 "cancel" or silence at an ask / confirm step ends cleanly; a silent window is "No answer. Cancelled."', async () => {
  const h = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: ASK }) } })
  h.capture('reply to the first item'); await tick(); await h.listenStarted()
  await h.answer('cancel')
  assert.equal(h.said().at(-1), 'Cancelled.')
  assert.equal(h.steps.length, 0)
  const q = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: ASK }) } })
  q.capture('reply to the first item'); await tick(); await q.listenStarted()
  await q.answer('   ')
  assert.equal(q.said().at(-1), 'No answer. Cancelled.')
  const g = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: ASK }) } })
  g.capture('reply to the first item'); await tick(); await g.listenStarted()
  await g.fire(140000)
  assert.equal(g.said().at(-1), 'No answer. Cancelled.')
})

test('S15 a replyStep that throws is spoken as a failure and logged as queue.error; nothing is sent', async () => {
  const h = harness({ queue: { replyStep: async () => { throw new Error('boom inside') } } })
  h.capture('approve'); await tick(); await h.speakDone(); await h.listenStarted()
  await h.answer('maybe')
  assert.equal(h.said().at(-1), 'That failed: boom inside.')
  assert.equal(h.sends.length, 0)
  assert.ok(stage(h, 'queue.error').some((d) => d.phase === 'reply' && /boom inside/.test(d.message)))
})

test('S16 a sendReply that throws or times out is spoken as a failure; a "changed" outcome says its line', async () => {
  const h = harness({ queue: { sendReply: async () => { throw new Error('capture broke') } } })
  h.capture('approve'); await tick(); await h.speakDone(); await h.listenStarted()
  await h.answer('yes')
  assert.equal(h.said().at(-1), 'That failed: capture broke.')
  const c = harness({ queue: { sendReply: async () => ({ outcome: 'changed', line: 'That item changed. Nothing done.' }) } })
  c.capture('approve'); await tick(); await c.speakDone(); await c.listenStarted()
  await c.answer('yes')
  assert.equal(c.said().at(-1), 'That item changed. Nothing done.')
  const t = harness({ queue: { sendReply: () => new Promise(() => {}) } })
  t.capture('approve'); await tick(); await t.speakDone(); await t.listenStarted()
  await t.answer('yes')
  await t.fire(35000)
  assert.equal(t.said().at(-1), 'That failed: timed out.')
})

test('S17 a prepareReply refusal speaks its line (wrong type, not approvable); a throwing queue never crashes the flow', async () => {
  const wrong = harness({ queue: { prepareReply: async () => ({ ok: false, outcome: 'wrong-type', line: 'The first item is a question. Say an option, or reply.' }) } })
  wrong.capture('approve'); await tick()
  assert.deepEqual(wrong.said(), ['The first item is a question. Say an option, or reply.'])
  assert.deepEqual(stage(wrong, 'queue.reply').map((d) => [d.step, d.outcome]), [['prepare', 'wrong-type']])
  const boom = harness({ queue: { prepareReply: async () => { throw new Error('snapshot is not available') } } })
  boom.capture('option two'); await tick()
  assert.equal(boom.said().at(-1), 'That failed: snapshot is not available.')
})

test('S18 an unknown move is a failure line, not a hang', async () => {
  const h = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: { kind: 'teleport' } }) } })
  h.capture('approve'); await tick()
  assert.match(h.said().at(-1), /^That failed: /)
  assert.equal(h.flow.active(), true, 'the failure line is still playing')
  await h.speakDone()
  assert.equal(h.flow.active(), false)
})

test('S19 the hotkey during an ask / confirm step cancels it: speech silenced, nothing sent, the new capture starts fresh', async () => {
  const h = harness()
  h.capture('approve'); await tick(); await h.speakDone(); await h.listenStarted()
  h.flow.handle({ type: 'listening', context: null })
  await tick()
  assert.equal(h.state(), 'IDLE')
  assert.equal(h.sends.length, 0)
  assert.ok(h.cancels >= 1)
})

test('S20 a stale listen result from an earlier step is ignored', async () => {
  const h = harness({ queue: { prepareReply: async () => ({ ok: true, frozen: FROZEN, move: ASK }), replyStep: async () => ({ kind: 'confirm', state: {}, line: 'Q?' }) } })
  h.capture('reply to the first item'); await tick(); await h.listenStarted()
  const oldCtx = h.ctx()
  await h.answer('first')
  await h.speakDone(); await h.listenStarted()
  h.flow.handle({ type: 'transcript', revision: 1, text: 'yes', context: oldCtx })
  await tick()
  assert.equal(h.sends.length, 0, 'the old ask-step context cannot answer the confirm step')
})

test('S21 log: prepare / ask / confirm / send steps with their outcome in the queue.reply stage', async () => {
  const h = harness({ queue: {
    prepareReply: async () => ({ ok: true, frozen: FROZEN, move: ASK }),
    replyStep: async () => ({ kind: 'confirm', state: {}, line: 'Q?' }),
  } })
  h.capture('reply to the first item'); await tick(); await h.listenStarted()
  await h.answer('purple'); await h.speakDone(); await h.listenStarted()
  await h.answer('yes')
  assert.deepEqual(stage(h, 'queue.reply').map((d) => [d.step, d.outcome]), [['prepare', 'ask'], ['ask', 'confirm'], ['send', 'sent']])
})
