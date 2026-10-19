import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { installCapture } from '../capture.js'

// Unbounded growth: a done card is only closed by a human message, so a session that never gets one (schedule ticks, goal rounds,
// background jobs) piled up open done cards. The open done cards ('completed') of one session are capped (option keepDone, default 20;
// config doneKeepPerSession): past the cap the OLDEST is resolved as { kind: 'trimmed', by: 'auto' } and a log line names it (never silent).
// The per-step check (agent/pre-step) must not copy the whole store (store.list clones every item): it reads the session's open items only.
function setup({ options = {}, wrap = (s) => s } = {}) {
  const handlers = {}
  const logs = []
  const ctx = { on: (name, fn) => { handlers[name] = fn }, get: () => undefined, logger: { warn() {}, info() {} } }
  let t = 1000
  let n = 0
  const real = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const store = wrap(real)
  installCapture(ctx, { store, summarizer: { summarize: async () => ({ text: 'Did it.', source: 'llm', actionable: true }) }, log: (line) => logs.push(line), ...options })
  const agent = (id = 'a1', reply = 'All done.') => ({
    id,
    session: { id, header: { cwd: 'D:/proj' }, deriveMessages: () => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: reply }] }] },
  })
  const fire = (name, ...args) => handlers[name](...args)
  const done = (id, reply) => fire('agent/turn-stopping', { agent: agent(id, reply) })
  const preStep = (id, messages) => fire('agent/pre-step', { agent: agent(id), messages }, async () => ({ kind: 'enter', messages: [] }))
  const open = (id) => real.list({ status: 'open' }).filter((i) => i.sessionId === id)
  return { real, store, logs, agent, fire, done, preStep, open }
}

test('by default the 21st open done card of a session resolves the oldest as trimmed, and a log line names its id and session', async () => {
  const x = setup()
  for (let i = 1; i <= 20; i++) await x.done('a1', 'Result ' + i)
  assert.equal(x.open('a1').length, 20, 'twenty fit')
  assert.ok(!x.logs.some((l) => /trimmed/i.test(l)), 'nothing trimmed yet: ' + x.logs.join(' | '))
  const oldest = x.open('a1')[0]
  await x.done('a1', 'Result 21')
  const open = x.open('a1')
  assert.equal(open.length, 20)
  assert.equal(open.at(-1).payload.reply, 'Result 21', 'the newest is kept')
  assert.ok(!open.some((i) => i.id === oldest.id))
  const gone = x.real.get(oldest.id)
  assert.deepEqual({ status: gone.status, kind: gone.resolution.kind, by: gone.resolution.by }, { status: 'resolved', kind: 'trimmed', by: 'auto' })
  const line = x.logs.find((l) => l.includes(oldest.id))
  assert.ok(line, x.logs.join(' | '))
  assert.match(line, /^capture: /)
  assert.match(line, /trimmed/i)
  assert.ok(line.includes('a1'), 'names the session: ' + line)
})

test('the cap is per session: another session keeps its cards, questions and permissions are never trimmed', async () => {
  const x = setup({ options: { keepDone: 2 } })
  void x.fire('user-questions/request', { agent: x.agent('a1'), questions: [{ id: 'q', question: 'Q?', options: [{ label: 'A' }] }], wait: { callId: 'c1' } }, () => new Promise(() => {}))
  void x.fire('approval/request', { agent: x.agent('a1'), toolName: 'shell', callId: 'p1' }, () => new Promise(() => {}))
  await x.done('other', 'Other 1')
  for (let i = 1; i <= 5; i++) await x.done('a1', 'Result ' + i)
  assert.deepEqual(x.open('a1').map((i) => i.type + ':' + (i.payload.reply ?? '')), ['question:', 'permission:', 'completed:Result 4', 'completed:Result 5'])
  assert.equal(x.open('other').length, 1)
  assert.equal(x.real.list({ status: 'resolved' }).filter((i) => i.resolution.kind === 'trimmed').length, 3)
})

test('the option keepDone sets the cap; a resolved (reviewed, hidden) card does not count towards it', async () => {
  const x = setup({ options: { keepDone: 3 } })
  await x.done('a1', 'One'); await x.done('a1', 'Two')
  x.real.resolve(x.open('a1')[0].id, { kind: 'reviewed', by: 'card' })
  await x.done('a1', 'Three'); await x.done('a1', 'Four')
  assert.deepEqual(x.open('a1').map((i) => i.payload.reply), ['Two', 'Three', 'Four'], 'three open, none trimmed')
  assert.ok(!x.logs.some((l) => /trimmed/i.test(l)), x.logs.join(' | '))
  await x.done('a1', 'Five')
  assert.deepEqual(x.open('a1').map((i) => i.payload.reply), ['Three', 'Four', 'Five'])
})

test('the done card of a question auto-answer counts towards the cap and is trimmed like any other', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const x = setup({ options: { keepDone: 1 } })
  await x.done('a1', 'Result 1')
  const first = x.open('a1')[0]
  void x.fire('user-questions/request', { agent: x.agent('a1'), questions: [{ id: 'q', question: 'Q?', options: [{ label: 'A (Recommended)' }] }], wait: { callId: 'c1', timed: true } }, () => new Promise(() => {}))
  t.mock.timers.tick(110_000)
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  assert.equal(x.real.get(first.id).resolution?.kind, 'trimmed', 'the older done card made room for the auto-answer card')
  assert.deepEqual(x.open('a1').filter((i) => i.type === 'completed').map((i) => i.title), ['Question auto-answered'])
})

test('an invalid keepDone falls back to 20', async () => {
  for (const bad of [0, -1, 'x', Number.NaN, 1.5]) {
    const x = setup({ options: { keepDone: bad } })
    for (let i = 1; i <= 21; i++) await x.done('a1', 'R' + i)
    assert.equal(x.open('a1').length, 20, String(bad))
  }
})

// ---- the pre-step check is cheap ----
test('agent/pre-step does not clone the store: list() is never called and no item is copied', async (t) => {
  const calls = []
  const x = setup({ wrap: (s) => ({ ...s, list: (...a) => { calls.push(a); return s.list(...a) } }) })
  for (let i = 0; i < 30; i++) await x.done('s' + (i % 10), 'R' + i)
  await x.done('a1', 'mine')
  calls.length = 0
  const spy = t.mock.method(globalThis, 'structuredClone')
  await x.preStep('a1', [{ role: 'user', source: { kind: 'goal' }, content: 'goal round' }])
  await x.preStep('a1', [{ role: 'user', content: 'thanks' }])
  const clones = spy.mock.callCount() // read before this test's own list() calls below
  spy.mock.restore()
  assert.equal(clones, 0, 'no structuredClone in the step handler')
  assert.deepEqual(calls, [], 'store.list was not called by the step handler')
  assert.equal(x.open('a1').length, 0, 'the injected message closed nothing, the human message closed the done card')
  assert.equal(x.open('s3').length, 3, 'other sessions untouched')
})

test('agent/pre-step still answers a question for the session and closes its done card on a store without peekOpen', async () => {
  const x = setup({ wrap: (s) => ({ ...s, peekOpen: undefined }) })
  await x.done('a1', 'mine')
  void x.fire('user-questions/request', { agent: x.agent('a1'), questions: [{ id: 'q', question: 'Q?', options: [{ label: 'A' }] }], wait: { callId: 'c1', timed: true } }, () => new Promise(() => {}))
  await x.preStep('a1', [{ role: 'user', content: 'use A' }])
  assert.equal(x.open('a1').length, 0)
  assert.deepEqual(x.real.list({ status: 'resolved' }).map((i) => i.resolution.kind).sort(), ['answered', 'replied'])
})

// ---- the trim waits for the summarizer's verdict (a card hidden as no-action must not push a real one out) ----
const tick = () => new Promise((r) => setImmediate(r))
const real = (reply) => ({ text: 'S', source: 'llm', actionable: !/hidden/.test(reply) })
const trimmedOf = (x) => x.real.list({ status: 'resolved' }).filter((i) => i.resolution.kind === 'trimmed')

test('20 real done cards and a 21st that is hidden as no-action: no card is trimmed', async () => {
  const x = setup({ options: { summarizer: { summarize: async (reply) => real(reply) } } })
  for (let i = 1; i <= 20; i++) await x.done('a1', 'Result ' + i)
  await x.done('a1', 'Result 21 hidden')
  assert.equal(x.open('a1').length, 20)
  assert.deepEqual(trimmedOf(x), [])
  assert.ok(!x.logs.some((l) => /trimmed/i.test(l)), x.logs.join(' | '))
  assert.equal(x.real.list({ status: 'resolved' }).filter((i) => i.resolution.kind === 'no-action').length, 1)
})

test('20 real done cards and a 21st that is kept: the oldest is trimmed after the verdict', async () => {
  const x = setup({ options: { summarizer: { summarize: async (reply) => real(reply) } } })
  for (let i = 1; i <= 20; i++) await x.done('a1', 'Result ' + i)
  const oldest = x.open('a1')[0]
  await x.done('a1', 'Result 21')
  assert.equal(x.open('a1').length, 20)
  assert.deepEqual(trimmedOf(x).map((i) => i.id), [oldest.id])
})

test('while the verdict of the 21st card is pending nothing is trimmed; its verdict then decides', async () => {
  for (const hidden of [true, false]) {
    let release
    const summarize = async (reply) => (reply === 'Result 21' ? new Promise((r) => { release = r }) : real(reply))
    const x = setup({ options: { summarizer: { summarize } } })
    for (let i = 1; i <= 20; i++) await x.done('a1', 'Result ' + i)
    await x.done('a1', 'Result 21')
    assert.equal(x.open('a1').length, 21, 'no verdict yet: nothing was pushed out')
    assert.deepEqual(trimmedOf(x), [])
    release({ text: 'S', source: 'llm', actionable: !hidden })
    await tick(); await tick()
    assert.equal(x.open('a1').length, 20, String(hidden))
    assert.equal(trimmedOf(x).length, hidden ? 0 : 1, String(hidden))
  }
})

test('a summarizer that fails still lets the cap apply (the card is kept with its fallback summary)', async () => {
  const x = setup({ options: { keepDone: 2, summarizer: { summarize: async () => { throw new Error('llm down') } } } })
  for (let i = 1; i <= 3; i++) await x.done('a1', 'R' + i)
  await tick()
  assert.deepEqual(x.open('a1').map((i) => i.payload.reply), ['R2', 'R3'])
  assert.deepEqual(trimmedOf(x).map((i) => i.payload.reply), ['R1'])
})

test('memory stays bounded when verdicts never arrive: at twice the cap the oldest still goes', async () => {
  const x = setup({ options: { keepDone: 2, summarizer: { summarize: () => new Promise(() => {}) } } })
  for (let i = 1; i <= 6; i++) await x.done('a1', 'R' + i)
  assert.deepEqual(x.open('a1').map((i) => i.payload.reply), ['R3', 'R4', 'R5', 'R6'])
})

test('a trimmed card records the limit that hid it', async () => {
  const x = setup({ options: { keepDone: 2 } })
  for (let i = 1; i <= 3; i++) await x.done('a1', 'R' + i)
  assert.equal(trimmedOf(x)[0].resolution.limit, 2)
})
