import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { installCapture, summarizeTool, cancelStalePending } from '../capture.js'

function setup({ summary = { text: 'Did it.', source: 'llm' }, titles = { a1: 'Session One' }, services = {} } = {}) {
  const handlers = {}
  const ctx = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn) },
    get: (name) => (name === 'sessionTitle' ? { get: (session) => ({ title: titles[session.id] }) } : services[name]),
    logger: { warn() {}, info() {} },
  }
  let t = 1000
  let n = 0
  const store = createStore({ now: () => ++t, uuid: () => 'i' + ++n })
  const summarizer = { summarize: async () => summary }
  const capture = installCapture(ctx, { store, summarizer })
  const agent = (id = 'a1', reply = 'All done.') => ({
    id,
    session: { id, header: { cwd: 'D:/proj' }, deriveMessages: () => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: reply }] }] },
  })
  const fire = (name, ...args) => handlers[name][0](...args)
  return { ctx, store, capture, agent, fire, handlers }
}

const QUESTIONS = [{ id: 'q1', question: 'Which port?', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }]
const never = () => new Promise(() => {})

test('a question request becomes an open item with its choices and session info', async () => {
  const { store, fire, agent } = setup()
  fire('user-questions/request', { agent: agent(), questions: QUESTIONS, wait: { callId: 'c1', timed: true } }, never)
  const [item] = store.snapshot().open
  assert.equal(item.type, 'question')
  assert.equal(item.sessionId, 'a1')
  assert.equal(item.sessionTitle, 'Session One')
  assert.equal(item.key, 'c1')
  assert.deepEqual(item.payload.questions[0].options.map((o) => o.label), ['A (Recommended)', 'B'])
})

test('timeout seconds noted from ask_user_question give the item an expiry time', async () => {
  const { store, fire, agent } = setup()
  await fire('tools/pre-execute', { name: 'ask_user_question', callId: 'c1', arguments: { timeout: 120 }, agent: agent() }, async () => ({ kind: 'continue' }))
  fire('user-questions/request', { agent: agent(), questions: QUESTIONS, wait: { callId: 'c1', timed: true } }, never)
  const [item] = store.snapshot().open
  const left = item.expiresAt - Date.now()
  assert.ok(left > 119_000 && left <= 120_000, 'expires in about 120 s, got ' + left)
})

test('answering from the card settles the request and resolves the item', async () => {
  const { store, fire, agent, capture } = setup()
  const p = fire('user-questions/request', { agent: agent(), questions: QUESTIONS, wait: { callId: 'c1' } }, never)
  const [item] = store.snapshot().open
  const r = capture.answerQuestion(item.id, [{ id: 'q1', selected: ['B'] }])
  assert.equal(r.ok, true)
  assert.deepEqual(await p, { answers: [{ id: 'q1', selected: ['B'] }] })
  assert.equal(store.get(item.id).resolution.kind, 'answered')
  assert.equal(store.get(item.id).resolution.by, 'card')
})

test('an answer that names an unknown option or a missing question is refused and nothing changes', async () => {
  const { store, fire, agent, capture } = setup()
  fire('user-questions/request', { agent: agent(), questions: QUESTIONS, wait: { callId: 'c1' } }, never)
  const [item] = store.snapshot().open
  assert.equal(capture.answerQuestion(item.id, [{ id: 'q1', selected: ['Z'] }]).ok, false)
  assert.equal(capture.answerQuestion(item.id, []).ok, false)
  assert.equal(capture.answerQuestion(item.id, [{ id: 'q1', selected: [], custom: 'free text' }]).ok, true)
})

test('answering twice, or an unknown item, is refused', async () => {
  const { store, fire, agent, capture } = setup()
  fire('user-questions/request', { agent: agent(), questions: QUESTIONS, wait: { callId: 'c1' } }, never)
  const [item] = store.snapshot().open
  assert.equal(capture.answerQuestion(item.id, [{ id: 'q1', selected: ['A (Recommended)'] }]).ok, true)
  assert.equal(capture.answerQuestion(item.id, [{ id: 'q1', selected: ['B'] }]).ok, false)
  assert.equal(capture.answerQuestion('nope', []).ok, false)
})

test('an answer given on screen resolves the item as answered on screen', async () => {
  const { store, fire, agent } = setup()
  const answers = { answers: [{ id: 'q1', selected: ['B'] }] }
  const result = await fire('user-questions/request', { agent: agent(), questions: QUESTIONS, wait: { callId: 'c1' } }, async () => answers)
  assert.equal(result, answers)
  const [r] = store.snapshot().resolved
  assert.equal(r.resolution.by, 'screen')
  assert.deepEqual(r.resolution.answers, answers.answers)
})

test('a timed-out question expires with the recommended option noted, and the timeout still reaches DSH', async () => {
  const { store, fire, agent } = setup()
  const ac = new AbortController()
  const p = fire('user-questions/request', { agent: agent(), questions: QUESTIONS, signal: ac.signal, wait: { callId: 'c1', timed: true } }, never)
  const reason = Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' })
  ac.abort(reason)
  await assert.rejects(p, (e) => e === reason)
  const [r] = store.snapshot().resolved
  assert.equal(r.resolution.kind, 'expired')
  assert.deepEqual(r.resolution.assumed, ['A (Recommended)'])
})

test('a timeout rejection from the screen answerer also expires the item', async () => {
  const { store, fire, agent } = setup()
  const reason = Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' })
  await assert.rejects(fire('user-questions/request', { agent: agent(), questions: QUESTIONS, wait: { callId: 'c1' } }, async () => { throw reason }))
  assert.equal(store.snapshot().resolved[0].resolution.kind, 'expired')
})

test('an aborted question that is not a timeout is cancelled, not expired', async () => {
  const { store, fire, agent } = setup()
  const ac = new AbortController()
  const p = fire('user-questions/request', { agent: agent(), questions: QUESTIONS, signal: ac.signal }, never)
  ac.abort()
  await assert.rejects(p)
  assert.equal(store.snapshot().resolved[0].resolution.kind, 'cancelled')
})

test('subagent questions are passed through untouched', async () => {
  const { store, fire, agent } = setup()
  fire('subagent/start', { id: 'kid' })
  const sentinel = { answers: [] }
  assert.equal(await fire('user-questions/request', { agent: agent('kid'), questions: QUESTIONS }, async () => sentinel), sentinel)
  assert.equal(store.list().length, 0)
})

test('a store failure never blocks the request: next() still runs', async () => {
  const { store, fire, agent } = setup()
  store.add = () => { throw new Error('boom') }
  const sentinel = { answers: [] }
  assert.equal(await fire('user-questions/request', { agent: agent(), questions: QUESTIONS }, async () => sentinel), sentinel)
})

test('summarizeTool picks the most telling argument and caps it', () => {
  assert.equal(summarizeTool('shell', { command: 'git push origin main' }), 'shell: git push origin main')
  assert.equal(summarizeTool('write', { file_path: 'D:/a/b.md', content: 'x' }), 'write: D:/a/b.md')
  assert.equal(summarizeTool('mystery', { foo: 1 }), 'mystery')
  assert.ok(summarizeTool('shell', { command: 'x'.repeat(1000) }).length < 260)
})

test('a permission request becomes an item; approve/deny from the card settle it', async () => {
  const { store, fire, agent, capture } = setup()
  await fire('tools/pre-execute', { name: 'shell', callId: 'p1', arguments: { command: 'rm -rf build' }, agent: agent() }, async () => ({ kind: 'continue' }))
  const p = fire('approval/request', { agent: agent(), toolName: 'shell', callId: 'p1', reason: 'needs approval' }, never)
  const [item] = store.snapshot().open
  assert.equal(item.type, 'permission')
  assert.equal(item.payload.summary, 'shell: rm -rf build')
  assert.equal(capture.decidePermission(item.id, 'approve').ok, true)
  assert.equal(await p, 'allowed-once')
  assert.equal(store.get(item.id).resolution.kind, 'approved')
})

test('deny resolves as rejected; the screen answering first resolves by screen; abort cancels', async () => {
  const { store, fire, agent, capture } = setup()
  const p1 = fire('approval/request', { agent: agent(), toolName: 'shell', callId: 'p1' }, never)
  const [i1] = store.snapshot().open
  capture.decidePermission(i1.id, 'deny')
  assert.equal(await p1, 'rejected')
  assert.equal(store.get(i1.id).resolution.kind, 'denied')

  assert.equal(await fire('approval/request', { agent: agent(), toolName: 'write', callId: 'p2' }, async () => 'allowed-once'), 'allowed-once')
  assert.equal(store.snapshot().resolved[0].resolution.by, 'screen')

  const ac = new AbortController()
  const p3 = fire('approval/request', { agent: agent(), toolName: 'write', callId: 'p3', signal: ac.signal }, never)
  ac.abort()
  assert.equal(await p3, 'cancelled')
  assert.equal(store.snapshot().resolved[0].resolution.kind, 'cancelled')
})

test('decidePermission refuses an invalid decision or a non-permission item', async () => {
  const { store, fire, agent, capture } = setup()
  fire('user-questions/request', { agent: agent(), questions: QUESTIONS }, never)
  const [q] = store.snapshot().open
  assert.equal(capture.decidePermission(q.id, 'approve').ok, false)
  assert.equal(capture.decidePermission(q.id, 'maybe').ok, false)
})

test('a finished turn becomes a completed item; the summary arrives afterwards', async () => {
  const { store, fire, agent } = setup()
  await fire('agent/turn-stopping', { agent: agent('a1', 'Refactored auth.\n\nTests pass.') })
  const [item] = store.snapshot().open
  assert.equal(item.type, 'completed')
  assert.equal(item.sessionTitle, 'Session One')
  assert.equal(item.payload.reply, 'Refactored auth.\n\nTests pass.')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(store.get(item.id).summary, 'Did it.')
  assert.equal(store.get(item.id).summarySource, 'llm')
})

test('an empty reply and subagent turns create no item', async () => {
  const { store, fire, agent } = setup()
  await fire('agent/turn-stopping', { agent: agent('a1', '   ') })
  fire('subagent/start', { id: 'kid' })
  await fire('agent/turn-stopping', { agent: agent('kid', 'done') })
  assert.equal(store.list().length, 0)
})

test('the user continuing the session resolves its open completed items as replied', async () => {
  const { store, fire, agent } = setup()
  await fire('agent/turn-stopping', { agent: agent('a1', 'Done.') })
  await fire('agent/pre-step', { agent: agent(), messages: [{ role: 'user', content: 'next please' }] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(store.snapshot().open.length, 0)
  assert.equal(store.snapshot().resolved[0].resolution.kind, 'replied')
})

test('a step with no new user message leaves completed items alone', async () => {
  const { store, fire, agent } = setup()
  await fire('agent/turn-stopping', { agent: agent('a1', 'Done.') })
  await fire('agent/pre-step', { agent: agent(), messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(store.snapshot().open.length, 1)
})

test('disposing a session ends all its open items', async () => {
  const { store, fire, agent } = setup()
  await fire('agent/turn-stopping', { agent: agent('a1', 'Done.') })
  fire('user-questions/request', { agent: agent(), questions: QUESTIONS }, never)
  fire('agent/disposed', { agent: agent() })
  assert.equal(store.snapshot().open.length, 0)
  assert.ok(store.snapshot().resolved.every((i) => i.resolution.kind === 'session-ended' || i.resolution.kind === 'cancelled'))
})

test('after a restart, stale questions and permissions are cancelled but finished work stays', () => {
  const store = createStore()
  store.add({ type: 'question', sessionId: 's', payload: {} })
  store.add({ type: 'permission', sessionId: 's', payload: {} })
  store.add({ type: 'completed', sessionId: 's', payload: {} })
  assert.equal(cancelStalePending(store), 2)
  assert.deepEqual(store.snapshot().open.map((i) => i.type), ['completed'])
  assert.equal(store.snapshot().resolved[0].resolution.by, 'restart')
})

test('the registered handlers are exposed by name for the dev route', () => {
  const { capture } = setup()
  assert.equal(typeof capture.handlers['user-questions/request'], 'function')
  assert.equal(typeof capture.handlers['agent/turn-stopping'], 'function')
})

// ---- late answers to expired questions ----
async function expired(opts) {
  const x = setup(opts)
  const ac = new AbortController()
  const ag = x.agent()
  const p = x.fire('user-questions/request', { agent: ag, questions: QUESTIONS, signal: ac.signal, wait: { callId: 'c1', timed: true } }, never)
  ac.abort(Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' }))
  await p.catch(() => {})
  return { ...x, ag, id: x.store.snapshot().resolved[0].id }
}
const liveServices = (answer) => { const calls = []; return { calls, services: { agents: { get: (id) => (id === 'a1' ? { id } : undefined) }, userQuestions: { answer: async (agent, callId, body) => { calls.push([agent.id, callId, body]); return answer ? answer() : true } } } } }

test('a late answer that differs from the default is sent into the session and recorded', async () => {
  const live = liveServices()
  const { capture, store, id } = await expired({ services: live.services })
  assert.deepEqual(await capture.lateAnswerQuestion(id, [{ id: 'q1', selected: ['B'] }]), { ok: true, sent: true })
  assert.deepEqual(live.calls, [['a1', 'c1', { answers: [{ id: 'q1', selected: ['B'] }] }]])
  const r = store.get(id).resolution
  assert.equal(r.kind, 'late-answered'); assert.equal(r.by, 'card'); assert.deepEqual(r.assumed, ['A (Recommended)'])
})

test('a late answer equal to the default is only confirmed: nothing is sent', async () => {
  const live = liveServices()
  const { capture, store, id } = await expired({ services: live.services })
  assert.deepEqual(await capture.lateAnswerQuestion(id, [{ id: 'q1', selected: ['A (Recommended)'] }]), { ok: true, sent: false })
  assert.equal(live.calls.length, 0)
  assert.equal(store.get(id).resolution.kind, 'confirmed')
  assert.equal((await capture.lateAnswerQuestion(id, [{ id: 'q1', selected: ['B'] }])).error, 'not-expired') // settled now
})

test('late answers refuse anything that is not an expired question, bad answers, a gone session and a closed question', async () => {
  const live = liveServices()
  const x = await expired({ services: live.services })
  assert.equal((await x.capture.lateAnswerQuestion('nope', [])).error, 'not-expired')
  assert.equal((await x.capture.lateAnswerQuestion(x.id, [{ id: 'q1', selected: ['Z'] }])).error, 'bad-answer')
  assert.equal((await x.capture.lateAnswerQuestion(x.id, [])).error, 'bad-answer')
  const none = await expired({})
  assert.equal((await none.capture.lateAnswerQuestion(none.id, [{ id: 'q1', selected: ['B'] }])).error, 'no-session')
  const closed = liveServices(() => false)
  const y = await expired({ services: closed.services })
  assert.equal((await y.capture.lateAnswerQuestion(y.id, [{ id: 'q1', selected: ['B'] }])).error, 'not-pending')
  assert.equal(y.store.get(y.id).resolution.kind, 'expired') // still expired: nothing was delivered
  const queued = liveServices(() => { throw Object.assign(new Error('queued'), { code: 'REPLY_QUEUED' }) })
  const z = await expired({ services: queued.services })
  assert.equal((await z.capture.lateAnswerQuestion(z.id, [{ id: 'q1', selected: ['B'] }])).error, 'reply-queued')
})

test('the last user message of the turn is kept as the request and the model title is stored', async () => {
  const { store, fire, agent } = setup({ summary: { text: 'Did it.', title: 'Fix the login', source: 'llm' } })
  const a = agent('a1', 'Refactored auth.')
  a.session.deriveMessages = () => [{ role: 'user', content: 'older' }, { role: 'assistant', content: 'x' }, { role: 'user', content: [{ type: 'text', text: 'Please fix the login bug' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Refactored auth.' }] }]
  await fire('agent/turn-stopping', { agent: a })
  const [item] = store.snapshot().open
  assert.equal(item.payload.request, 'Please fix the login bug')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(store.get(item.id).title, 'Fix the login')
})

test('the summarizer is given the request, and a turn without a user message still works', async () => {
  const seen = []
  const { store, fire, agent } = setup()
  // swap in a recording summarizer through a fresh setup
  const handlers = {}
  const ctx = { on: (n, f) => { handlers[n] = f }, get: () => undefined, logger: { warn() {}, info() {} } }
  const st = createStore({ now: () => 1, uuid: () => 'z1' })
  installCapture(ctx, { store: st, summarizer: { summarize: async (reply, opts) => { seen.push(opts.request); return { text: 's', source: 'llm' } } } })
  await handlers['agent/turn-stopping']({ agent: { id: 'a', session: { deriveMessages: () => [{ role: 'assistant', content: 'only reply' }] } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(seen, [''])
  assert.equal(st.snapshot().open[0].payload.request, undefined)
  void store; void fire; void agent
})
