import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { installCapture } from '../capture.js'

// B: a TIMED question (wait.timed) that is about to time out is answered with its recommended option, and a done card tells the user.
// Timing: node:test mock timers (setTimeout only). The capture clock is injected and stays fixed, so the timer delay is exactly
// (window - lead): the ask's own timeout, else the defaultWindowMs option (120 s), minus lead 10 s (option autoAnswerLeadMs).
const NOW = 5_000_000
const REC = 'A (Recommended)'
const QUESTIONS = [{ id: 'q1', question: 'Which port?', options: [{ label: REC }, { label: 'B' }] }]
const never = () => new Promise(() => {})
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) } // setImmediate is not mocked

function world(t, { options = {}, summary = { text: 'S', title: 'T', source: 'llm', actionable: false } } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const handlers = {}
  const logs = []
  const summarized = []
  const ctx = {
    on: (name, fn) => { handlers[name] = fn },
    get: (name) => (name === 'sessionTitle' ? { get: () => ({ title: 'Session One' }) } : undefined),
    logger: { warn() {}, info() {} },
  }
  let n = 0
  let tick = 1000
  const store = createStore({ now: () => ++tick, uuid: () => 'i' + ++n })
  const summarizer = { summarize: async (reply) => { summarized.push(reply); return summary } }
  const capture = installCapture(ctx, { store, summarizer, log: (line) => logs.push(line), now: () => NOW, ...options })
  const agent = (id = 'a1') => ({ id, session: { id, header: { cwd: 'D:/proj' }, deriveMessages: () => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'x' }] } })
  const fire = (name, ...args) => handlers[name](...args)
  // wait is the request's wait field as DSH sends it: { callId, timed: true } for a timed ask, { callId } for an indefinite one, null for the legacy tool (none).
  const ask = ({ questions = QUESTIONS, callId = 'c1', next = never, signal, timeoutSec, wait = { callId, timed: true } } = {}) => {
    const go = async () => {
      if (timeoutSec !== undefined) await fire('tools/pre-execute', { name: 'ask_user_question', callId, arguments: { timeout: timeoutSec }, agent: agent() }, async () => ({}))
      const p = fire('user-questions/request', { agent: agent(), questions, ...(wait ? { wait } : {}), signal }, next)
      return { p, id: store.snapshot().open.filter((i) => i.type === 'question').at(-1).id }
    }
    return go()
  }
  const advance = async (ms) => { t.mock.timers.tick(ms); await flush() }
  const doneCards = () => store.list().filter((i) => i.type === 'completed')
  return { store, capture, logs, summarized, agent, fire, ask, advance, doneCards }
}

// ---- B1: the timer ----
test('with no timeout passed the recommended option is answered 10 s before the default 120 s window ends, not earlier', async (t) => {
  const w = world(t)
  const { id } = await w.ask()
  await w.advance(109_999)
  assert.equal(w.store.get(id).status, 'open', 'still waiting for the user at 109.999 s')
  await w.advance(1)
  assert.equal(w.store.get(id).status, 'resolved')
  assert.deepEqual(w.store.get(id).resolution, { kind: 'answered', by: 'auto', answers: [{ id: 'q1', selected: [REC] }] })
})

test('the known timeout of the ask call (expiresAt) sets the deadline instead of the default window', async (t) => {
  const w = world(t)
  const { id } = await w.ask({ timeoutSec: 60 })
  await w.advance(49_999)
  assert.equal(w.store.get(id).status, 'open')
  await w.advance(1)
  assert.equal(w.store.get(id).resolution?.by, 'auto')
})

test('an explicit ask timeout of 300 s fires at 290 s, not at 110 s', async (t) => {
  const w = world(t)
  const { id } = await w.ask({ timeoutSec: 300 })
  await w.advance(110_000)
  assert.equal(w.store.get(id).status, 'open', 'the guessed 120 s window must not apply')
  await w.advance(179_999)
  assert.equal(w.store.get(id).status, 'open', 'still waiting for the user at 289.999 s')
  await w.advance(1)
  assert.equal(w.store.get(id).resolution?.by, 'auto')
})

test('with no timeout passed the window is the defaultWindowMs option (config questionWindowSeconds)', async (t) => {
  const w = world(t, { options: { defaultWindowMs: 60_000 } })
  const { id } = await w.ask()
  await w.advance(49_999)
  assert.equal(w.store.get(id).status, 'open')
  await w.advance(1)
  assert.equal(w.store.get(id).resolution?.by, 'auto')
})

// Only a timed ask with a deadline has a timeout to run ahead of: anything else is left to the user.
const NOT_ARMED = [
  ['a wait without timed (an indefinite card-keyed ask)', { wait: { callId: 'c1' } }],
  ['a legacy blocking request with no wait at all', { wait: null }],
  ['a timed ask whose timeout the model passed as -1 (no deadline)', { timeoutSec: -1 }],
  ['a question that carries a plan-review intent', { questions: [{ ...QUESTIONS[0], detail: 'The plan.', intent: { kind: 'plan-review', approve: REC } }] }],
]
for (const [label, args] of NOT_ARMED) {
  test(label + ' is never auto-answered', async (t) => {
    const w = world(t)
    const { id } = await w.ask(args)
    await w.advance(400_000)
    assert.equal(w.store.get(id).status, 'open')
    assert.equal(w.store.get(id).expiresAt, undefined, 'no expiry is invented')
    assert.equal(w.doneCards().length, 0)
    assert.ok(!w.logs.some((l) => l.includes('auto-answered')), w.logs.join(' | '))
  })
}

test('the lead is the autoAnswerLeadMs option', async (t) => {
  const w = world(t, { options: { autoAnswerLeadMs: 3000 } })
  const { id } = await w.ask()
  await w.advance(116_999)
  assert.equal(w.store.get(id).status, 'open')
  await w.advance(1)
  assert.equal(w.store.get(id).resolution?.by, 'auto')
})

for (const options of [{ autoAnswerLeadMs: 0 }, { autoAnswer: false }]) {
  test('the option ' + JSON.stringify(options) + ' switches the auto answer off', async (t) => {
    const w = world(t, { options })
    const { id } = await w.ask()
    await w.advance(300_000)
    assert.equal(w.store.get(id).status, 'open')
    assert.equal(w.doneCards().length, 0)
  })
}

// ---- B2: when it fires ----
test('the auto answer settles the request exactly like a card answer', async (t) => {
  const w = world(t)
  const { p, id } = await w.ask()
  await w.advance(110_000)
  assert.equal(w.store.get(id).resolution?.by, 'auto', 'answered by the timer')
  assert.deepEqual(await p, { answers: [{ id: 'q1', selected: [REC] }] })
})

test('every question of the request gets its recommended option, one answer per question', async (t) => {
  const two = [QUESTIONS[0], { id: 'q2', question: 'Which host?', options: [{ label: 'X' }, { label: 'Y (Recommended)' }] }]
  const w = world(t)
  const { id } = await w.ask({ questions: two })
  await w.advance(110_000)
  assert.deepEqual(w.store.get(id).resolution?.answers, [{ id: 'q1', selected: [REC] }, { id: 'q2', selected: ['Y (Recommended)'] }])
})

test('a request where any question has no recommended option is not auto-answered and stays answerable', async (t) => {
  const mixed = [QUESTIONS[0], { id: 'q2', question: 'Which host?', options: [{ label: 'X' }, { label: 'Y' }] }]
  const w = world(t)
  const { id } = await w.ask({ questions: mixed })
  await w.advance(200_000)
  assert.equal(w.store.get(id).status, 'open')
  assert.equal(w.doneCards().length, 0)
  assert.equal(w.capture.answerQuestion(id, [{ id: 'q1', selected: ['B'] }, { id: 'q2', selected: ['X'] }]).ok, true, 'the card can still answer it')
})

test('a batch the answer check refuses (duplicate question ids) is not auto-answered', async (t) => {
  const dup = [QUESTIONS[0], { id: 'q1', question: 'Again?', options: [{ label: 'Z (Recommended)' }] }]
  const w = world(t)
  const { id } = await w.ask({ questions: dup })
  await w.advance(200_000)
  assert.equal(w.store.get(id).status, 'open')
})

test('a card answer that arrives before the timer wins, and no done card is added', async (t) => {
  const w = world(t)
  const { id } = await w.ask()
  await w.advance(50_000)
  assert.equal(w.capture.answerQuestion(id, [{ id: 'q1', selected: ['B'] }]).ok, true)
  await w.advance(100_000)
  assert.deepEqual({ kind: w.store.get(id).resolution.kind, by: w.store.get(id).resolution.by, answers: w.store.get(id).resolution.answers }, { kind: 'answered', by: 'card', answers: [{ id: 'q1', selected: ['B'] }] })
  assert.equal(w.doneCards().length, 0)
})

test('a card click after the auto answer is refused as not-pending and changes nothing', async (t) => {
  const w = world(t)
  const { id } = await w.ask()
  await w.advance(110_000)
  assert.equal(w.store.get(id).resolution?.by, 'auto')
  assert.deepEqual(w.capture.answerQuestion(id, [{ id: 'q1', selected: ['B'] }]), { ok: false, error: 'not-pending' })
  assert.deepEqual(w.store.get(id).resolution.answers, [{ id: 'q1', selected: [REC] }])
})

test('a question already answered on screen is not auto-answered later', async (t) => {
  const w = world(t)
  const { id } = await w.ask({ next: async () => ({ answers: [{ id: 'q1', selected: ['B'] }] }) })
  await w.advance(1)
  assert.equal(w.store.get(id).resolution.by, 'screen')
  await w.advance(200_000)
  assert.equal(w.store.get(id).resolution.by, 'screen')
  assert.equal(w.doneCards().length, 0)
})

test('a question that ended (timed out in DSH) is not auto-answered by a leftover timer', async (t) => {
  const w = world(t)
  const ac = new AbortController()
  const { p, id } = await w.ask({ signal: ac.signal })
  ac.abort(Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' }))
  await assert.rejects(p)
  await w.advance(200_000)
  assert.equal(w.store.get(id).resolution.kind, 'expired')
  assert.equal(w.doneCards().length, 0)
})

test('a question closed from its session (a session event) clears its auto-answer timer', async (t) => {
  const w = world(t)
  const created = []
  const cleared = []
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = (...args) => { const h = realSet(...args); created.push(h); return h }
  globalThis.clearTimeout = (h) => { cleared.push(h); return realClear(h) }
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear })
  const { id } = await w.ask()
  assert.equal(created.length, 1, 'the auto-answer timer was armed')
  const result = { toolCallId: 'c1', content: JSON.stringify({ answers: [{ id: 'q1', selected: ['B'] }] }) }
  w.fire('session/event', { id: 'a1' }, { type: 'tool/result', data: { message: result } })
  assert.deepEqual({ kind: w.store.get(id).resolution.kind, by: w.store.get(id).resolution.by }, { kind: 'answered', by: 'session' })
  assert.ok(cleared.includes(created[0]), 'the timer was cleared when the session closed the item')
})

test('dispose() clears the pending auto answers', async (t) => {
  const w = world(t)
  const { id } = await w.ask()
  w.capture.dispose()
  await w.advance(200_000)
  assert.equal(w.store.get(id).status, 'open')
  assert.equal(w.doneCards().length, 0)
})

// ---- B3: the done card that says what was decided ----
test('after the auto answer a done card for the session describes the decision', async (t) => {
  const w = world(t)
  await w.ask()
  await w.advance(110_000)
  const [card] = w.doneCards()
  assert.ok(card, 'a done card was added')
  const text = 'The question "Which port?" was about to time out, so the Coding Boss Review Queue answered it for you with the recommended option: "' + REC + '". The assistant received that as the answer; you did not choose it. Reply in this session to change course.'
  assert.equal(card.status, 'open')
  assert.equal(card.title, 'Question auto-answered')
  assert.equal(card.summary, text)
  assert.equal(card.payload.reply, text)
  assert.equal(card.summarySource, 'auto')
  assert.equal(card.actionable, true)
  assert.equal('autoDecision' in card, false, 'a normal done card: nothing reads a marker field')
  assert.equal(card.sessionId, 'a1')
  assert.equal(card.sessionTitle, 'Session One')
  assert.equal(card.workspace, 'D:/proj')
})

test('a long first question is trimmed to about 120 characters in the card text', async (t) => {
  const long = 'Which of these many approaches should we take for the migration? '.repeat(6).trim()
  const w = world(t)
  await w.ask({ questions: [{ id: 'q1', question: long, options: [{ label: REC }, { label: 'B' }] }] })
  await w.advance(110_000)
  const [card] = w.doneCards()
  assert.ok(card, 'a done card was added')
  assert.ok(card.summary.includes(long.slice(0, 100)), card.summary)
  assert.ok(!card.summary.includes(long.slice(0, 200)), 'the question is cut: ' + card.summary)
  assert.ok(card.summary.length < 400, String(card.summary.length))
})

test('with several questions the card text lists each question and the option chosen for it', async (t) => {
  const two = [QUESTIONS[0], { id: 'q2', question: 'Which host?', options: [{ label: 'X' }, { label: 'Y (Recommended)' }] }]
  const w = world(t)
  await w.ask({ questions: two })
  await w.advance(110_000)
  const [card] = w.doneCards()
  assert.ok(card, 'a done card was added')
  for (const part of ['Which port?', REC, 'Which host?', 'Y (Recommended)', 'the Coding Boss Review Queue answered them for you with the recommended options', 'The assistant received those as the answers; you did not choose them.', 'Reply in this session to change course.']) assert.ok(card.summary.includes(part), part + ' in ' + card.summary)
})

test('the decision card is not sent to the summarizer and is never hidden as no-action', async (t) => {
  const w = world(t) // this summarizer would say actionable: false
  await w.ask()
  await w.advance(110_000)
  await flush()
  assert.equal(w.summarized.length, 0, 'no summarizer call')
  const [card] = w.doneCards()
  assert.ok(card, 'a done card was added')
  assert.equal(card.status, 'open')
  assert.equal(card.summarySource, 'auto')
})

test('the decision card closes on a user-source message in the session, not on injected messages', async (t) => {
  const w = world(t)
  await w.ask()
  await w.advance(110_000)
  const step = (messages) => w.fire('agent/pre-step', { agent: w.agent(), messages }, async () => ({ kind: 'enter', messages: [] }))
  await step([{ role: 'user', source: { kind: 'cordis-host-runner' }, content: 'job done' }])
  assert.equal(w.doneCards()[0]?.status, 'open')
  await step([{ role: 'user', content: 'no, use B' }])
  const [card] = w.doneCards()
  assert.ok(card, 'a done card was added')
  assert.deepEqual({ kind: card.resolution.kind, by: card.resolution.by }, { kind: 'replied', by: 'session' })
})

test('the auto answer is logged with the question id and the option(s) chosen', async (t) => {
  const w = world(t)
  const { id } = await w.ask()
  await w.advance(110_000)
  const line = w.logs.find((l) => l.includes('auto-answered'))
  assert.ok(line, w.logs.join(' | '))
  assert.ok(line.startsWith('capture: question ' + id + ' auto-answered with the recommended option'), line)
  assert.ok(line.includes(REC), line)
})

// ---- the option label comes from the model: it is quoted like the question text, cleaned and capped at 120 characters ----
const HOSTILE = 'Use **the** plan\nwith \u202ehidden\u202c text (Recommended) ' + 'tail '.repeat(60).trim()
const CLEANED = 'Use the plan with hidden text (Recommended) ' + 'tail '.repeat(60).trim()
const SHOWN = CLEANED.slice(0, 120).trimEnd() + '...'

test('a recommended option label from the model is cleaned and capped at 120 characters in the card text and the log line', async (t) => {
  const w = world(t)
  await w.ask({ questions: [{ id: 'q1', question: 'Which plan?', options: [{ label: HOSTILE }, { label: 'B' }] }] })
  await w.advance(110_000)
  const [card] = w.doneCards()
  assert.ok(card, 'a done card was added')
  const line = w.logs.find((l) => l.includes('auto-answered'))
  assert.ok(line, w.logs.join(' | '))
  for (const [what, text] of [['card summary', card.summary], ['card reply', card.payload.reply], ['log line', line]]) {
    assert.ok(text.includes(SHOWN), what + ' has the cleaned, capped label: ' + text)
    assert.ok(!/[\n\u202e\u202c*]/.test(text), what + ' has no raw control or markdown characters: ' + JSON.stringify(text))
    assert.ok(!text.includes(CLEANED.slice(0, 130)), what + ' does not quote the label past 120 characters')
  }
})

test('with several questions each recommended label is cleaned and capped in the card text', async (t) => {
  const w = world(t)
  const two = [{ id: 'q1', question: 'Which port?', options: [{ label: HOSTILE }, { label: 'B' }] }, { id: 'q2', question: 'Which host?', options: [{ label: 'X' }, { label: 'Y (Recommended)' }] }]
  await w.ask({ questions: two })
  await w.advance(110_000)
  const [card] = w.doneCards()
  assert.ok(card, 'a done card was added')
  assert.ok(card.summary.includes(SHOWN), card.summary)
  assert.ok(!card.summary.includes(CLEANED.slice(0, 130)), card.summary)
  assert.ok(card.summary.includes('"Y (Recommended)"'), 'a short clean label is quoted unchanged')
  assert.ok(!/[\n\u202e*]/.test(card.summary), JSON.stringify(card.summary))
})

test('the answer given to the assistant and stored on the item keeps the exact label', async (t) => {
  const w = world(t)
  const { p, id } = await w.ask({ questions: [{ id: 'q1', question: 'Which plan?', options: [{ label: HOSTILE }, { label: 'B' }] }] })
  await w.advance(110_000)
  assert.deepEqual(w.store.get(id).resolution.answers, [{ id: 'q1', selected: [HOSTILE] }])
  assert.deepEqual(await p, { answers: [{ id: 'q1', selected: [HOSTILE] }] })
})

// ---- a refused auto-answer is logged (never silent) ----
test('a question with no recommended option is left to the user and the log says the auto-answer did not apply', async (t) => {
  const w = world(t)
  const { id } = await w.ask({ questions: [{ id: 'q1', question: 'Which port?', options: [{ label: 'A' }, { label: 'B' }] }] })
  await w.advance(110_000)
  assert.equal(w.store.get(id).status, 'open')
  const line = w.logs.find((l) => l.includes(id) && /not auto-answered/.test(l))
  assert.ok(line, w.logs.join(' | '))
  assert.match(line, /^capture: /)
  assert.match(line, /recommended answer/)
  assert.equal(w.doneCards().length, 0)
})

test('an auto-answer whose request is no longer pending is logged and adds no done card', async (t) => {
  const w = world(t)
  const realClear = globalThis.clearTimeout
  try {
    globalThis.clearTimeout = () => {} // the timer outlives its question: only then can it fire for a request that is gone
    const { id } = await w.ask()
    assert.deepEqual(w.capture.answerQuestion(id, [{ id: 'q1', selected: ['B'] }]), { ok: true })
    await w.advance(110_000)
    const line = w.logs.find((l) => l.includes(id) && /not auto-answered/.test(l))
    assert.ok(line, w.logs.join(' | '))
    assert.match(line, /no longer pending/)
    assert.equal(w.doneCards().length, 0)
    assert.equal(w.store.get(id).resolution.by, 'card')
  } finally { globalThis.clearTimeout = realClear }
})
