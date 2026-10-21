import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { installCapture } from '../capture.js'

// Done cards and questions must not disappear from the open list on their own:
//  A1  a done card closes only on a user-source message of its session (no source, or source.kind 'user': any message DSH did not
//      inject itself), never on a message DSH injected (goal, schedule, plan-mode, ...) or a reply to a question.
//  A4  every automatic close writes a log line with its reason.
function setup({ summary = { text: 'Did it.', source: 'llm' }, titles = { a1: 'Session One' } } = {}) {
  const handlers = {}
  const logs = []
  const ctx = {
    on: (name, fn) => { handlers[name] = fn },
    get: (name) => (name === 'sessionTitle' ? { get: (session) => ({ title: titles[session.id] }) } : undefined),
    logger: { warn() {}, info() {} },
  }
  let t = 1000
  let n = 0
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  installCapture(ctx, { store, summarizer: { summarize: async () => summary }, log: (line) => logs.push(line) })
  const agent = (id = 'a1', reply = 'All done.') => ({
    id,
    session: { id, header: { cwd: 'D:/proj' }, deriveMessages: () => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: reply }] }] },
  })
  const fire = (name, ...args) => handlers[name](...args)
  const preStep = (id, messages) => fire('agent/pre-step', { agent: agent(id), messages }, async () => ({ kind: 'enter', messages: [] }))
  return { store, logs, agent, fire, preStep }
}

const QUESTIONS = [{ id: 'q1', question: 'Which port?', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }]
const never = () => new Promise(() => {})
const settle = () => new Promise((r) => setTimeout(r, 10))

// ---- A1: only a user-source message closes a done card (real DSH message source kinds) ----
for (const source of [{ kind: 'goal' }, { kind: 'schedule' }, { kind: 'user-approval' }, { kind: 'plan-mode' }, { kind: 'cordis-host-runner' }]) {
  test('an injected "' + source.kind + '" message alone does not close the done card of its session', async () => {
    const x = setup()
    await x.fire('agent/turn-stopping', { agent: x.agent('a1', 'Pushed the branch.') })
    await x.preStep('a1', [{ role: 'user', source, content: 'injected context' }])
    assert.equal(x.store.snapshot().open.length, 1, 'the done card is still open')
    assert.equal(x.store.snapshot().open[0].type, 'completed')
    assert.equal(x.store.snapshot().resolved.length, 0)
  })
}

// The host stamps every sessionController.prompt as source { kind: 'user', rpcId: <the requestId> } (session-controller commands.ts), so a
// prompt this plugin family sent itself is told apart by the id it chose: pr-poll-, resume-, todo-, handoff-, onhold- are not the user typing.
// review- (a reply from the card) and voice- (a spoken reply) are user-driven and stay human.
for (const prefix of ['pr-poll-', 'resume-', 'todo-', 'handoff-', 'onhold-']) {
  test('a plugin-sent prompt (rpcId "' + prefix + '...") does not close the done card nor the open question of its session', async () => {
    const x = setup()
    await x.fire('agent/turn-stopping', { agent: x.agent('a1', 'Pushed the branch.') })
    void x.fire('user-questions/request', { agent: x.agent('a1'), questions: QUESTIONS, wait: { callId: 'c1', timed: true } }, never)
    await x.preStep('a1', [{ role: 'user', source: { kind: 'user', rpcId: prefix + '1b2c3d' }, content: 'plugin text' }])
    assert.deepEqual(x.store.snapshot().open.map((i) => i.type).sort(), ['completed', 'question'], 'both stay open')
    assert.equal(x.store.snapshot().resolved.length, 0)
    assert.ok(!x.logs.some((l) => /closed/.test(l)), x.logs.join(' | '))
  })
}

for (const rpcId of ['review-ab12cd34', 'voice-ab12cd34', '5f0e4c1e-9a3b-4d7a-8f21-0c6d1e2b3a45']) {
  test('a user prompt (rpcId "' + rpcId + '") closes the done card as replied in the session', async () => {
    const x = setup()
    await x.fire('agent/turn-stopping', { agent: x.agent('a1', 'Pushed the branch.') })
    await x.preStep('a1', [{ role: 'user', source: { kind: 'user', rpcId }, content: 'now the docs' }])
    assert.equal(x.store.snapshot().open.length, 0)
    assert.deepEqual({ kind: x.store.snapshot().resolved[0].resolution.kind, by: x.store.snapshot().resolved[0].resolution.by }, { kind: 'replied', by: 'session' })
  })
}

test('a real user message closes the open question of its session too (answered in the session)', async () => {
  const x = setup()
  void x.fire('user-questions/request', { agent: x.agent('a1'), questions: QUESTIONS, wait: { callId: 'c1', timed: true } }, never)
  const [q] = x.store.snapshot().open
  await x.preStep('a1', [{ role: 'user', source: { kind: 'user', rpcId: 'ab12cd34-0000-4000-8000-000000000000' }, content: 'use B' }])
  assert.equal(x.store.get(q.id).resolution.kind, 'answered')
})

test('a plugin-sent prompt next to a real user message in one step still closes the done card (the user did write)', async () => {
  const x = setup()
  await x.fire('agent/turn-stopping', { agent: x.agent('a1', 'Pushed the branch.') })
  await x.preStep('a1', [{ role: 'user', source: { kind: 'user', rpcId: 'resume-1' }, content: 'resume' }, { role: 'user', source: { kind: 'user', rpcId: 'u-2' }, content: 'and also the docs' }])
  assert.equal(x.store.snapshot().open.length, 0)
})

test('a reply to a question alone does not close a done card of the session', async () => {
  const x = setup()
  await x.fire('agent/turn-stopping', { agent: x.agent('a1', 'Pushed the branch.') })
  await x.preStep('a1', [{ role: 'user', source: { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' }, content: 'answered' }])
  assert.deepEqual(x.store.snapshot().open.map((i) => i.type), ['completed'])
})

for (const [label, message] of [['no source', { role: 'user', content: 'next please' }], ['source user', { role: 'user', source: { kind: 'user' }, content: 'next please' }]]) {
  test('a user-source message (' + label + ') closes the done card as replied in the session', async () => {
    const x = setup()
    await x.fire('agent/turn-stopping', { agent: x.agent('a1', 'Pushed the branch.') })
    await x.preStep('a1', [message])
    assert.equal(x.store.snapshot().open.length, 0)
    const [r] = x.store.snapshot().resolved
    assert.deepEqual({ kind: r.resolution.kind, by: r.resolution.by }, { kind: 'replied', by: 'session' })
  })
}

test('a user-source message among injected ones closes the done card, and only the done cards of that session', async () => {
  const x = setup()
  await x.fire('agent/turn-stopping', { agent: x.agent('a1', 'First.') })
  await x.fire('agent/turn-stopping', { agent: x.agent('a2', 'Other session.') })
  await x.preStep('a1', [{ role: 'user', source: { kind: 'goal' }, content: 'goal round' }, { role: 'user', content: 'thanks, now the docs' }])
  assert.deepEqual(x.store.snapshot().open.map((i) => i.sessionId), ['a2'])
  assert.equal(x.store.snapshot().resolved[0].resolution.kind, 'replied')
})

// ---- A4: every automatic close says why ----
test('closing a done card because the user replied logs its title and the reason', async () => {
  const x = setup({ summary: { text: 'Did it.', title: 'Fix login', source: 'llm' } })
  await x.fire('agent/turn-stopping', { agent: x.agent('a1', 'Fixed login.') })
  await settle()
  await x.preStep('a1', [{ role: 'user', content: 'looks good, now the docs' }])
  assert.ok(x.logs.includes('capture: done item "Fix login" closed: the user replied in the session'), x.logs.join(' | '))
})

test('a done card with no title is logged by its session title', async () => {
  const x = setup({ summary: { text: 'Did it.', source: 'fallback' } })
  await x.fire('agent/turn-stopping', { agent: x.agent('a1', 'Fixed login.') })
  await x.preStep('a1', [{ role: 'user', content: 'next' }])
  assert.ok(x.logs.includes('capture: done item "Session One" closed: the user replied in the session'), x.logs.join(' | '))
})

test('no close line is written while the done card stays open', async () => {
  const x = setup()
  await x.fire('agent/turn-stopping', { agent: x.agent('a1', 'Fixed login.') })
  await x.preStep('a1', [{ role: 'user', source: { kind: 'schedule' }, content: 'x' }])
  assert.ok(!x.logs.some((l) => /closed/.test(l)), x.logs.join(' | '))
})

test('a question the user answered by writing in the session is closed with a log line naming the item and the reason', async () => {
  const x = setup()
  void x.fire('user-questions/request', { agent: x.agent('a1'), questions: QUESTIONS, wait: { callId: 'c1', timed: true } }, never)
  const [q] = x.store.snapshot().open
  await x.preStep('a1', [{ role: 'user', content: 'use B please' }])
  assert.equal(x.store.get(q.id).resolution.kind, 'answered')
  const line = x.logs.find((l) => l.includes(q.id) && /closed/i.test(l))
  assert.ok(line, x.logs.join(' | '))
  assert.match(line, /session/i)
  assert.match(line, /^capture: question /)
})

test('a permission request cancelled by an abort logs its item id and the reason', async () => {
  const x = setup()
  const ac = new AbortController()
  const p = x.fire('approval/request', { agent: x.agent('a1'), toolName: 'shell', callId: 'p1', signal: ac.signal }, never)
  const [item] = x.store.snapshot().open
  ac.abort()
  assert.equal(await p, 'cancelled')
  const line = x.logs.find((l) => l.includes(item.id))
  assert.ok(line, x.logs.join(' | '))
  assert.match(line, /^capture: permission /)
  assert.match(line, /cancelled/)
  assert.match(line, /abort/i)
})

test('a permission request whose handling failed logs its item id, the reason and the error text', async () => {
  const x = setup()
  const p = x.fire('approval/request', { agent: x.agent('a1'), toolName: 'shell', callId: 'p1' }, async () => { throw new Error('answerer broke') })
  const [item] = x.store.snapshot().open
  await assert.rejects(p, /answerer broke/)
  assert.equal(x.store.get(item.id).resolution.kind, 'cancelled')
  const line = x.logs.find((l) => l.includes(item.id))
  assert.ok(line, x.logs.join(' | '))
  assert.match(line, /^capture: permission /)
  assert.match(line, /cancelled/)
  assert.match(line, /answerer broke/)
})

test('the session ending logs how many items it closed and for which session', async () => {
  const x = setup()
  await x.fire('agent/turn-stopping', { agent: x.agent('sess-77', 'One.') })
  await x.fire('agent/turn-stopping', { agent: x.agent('sess-77', 'Two.') })
  void x.fire('user-questions/request', { agent: x.agent('sess-77'), questions: QUESTIONS, wait: { callId: 'c1' } }, never)
  await x.fire('agent/turn-stopping', { agent: x.agent('sess-99', 'Another session.') })
  x.fire('agent/disposed', { agent: x.agent('sess-77') })
  assert.equal(x.store.snapshot().open.length, 1, 'only the other session keeps its card')
  const line = x.logs.find((l) => l.includes('sess-77'))
  assert.ok(line, x.logs.join(' | '))
  assert.match(line, /^capture: /)
  assert.match(line, /\b3\b/, 'the number of closed items')
  assert.match(line, /session-ended|ended/i)
  assert.ok(!x.logs.some((l) => l.includes('sess-99')), 'the other session is not mentioned')
})
