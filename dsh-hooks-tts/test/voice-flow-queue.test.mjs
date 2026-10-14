// Slice 4 of dsh-review-queue/docs/voice-task-list.md: the read-only task-list commands run at once in the flow:
// no echo, no LLM, no "yes"; the outcome line (or silence) ends the turn. With no queue the flow behaves as before.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceFlow } from '../voice/flow.js'

const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(setImmediate) }

function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

/** queue: false = no queue dependency at all; otherwise a fake whose match/run/stop can be overridden. */
function harness({ queue = {}, ...over } = {}) {
  const h = { speaks: [], listens: [], decides: [], logs: [], timers: [], runs: [], matches: [], stops: 0, cancels: 0, idles: 0 }
  let tid = 0, u = 0
  const INTENTS = {
    'show the task list': { kind: 'show' }, 'hide the task list': { kind: 'hide' }, 'how many items': { kind: 'count' },
    'read the first item': { kind: 'read', n: 1 }, 'read the next one': { kind: 'next' }, 'read it again': { kind: 'again' },
    stop: { kind: 'stop' }, 'open the first item': { kind: 'open' }, 'reply to the first item': { kind: 'reply', n: 1 },
  }
  const fakeQueue = queue === false ? undefined : {
    match: (text) => { h.matches.push(text); return INTENTS[text.toLowerCase().replace(/[.!?]+$/, '')] },
    run: async (intent) => { h.runs.push(intent); return { outcome: 'ok', line: 'Done ' + intent.kind + '.' } },
    stop: () => { h.stops++ },
    ...queue,
  }
  const deps = {
    speak: (text, opts) => { const d = deferred(); h.speaks.push({ text, opts, ...d }); return d.promise },
    listen: (arg) => { const d = deferred(); h.listens.push({ arg, ...d }); return d.promise },
    decide: (utterance) => { const d = deferred(); h.decides.push({ utterance, ...d }); return d.promise },
    validate: (raw) => ({ ok: true, action: { ...raw } }),
    readBack: () => 'x', resultText: () => 'y', execute: async () => ({}),
    classify: (t) => (t.trim() === '' ? 'empty' : 'text'),
    cancelSpeech: () => { h.cancels++ },
    now: () => 1000,
    log: (stage, data) => { h.logs.push({ stage, data }) },
    setTimer: (fn, ms) => { const id = ++tid; h.timers.push({ id, fn, ms }); return id },
    clearTimer: (id) => { h.timers = h.timers.filter((t) => t.id !== id) },
    uuid: () => 'id' + ++u,
    onIdle: () => { h.idles++ },
    ...(fakeQueue ? { queue: fakeQueue } : {}),
    ...over,
  }
  h.flow = createVoiceFlow(deps)
  h.said = () => h.speaks.map((s) => s.text)
  h.state = () => h.flow.snapshot().state
  h.capture = (text) => h.flow.handle({ type: 'transcript', revision: 1, text, context: null, source: 'hotkey', seconds: 1 })
  h.speakDone = async (status = 'done') => { h.speaks.at(-1).resolve({ status, ms: 50 }); await tick() }
  h.fire = async (ms) => { const t = h.timers.find((x) => x.ms === ms); assert.ok(t, 'a ' + ms + ' ms timer'); h.timers = h.timers.filter((x) => x !== t); t.fn(); await tick() }
  return h
}

test('Q1 a matched command runs at once: no echo, no listen, no LLM; the outcome line is spoken and the flow ends', async () => {
  const h = harness()
  h.capture('Show the task list.'); await tick()
  assert.deepEqual(h.runs, [{ kind: 'show' }])
  assert.deepEqual(h.said(), ['Done show.'])
  assert.deepEqual(h.speaks[0].opts, { priority: 'High', gender: 'female' })
  assert.equal(h.decides.length, 0)
  assert.equal(h.listens.length, 0)
  assert.ok(h.flow.active(), 'still active while the line plays')
  await h.speakDone()
  assert.equal(h.flow.active(), false)
  assert.equal(h.listens.length, 0, 'never re-listens')
  assert.equal(h.idles >= 1, true)
})

test('Q2 every read-only kind is run with its intent (n included)', async () => {
  for (const [text, intent] of [['show the task list', { kind: 'show' }], ['hide the task list', { kind: 'hide' }], ['how many items', { kind: 'count' }], ['read the first item', { kind: 'read', n: 1 }], ['read the next one', { kind: 'next' }], ['read it again', { kind: 'again' }], ['stop', { kind: 'stop' }], ['open the first item', { kind: 'open' }]]) {
    const h = harness()
    h.capture(text); await tick()
    assert.deepEqual(h.runs, [intent], text)
    assert.equal(h.said().length, 1, text + ' spoke the outcome')
    assert.ok(!h.said()[0].startsWith('I heard'), text)
  }
})

test('Q3 the transcript is trimmed before it is matched', async () => {
  const h = harness()
  h.capture('   show the task list  \n'); await tick()
  assert.deepEqual(h.matches, ['show the task list'])
})

test('Q4 a result with no line is silent: nothing is spoken and the flow is idle at once', async () => {
  const h = harness({ queue: { run: async () => ({ outcome: 'reading' }) } })
  h.capture('read the first item'); await tick()
  assert.deepEqual(h.said(), [])
  assert.equal(h.flow.active(), false)
  assert.equal(h.state(), 'IDLE')
  assert.ok(h.idles >= 1)
})

test('Q5 silence:true (stop) also cuts the line in flight and queued lines', async () => {
  const h = harness({ queue: { run: async () => ({ outcome: 'stopped', silence: true }) } })
  h.capture('stop'); await tick()
  assert.ok(h.cancels >= 1)
  assert.deepEqual(h.said(), [])
  assert.equal(h.flow.active(), false)
})

test('Q6 the reply intent is recognised but this round falls through to the existing echo path', async () => {
  const h = harness()
  h.capture('reply to the first item'); await tick()
  assert.deepEqual(h.runs, [])
  assert.deepEqual(h.said(), ['I heard: reply to the first item. Is that right?'])
})

test('Q7 an intent kind the flow does not know falls through too', async () => {
  const h = harness({ queue: { match: () => ({ kind: 'bogus' }) } })
  h.capture('anything'); await tick()
  assert.deepEqual(h.runs, [])
  assert.deepEqual(h.said(), ['I heard: anything. Is that right?'])
})

test('Q8 an unmatched utterance takes the normal path', async () => {
  const h = harness()
  h.capture('fix the parser'); await tick()
  assert.deepEqual(h.runs, [])
  assert.deepEqual(h.said(), ['I heard: fix the parser. Is that right?'])
})

test('Q9 without a queue dependency the same words are echoed exactly as before', async () => {
  const h = harness({ queue: false })
  h.capture('show the task list'); await tick()
  assert.deepEqual(h.said(), ['I heard: show the task list. Is that right?'])
  h.flow.handle({ type: 'listening', context: null }) // the hotkey with no queue must not throw either
})

test('Q10 a matcher that throws never breaks the flow: the utterance is echoed', async () => {
  const h = harness({ queue: { match: () => { throw new Error('matcher bug') } } })
  assert.doesNotThrow(() => h.capture('show the task list'))
  await tick()
  assert.deepEqual(h.said(), ['I heard: show the task list. Is that right?'])
  assert.ok(h.logs.some((l) => l.stage === 'queue.error'))
})

test('Q11 run() that throws speaks the failure line', async () => {
  const h = harness({ queue: { run: async () => { throw new Error('queue is down. More text.') } } })
  h.capture('how many items'); await tick()
  assert.deepEqual(h.said(), ['That failed: queue is down.'])
  await h.speakDone()
  assert.equal(h.flow.active(), false)
})

test('Q12 a synchronous throw in run() is a failure line as well', async () => {
  const h = harness({ queue: { run: () => { throw new Error('sync boom') } } })
  h.capture('how many items'); await tick()
  assert.deepEqual(h.said(), ['That failed: sync boom.'])
})

test('Q13 a run() that never settles fails after the execute timeout instead of hanging', async () => {
  const h = harness({ queue: { run: () => new Promise(() => {}) } })
  h.capture('how many items'); await tick()
  assert.deepEqual(h.said(), [])
  await h.fire(35_000)
  assert.deepEqual(h.said(), ['That failed: timed out.'])
})

test('Q14 a barge-in while the command runs drops its outcome line', async () => {
  const d = deferred()
  const h = harness({ queue: { run: () => d.promise } })
  h.capture('how many items'); await tick()
  h.flow.handle({ type: 'listening', context: null }); await tick()
  d.resolve({ outcome: 'ok', line: 'Three waiting.' }); await tick()
  assert.deepEqual(h.said(), [])
  assert.equal(h.flow.active(), false)
})

test('Q15 the outcome line, when muted, ends silently (no retry, no speak-dead)', async () => {
  const h = harness()
  h.capture('show the task list'); await tick()
  await h.speakDone('muted')
  assert.equal(h.said().length, 1)
  assert.equal(h.flow.active(), false)
  assert.ok(!h.logs.some((l) => l.stage === 'speak-dead'))
})

test('Q16 each fast-path intent is logged as queue.intent with kind and outcome', async () => {
  const h = harness({ queue: { run: async () => ({ outcome: 'count', line: 'Nothing waiting.' }) } })
  h.capture('how many items'); await tick()
  const entry = h.logs.find((l) => l.stage === 'queue.intent' && l.data.outcome)
  assert.ok(entry, 'a queue.intent entry with an outcome')
  assert.equal(entry.data.kind, 'count')
  assert.equal(entry.data.outcome, 'count')
  assert.equal(entry.data.line, 'Nothing waiting.')
  assert.equal(entry.data.id, 'id1')
})

test('Q17 an empty transcript is still "I did not catch that." and is not matched', async () => {
  const h = harness()
  h.capture('   '); await tick()
  assert.deepEqual(h.said(), ['I did not catch that.'])
  assert.deepEqual(h.matches, [])
})

test('Q18 a command during a running conversation replaces it (the old turn is silenced)', async () => {
  const h = harness()
  h.capture('fix the parser'); await tick()
  await h.speakDone() // echo spoken, listening
  h.capture('how many items'); await tick()
  assert.ok(h.cancels >= 1)
  assert.deepEqual(h.runs, [{ kind: 'count' }])
  assert.equal(h.said().at(-1), 'Done count.')
})

test('Q19 the fast path ignores revision-2 transcripts like every capture', async () => {
  const h = harness()
  h.flow.handle({ type: 'transcript', revision: 2, text: 'show the task list', context: null }); await tick()
  assert.deepEqual(h.runs, [])
  assert.deepEqual(h.said(), [])
})

test('Q20 the hotkey (listening with no context) stops the queue reader, idle or not', async () => {
  const h = harness()
  h.flow.handle({ type: 'listening', context: null })
  assert.equal(h.stops, 1)
  h.capture('fix the parser'); await tick()
  h.flow.handle({ type: 'listening', context: null })
  assert.equal(h.stops, 2)
})

test('Q21 the hotkey stop fires also while a command result is held (EXECUTE) and during the fast path', async () => {
  const d = deferred()
  const h = harness({ queue: { run: () => d.promise } })
  h.capture('how many items'); await tick()
  h.flow.handle({ type: 'listening', context: null })
  assert.equal(h.stops, 1)
})

test('Q22 the flow own listens (with a context) do not stop the reader', async () => {
  const h = harness()
  h.capture('fix the parser'); await tick()
  await h.speakDone()
  const context = h.listens.at(-1).arg.context
  h.flow.handle({ type: 'listening', context })
  assert.equal(h.stops, 0)
})

test('Q23 a queue.stop() that throws never breaks the barge-in', async () => {
  const h = harness({ queue: { stop: () => { throw new Error('stop bug') } } })
  assert.doesNotThrow(() => h.flow.handle({ type: 'listening', context: null }))
  assert.ok(h.logs.some((l) => l.stage === 'queue.error'))
})

test('Q24 a queue without a stop() is fine for the hotkey', async () => {
  const h = harness({ queue: { stop: undefined } })
  assert.doesNotThrow(() => h.flow.handle({ type: 'listening', context: null }))
})

test('Q25 the outcome line failing (speaker dead) ends the turn quietly', async () => {
  const h = harness()
  h.capture('show the task list'); await tick()
  await h.speakDone('failed'); await h.speakDone('failed')
  assert.equal(h.flow.active(), false)
  assert.ok(h.logs.some((l) => l.stage === 'speak-dead'))
})
