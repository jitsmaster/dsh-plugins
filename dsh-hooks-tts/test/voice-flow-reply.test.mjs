// Slice 5 of dsh-review-queue/docs/voice-task-list.md: "reply to the first item" by voice. REPLY_DICTATE (listen window, no echo,
// the queue-command matcher never runs on the dictated text) -> REPLY_CONFIRM (read-back; strict yes sends, "cancel" aborts,
// any other speech replaces the whole text) -> the send, which ends with a spoken line. Every path ends spoken or deliberately silent.
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

const FROZEN = Object.freeze({ id: 'item-1', type: 'completed', snapshotId: 'e:7', title: 'Fix parser' })
const READBACK = (frozen, text) => 'Send to ' + frozen.title + ': ' + text + '. Say yes to send, or say the prompt again to replace it.'

/** A flow with a fake task-list queue that supports the reply intent; every collaborator can be overridden. */
function harness({ queue = {}, ...over } = {}) {
  const h = { speaks: [], listens: [], decides: [], logs: [], timers: [], matches: [], prepares: [], sends: [], readBacks: [], stops: 0, cancels: 0, idles: 0 }
  let tid = 0, u = 0
  const fakeQueue = {
    match: (text) => { h.matches.push(text); return /^reply to the first item/i.test(text) ? { kind: 'reply', n: 1 } : /^show the task list/i.test(text) ? { kind: 'show' } : undefined },
    run: async (intent) => ({ outcome: 'ok', line: 'Done ' + intent.kind + '.' }),
    stop: () => { h.stops++ },
    prepareReply: async (intent) => { h.prepares.push(intent); return { ok: true, frozen: FROZEN } },
    replyReadBack: (frozen, text) => { h.readBacks.push([frozen, text]); return READBACK(frozen, text) },
    sendReply: async (frozen, text) => { h.sends.push([frozen, text]); return { outcome: 'sent', line: 'Task Fix parser, reply sent. Two waiting.' } },
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
  h.idle = async (reason) => { h.flow.handle({ type: 'idle', reason, context: h.ctx() }); await tick() }
  h.fire = async (ms) => { const t = h.timers.find((x) => x.ms === ms); assert.ok(t, 'a ' + ms + ' ms timer'); h.timers = h.timers.filter((x) => x !== t); t.fn(); await tick() }
  /** "reply to the first item" -> the dictation listen is open. */
  h.toDictate = async () => { h.capture('reply to the first item'); await tick(); await h.listenStarted() }
  /** ... -> a dictation was heard -> the read-back is spoken and the confirm listen is open. */
  h.toConfirm = async (text = 'add tests') => {
    await h.toDictate(); await h.answer(text); await h.speakDone(); await h.listenStarted()
  }
  return h
}

const TOO_LONG = 'That is too long to confirm by voice. Cancelled.'

test('R1 "reply to the first item" prepares the reply and opens the dictation listen: no echo, no spoken line, no LLM', async () => {
  const h = harness()
  h.capture('Reply to the first item.'); await tick()
  assert.deepEqual(h.prepares, [{ kind: 'reply', n: 1 }])
  assert.deepEqual(h.said(), [], 'nothing is said before the dictation window (the STT start beep is the cue)')
  assert.equal(h.decides.length, 0)
  assert.equal(h.listens.length, 1)
  assert.equal(h.state(), 'REPLY_DICTATE')
  assert.equal(h.step(), 'reply-dictate')
  assert.equal(h.listens[0].arg.window_s, 30)
  assert.equal(h.listens[0].arg.context.flow, 'voice')
  assert.equal(h.listens[0].arg.context.step, 'reply-dictate')
  assert.ok(h.flow.active(), 'held alerts wait while the dictation is open')
})

test('R2 the dictated text never reaches the queue-command matcher, even when it is a command phrase', async () => {
  const h = harness()
  await h.toDictate()
  await h.answer('show the task list')
  assert.deepEqual(h.matches, ['reply to the first item'], 'the matcher ran once, on the capture only')
  assert.deepEqual(h.readBacks, [[FROZEN, 'show the task list']])
  assert.equal(h.sends.length, 0)
})

test('R3 the dictation is read back through the queue wording, then the confirm listen opens only after the line ended', async () => {
  const h = harness()
  await h.toDictate()
  await h.answer('Add unit tests for the parser.')
  assert.deepEqual(h.said(), [READBACK(FROZEN, 'Add unit tests for the parser.')])
  assert.equal(h.state(), 'REPLY_CONFIRM_SPEAK')
  assert.equal(h.listens.length, 1, 'no second listen yet')
  assert.deepEqual(h.speaks[0].opts, { priority: 'High', gender: 'female' })
  await h.speakDone()
  assert.equal(h.listens.length, 2)
  assert.equal(h.listens[1].arg.context.step, 'reply-confirm')
  assert.equal(h.state(), 'REPLY_CONFIRM_LISTEN')
  assert.ok(h.flow.active())
})

test('R4 a strict yes sends exactly the frozen item and the dictated text, then speaks the result line and ends', async () => {
  const h = harness()
  await h.toConfirm('add tests')
  await h.answer('Yes.')
  assert.equal(h.sends.length, 1)
  assert.equal(h.sends[0][0], FROZEN, 'the frozen item from the moment of dictation')
  assert.equal(h.sends[0][1], 'add tests')
  assert.equal(h.state(), 'END_SPEAK')
  assert.equal(h.said().at(-1), 'Task Fix parser, reply sent. Two waiting.')
  assert.ok(h.flow.active(), 'still active while the result line plays')
  await h.speakDone()
  assert.equal(h.flow.active(), false)
  assert.equal(h.listens.length, 2, 'never re-listens after the send')
  assert.equal(h.decides.length, 0)
})

test('R5 only a strict yes sends: ok / sure / please are new text that replaces the prompt', async () => {
  for (const word of ['ok', 'sure', 'do it', 'go ahead']) {
    const h = harness()
    await h.toConfirm('add tests')
    await h.answer(word)
    assert.equal(h.sends.length, 0, word)
    assert.equal(h.said().at(-1), READBACK(FROZEN, word), word)
  }
})

test('R6 any other speech replaces the whole prompt, is read back again and only the replacement is sent', async () => {
  const h = harness()
  await h.toConfirm('add tests')
  await h.answer('Rename the helper instead')
  assert.equal(h.said().at(-1), READBACK(FROZEN, 'Rename the helper instead'))
  assert.equal(h.state(), 'REPLY_CONFIRM_SPEAK')
  await h.speakDone(); await h.listenStarted()
  assert.equal(h.listens.at(-1).arg.context.step, 'reply-confirm')
  await h.answer('yes')
  assert.deepEqual(h.sends.map((s) => s[1]), ['Rename the helper instead'])
})

test('R7 "cancel" at the confirm step aborts with a short line and sends nothing', async () => {
  const h = harness()
  await h.toConfirm('add tests')
  await h.answer('cancel')
  assert.equal(h.sends.length, 0)
  assert.equal(h.said().at(-1), 'Cancelled.')
  await h.speakDone()
  assert.equal(h.flow.active(), false)
  assert.equal(h.state(), 'IDLE')
})

test('R7b "cancel" or "never mind" at the dictation also aborts', async () => {
  for (const word of ['cancel', 'never mind', 'stop']) {
    const h = harness()
    await h.toDictate()
    await h.answer(word)
    assert.equal(h.said().at(-1), 'Cancelled.', word)
    assert.equal(h.sends.length, 0)
    assert.equal(h.readBacks.length, 0, word + ' is not dictated text')
  }
})

test('R8 a bare "no" at the confirm step says "Please say it again." and listens again at the same step, text unchanged', async () => {
  const h = harness()
  await h.toConfirm('add tests')
  await h.answer('no')
  assert.equal(h.said().at(-1), 'Please say it again.')
  assert.equal(h.sends.length, 0)
  await h.speakDone()
  assert.equal(h.listens.at(-1).arg.context.step, 'reply-confirm')
  await h.listenStarted()
  await h.answer('yes')
  assert.deepEqual(h.sends.map((s) => s[1]), ['add tests'], 'the original text survives a bare no')
})

test('R9 a dictation of "yes" or "no" is the reply text, not an answer', async () => {
  for (const word of ['yes', 'no', 'ok']) {
    const h = harness()
    await h.toDictate()
    await h.answer(word)
    assert.equal(h.said().at(-1), READBACK(FROZEN, word), word)
    assert.equal(h.sends.length, 0)
  }
})

test('R10 a dictation over 1500 characters is refused like a prompt: the too-long line, then the end', async () => {
  const h = harness()
  await h.toDictate()
  await h.answer('word '.repeat(400))
  assert.deepEqual(h.said(), [TOO_LONG])
  assert.equal(h.readBacks.length, 0)
  await h.speakDone()
  assert.equal(h.flow.active(), false)
  assert.equal(h.sends.length, 0)
})

test('R10b 1500 characters are fine; 1501 are not (limit shared with the prompt dictation)', async () => {
  const ok = harness()
  await ok.toDictate()
  await ok.answer('a'.repeat(1500))
  assert.equal(ok.readBacks.length, 1)
  const over = harness()
  await over.toDictate()
  await over.answer('a'.repeat(1501))
  assert.equal(over.readBacks.length, 0)
  assert.deepEqual(over.said(), [TOO_LONG])
})

test('R10c a replacement over the limit at the confirm step ends the same way and nothing is sent', async () => {
  const h = harness()
  await h.toConfirm('add tests')
  await h.answer('word '.repeat(400))
  assert.equal(h.said().at(-1), TOO_LONG)
  await h.speakDone()
  assert.equal(h.flow.active(), false)
  assert.equal(h.sends.length, 0)
})

test('R10d unspeakable text (hidden or dropped symbols) is refused with the "could not repeat that back safely" line', async () => {
  const h = harness()
  await h.toDictate()
  await h.answer('run rm -rf "*"')
  assert.deepEqual(h.said(), ['I could not repeat that back safely. Cancelled.'])
  assert.equal(h.readBacks.length, 0)
  assert.equal(h.sends.length, 0)
})

test('R10e the dictated text is sanitised like an utterance: whitespace collapsed, foldable symbols dropped', async () => {
  const h = harness()
  await h.toDictate()
  await h.answer('  fix   the\n parser | then rerun ')
  assert.deepEqual(h.readBacks, [[FROZEN, 'fix the parser then rerun']])
})

test('R11 no dictation (empty transcript, no speech, guard timeout) ends with "No answer. Cancelled."', async () => {
  const empty = harness()
  await empty.toDictate(); await empty.answer('   ')
  assert.deepEqual(empty.said(), ['No answer. Cancelled.'])
  const quiet = harness()
  await quiet.toDictate(); await quiet.idle('no_speech')
  assert.deepEqual(quiet.said(), ['No answer. Cancelled.'])
  const guard = harness()
  await guard.toDictate(); await guard.fire(140_000)
  assert.deepEqual(guard.said(), ['No answer. Cancelled.'])
  const confirmQuiet = harness()
  await confirmQuiet.toConfirm(); await confirmQuiet.idle('too_short')
  assert.equal(confirmQuiet.said().at(-1), 'No answer. Cancelled.')
  assert.equal(confirmQuiet.sends.length, 0)
})

test('R11b a recognition error ends with the recognition failure line', async () => {
  const h = harness()
  await h.toDictate()
  h.flow.handle({ type: 'error', message: 'boom', context: h.ctx() }); await tick()
  assert.deepEqual(h.said(), ['Speech recognition failed. Cancelled.'])
})

test('R12 an empty queue or an item that is not a done item is said and ends: no listen, nothing sent', async () => {
  const empty = harness({ queue: { prepareReply: async () => ({ ok: false, outcome: 'empty', line: 'Nothing waiting.' }) } })
  empty.capture('reply to the first item'); await tick()
  assert.deepEqual(empty.said(), ['Nothing waiting.'])
  assert.equal(empty.listens.length, 0)
  await empty.speakDone()
  assert.equal(empty.flow.active(), false)
  const question = harness({ queue: { prepareReply: async () => ({ ok: false, outcome: 'unsupported', line: 'Voice reply works on done items only. Answer it on screen.' }) } })
  question.capture('reply to the first item'); await tick()
  assert.deepEqual(question.said(), ['Voice reply works on done items only. Answer it on screen.'])
  assert.equal(question.listens.length, 0)
})

test('R12b a refusal with no line is a deliberate silence, not a hang', async () => {
  const h = harness({ queue: { prepareReply: async () => ({ ok: false, outcome: 'muted' }) } })
  h.capture('reply to the first item'); await tick()
  assert.deepEqual(h.said(), [])
  assert.equal(h.flow.active(), false)
})

test('R13 a prepareReply that throws is logged and spoken as a failure; the flow survives', async () => {
  const h = harness({ queue: { prepareReply: async () => { throw new Error('task list is not available. More.') } } })
  h.capture('reply to the first item'); await tick()
  assert.deepEqual(h.said(), ['That failed: task list is not available.'])
  assert.ok(h.logs.some((l) => l.stage === 'queue.error' && l.data.phase === 'reply'))
  const entry = h.logs.find((l) => l.stage === 'queue.reply' && l.data.outcome === 'error')
  assert.ok(entry && /not available/.test(entry.data.error))
  await h.speakDone()
  assert.equal(h.flow.active(), false)
})

test('R13b a synchronous throw in prepareReply is a failure line too, and one that never settles times out', async () => {
  const sync = harness({ queue: { prepareReply: () => { throw new Error('sync boom') } } })
  sync.capture('reply to the first item'); await tick()
  assert.deepEqual(sync.said(), ['That failed: sync boom.'])
  const hung = harness({ queue: { prepareReply: () => new Promise(() => {}) } })
  hung.capture('reply to the first item'); await tick()
  assert.deepEqual(hung.said(), [])
  await hung.fire(35_000)
  assert.deepEqual(hung.said(), ['That failed: timed out.'])
})

test('R14 the service refusing at the yes (the item changed or left) is spoken as the runner line and ends', async () => {
  const h = harness({ queue: { sendReply: async () => ({ outcome: 'changed', line: 'That item changed. Nothing done.' }) } })
  await h.toConfirm()
  await h.answer('yes')
  assert.equal(h.said().at(-1), 'That item changed. Nothing done.')
  await h.speakDone()
  assert.equal(h.flow.active(), false)
})

test('R14b a sendReply that throws is logged and spoken as "That failed: <reason>."', async () => {
  const h = harness({ queue: { sendReply: async () => { throw new Error('no-controller') } } })
  await h.toConfirm()
  await h.answer('yes')
  assert.equal(h.said().at(-1), 'That failed: no-controller.')
  const entry = h.logs.find((l) => l.stage === 'queue.reply' && l.data.step === 'send')
  assert.equal(entry.data.outcome, 'error')
  assert.ok(h.logs.some((l) => l.stage === 'queue.error' && l.data.phase === 'reply'))
  await h.speakDone()
  assert.equal(h.flow.active(), false)
})

test('R14c a sendReply that never settles fails after the execute timeout instead of hanging', async () => {
  const h = harness({ queue: { sendReply: () => new Promise(() => {}) } })
  await h.toConfirm()
  await h.answer('yes')
  assert.equal(h.state(), 'EXECUTE')
  await h.fire(35_000)
  assert.equal(h.said().at(-1), 'That failed: timed out.')
})

test('R14d a send result with no line still ends (silently), never hangs', async () => {
  const h = harness({ queue: { sendReply: async () => ({ outcome: 'sent' }) } })
  await h.toConfirm()
  await h.answer('yes')
  assert.equal(h.flow.active(), false)
})

test('R15 the hotkey (listening with no context) during the dictation stops the reader, aborts the reply and sends nothing', async () => {
  const h = harness()
  await h.toDictate()
  const ctx = h.ctx()
  h.flow.handle({ type: 'listening', context: null }); await tick()
  assert.equal(h.stops, 1)
  assert.equal(h.flow.active(), false)
  h.flow.handle({ type: 'transcript', revision: 1, text: 'add tests', context: ctx }); await tick()
  assert.equal(h.readBacks.length, 0, 'a late dictation of the aborted reply is stale')
  assert.equal(h.sends.length, 0)
})

test('R15b the hotkey during the confirm step aborts; a later "yes" with the old context sends nothing', async () => {
  const h = harness()
  await h.toConfirm()
  const ctx = h.ctx()
  h.flow.handle({ type: 'listening', context: null }); await tick()
  assert.equal(h.stops, 1)
  assert.equal(h.flow.active(), false)
  h.flow.handle({ type: 'transcript', revision: 1, text: 'yes', context: ctx }); await tick()
  assert.equal(h.sends.length, 0)
})

test('R15c after an aborted reply a new capture is a normal conversation (no reply state leaks)', async () => {
  const h = harness()
  await h.toConfirm()
  h.flow.handle({ type: 'listening', context: null }); await tick()
  h.capture('fix the parser'); await tick()
  assert.equal(h.said().at(-1), 'I heard: fix the parser. Is that right?')
  assert.equal(h.sends.length, 0)
})

test('R16 a second yes with the same (now stale) context cannot send twice', async () => {
  const h = harness()
  await h.toConfirm()
  const ctx = h.ctx()
  await h.answer('yes')
  h.flow.handle({ type: 'transcript', revision: 1, text: 'yes', context: ctx }); await tick()
  assert.equal(h.sends.length, 1)
})

test('R17 a revision-2 dictation transcript is ignored like every transcript', async () => {
  const h = harness()
  await h.toDictate()
  h.flow.handle({ type: 'transcript', revision: 2, text: 'add tests', context: h.ctx() }); await tick()
  assert.equal(h.readBacks.length, 0)
  assert.equal(h.state(), 'REPLY_DICTATE')
})

test('R18 a barge-in while the send runs is held: the result is still said, after the open mic closed', async () => {
  const d = deferred()
  const h = harness({ queue: { sendReply: () => d.promise } })
  await h.toConfirm()
  await h.answer('yes')
  h.flow.handle({ type: 'listening', context: null }); await tick()
  d.resolve({ outcome: 'sent', line: 'Task Fix parser, reply sent. Nothing waiting.' }); await tick()
  assert.deepEqual(h.said().filter((t) => t.startsWith('Task ')), [], 'not spoken into the open mic')
  h.flow.handle({ type: 'idle', reason: 'no_speech', context: null }); await tick()
  assert.equal(h.said().at(-1), 'Task Fix parser, reply sent. Nothing waiting.')
})

test('R19 the read-back cut by Ctrl+Alt+M cancels: the mic never opens and nothing is sent', async () => {
  const h = harness()
  await h.toDictate(); await h.answer('add tests')
  await h.speakDone('cut')
  assert.equal(h.said().at(-1), 'Cancelled.')
  assert.equal(h.listens.length, 1)
  assert.equal(h.sends.length, 0)
})

test('R19b a muted read-back ends silently: no listen, nothing sent', async () => {
  const h = harness()
  await h.toDictate(); await h.answer('add tests')
  await h.speakDone('muted')
  assert.equal(h.flow.active(), false)
  assert.equal(h.listens.length, 1)
  assert.equal(h.sends.length, 0)
})

test('R20 listen problems end with their lines: microphone busy, service down', async () => {
  const busy = harness()
  busy.capture('reply to the first item'); await tick()
  busy.listens[0].resolve({ started: false }); await tick()
  await busy.fire(500)
  busy.listens[1].resolve({ started: false }); await tick()
  assert.equal(busy.said().at(-1), 'The microphone is busy. Cancelled.')
  const down = harness()
  down.capture('reply to the first item'); await tick()
  down.listens[0].reject(new Error('ECONNREFUSED')); await tick()
  assert.equal(down.said().at(-1), 'Speech service unavailable. Cancelled.')
})

test('R21 every step is logged as queue.reply with the item and outcome', async () => {
  const h = harness()
  await h.toConfirm('add tests')
  await h.answer('yes')
  const stages = h.logs.filter((l) => l.stage === 'queue.reply').map((l) => [l.data.step, l.data.outcome])
  assert.deepEqual(stages, [['prepare', 'dictate'], ['dictated', 'confirm'], ['send', 'sent']])
  const first = h.logs.find((l) => l.stage === 'queue.reply')
  assert.equal(first.data.item, 'item-1')
  assert.equal(first.data.snapshotId, 'e:7')
  assert.equal(first.data.id, 'id1')
})

test('R21b replacing and cancelling are logged too', async () => {
  const h = harness()
  await h.toConfirm('add tests')
  await h.answer('other text'); await h.speakDone(); await h.listenStarted()
  await h.answer('cancel')
  const stages = h.logs.filter((l) => l.stage === 'queue.reply').map((l) => [l.data.step, l.data.outcome])
  assert.deepEqual(stages, [['prepare', 'dictate'], ['dictated', 'confirm'], ['replaced', 'confirm'], ['confirm', 'cancelled']])
})

test('R22 a queue without the reply methods (older runner) still echoes the reply words like before', async () => {
  const h = harness({ queue: { prepareReply: undefined } })
  h.capture('reply to the first item'); await tick()
  assert.deepEqual(h.said(), ['I heard: reply to the first item. Is that right?'])
})

test('R23 the reply never takes the LLM path: no decide anywhere in a full run', async () => {
  const h = harness()
  await h.toConfirm()
  await h.answer('yes'); await h.speakDone()
  assert.equal(h.decides.length, 0)
})

test('R24 a run of the reply flow leaves the flow reusable: a second reply works from scratch', async () => {
  const h = harness()
  await h.toConfirm('first'); await h.answer('yes'); await h.speakDone()
  assert.equal(h.flow.active(), false)
  await h.toConfirm('second'); await h.answer('yes')
  assert.deepEqual(h.sends.map((s) => s[1]), ['first', 'second'])
})

test('R25 a replyReadBack that throws ends with a failure line instead of crashing', async () => {
  const h = harness({ queue: { replyReadBack: () => { throw new Error('bad title') } } })
  await h.toDictate(); await h.answer('add tests')
  assert.equal(h.said().at(-1), 'That failed: bad title.')
  assert.equal(h.sends.length, 0)
})
