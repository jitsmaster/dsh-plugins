import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { installCapture, summarizeTool, cancelStalePending } from '../capture.js'

function setup({ summary = { text: 'Did it.', source: 'llm' }, titles = { a1: 'Session One' }, services = {}, log, now } = {}) {
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
  const capture = installCapture(ctx, { store, summarizer, ...(log ? { log } : {}), ...(now ? { now } : {}) })
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

test('an aborted question that is not a timeout stays open as detached, and the abort still reaches DSH', async () => {
  const { store, fire, agent } = setup()
  const ac = new AbortController()
  const p = fire('user-questions/request', { agent: agent(), questions: QUESTIONS, signal: ac.signal }, never)
  ac.abort()
  await assert.rejects(p)
  assert.equal(store.snapshot().resolved.length, 0)
  const [item] = store.snapshot().open
  assert.equal(item.type, 'question')
  assert.equal(item.detached, true)
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

test('a permission item keeps the full command and the path of the tool call', async () => {
  const { store, fire, agent } = setup()
  const a = agent('a1')
  const long = 'git commit -m "' + 'x'.repeat(300) + '"'
  await fire('tools/pre-execute', { name: 'shell', callId: 'c9', arguments: { command: long } }, async () => ({}))
  void fire('approval/request', { agent: a, toolName: 'shell', callId: 'c9' }, never)
  const [item] = store.snapshot().open
  assert.equal(item.payload.detail, long)
  assert.ok(item.payload.summary.length < long.length)
  await fire('tools/pre-execute', { name: 'write', callId: 'c10', arguments: { file_path: 'D:/x/a.md', content: 'hi' } }, async () => ({}))
  void fire('approval/request', { agent: a, toolName: 'write', callId: 'c10' }, never)
  assert.equal(store.snapshot().open[1].payload.path, 'D:/x/a.md')
})

test('a newer result from the same session leaves the older unreviewed ones open: nothing is replaced', async () => {
  const { store, fire, agent } = setup()
  await fire('agent/turn-stopping', { agent: agent('a1', 'First result.') })
  await fire('agent/turn-stopping', { agent: agent('a1', 'Second result.') })
  await fire('agent/turn-stopping', { agent: agent('a2', 'Other session.') })
  const snap = store.snapshot()
  assert.deepEqual(snap.open.map((i) => i.payload.reply), ['First result.', 'Second result.', 'Other session.'])
  assert.equal(snap.resolved.length, 0)
  assert.ok(snap.open.every((i) => i.earlier === undefined), 'no card claims to replace earlier results')
})

// ---- RULE 1: done items with nothing for the user are hidden at capture time ----
const settle = () => new Promise((r) => setTimeout(r, 10))

test('a no-action verdict moves the done item to Resolved with the verdict kept, and logs it', async () => {
  const logs = []
  const handlers = {}
  const ctx = { on: (n, f) => { handlers[n] = f }, get: () => undefined }
  let n = 0
  const store = createStore({ now: () => 1000, uuid: () => 'h' + ++n })
  installCapture(ctx, { store, log: (l) => logs.push(l), summarizer: { summarize: async () => ({ text: 'Renamed the helper.', title: 'Rename helper', source: 'llm', actionable: false }) } })
  await handlers['agent/turn-stopping']({ agent: { id: 'a1', session: { deriveMessages: () => [{ role: 'user', content: 'rename it' }, { role: 'assistant', content: 'Done: renamed the helper, all 120 tests pass, committed.' }] } } })
  await settle()
  assert.equal(store.snapshot().open.length, 0)
  const [r] = store.snapshot().resolved
  assert.deepEqual({ kind: r.resolution.kind, by: r.resolution.by }, { kind: 'no-action', by: 'auto' })
  assert.equal(r.actionable, false)
  assert.equal(r.summary, 'Renamed the helper.')
  assert.equal(r.title, 'Rename helper')
  assert.ok(logs.some((l) => /hid|hidden/i.test(l) && /Rename helper/.test(l)), logs.join('|'))
})

for (const [label, summary] of [['actionable true', { text: 'Did it.', source: 'llm', actionable: true }], ['no verdict', { text: 'Did it.', source: 'llm' }], ['fallback', { text: 'Did it.', source: 'fallback' }]]) {
  test('the item stays in the list with ' + label, async () => {
    const { store, fire, agent } = setup({ summary })
    await fire('agent/turn-stopping', { agent: agent('a1', 'Which one do you want?') })
    await settle()
    assert.equal(store.snapshot().open.length, 1)
    assert.equal(store.snapshot().open[0].actionable, summary.actionable)
  })
}

test('a summarizer that rejects leaves the item showing', async () => {
  const { store, fire, agent } = setup()
  const handlers = {}
  void store; void fire; void agent
  const ctx = { on: (n, f) => { handlers[n] = f }, get: () => undefined }
  const st = createStore()
  installCapture(ctx, { store: st, summarizer: { summarize: async () => { throw new Error('boom') } } })
  await handlers['agent/turn-stopping']({ agent: { id: 'a', session: { deriveMessages: () => [{ role: 'assistant', content: 'ok' }] } } })
  await settle()
  assert.equal(st.snapshot().open.length, 1)
})

test('an item the user already reviewed or replied to before the verdict is left alone', async () => {
  let verdict
  const handlers = {}
  const ctx = { on: (n, f) => { handlers[n] = f }, get: () => undefined }
  const st = createStore({ now: () => 1 })
  installCapture(ctx, { store: st, summarizer: { summarize: () => new Promise((r) => { verdict = r }) } })
  const a = { id: 'a1', session: { deriveMessages: () => [{ role: 'assistant', content: 'Done.' }] } }
  await handlers['agent/turn-stopping']({ agent: a })
  // the user continues the session before the (slow) verdict arrives: nothing to hide, the resolution stays
  await handlers['agent/pre-step']({ agent: a, messages: [{ role: 'user', content: 'next' }] }, async () => ({ kind: 'enter', messages: [] }))
  verdict({ text: 's', source: 'llm', actionable: false })
  await settle()
  assert.equal(st.snapshot().resolved[0].resolution.kind, 'replied')
})

test('hiding a done item still brings back older done items that legacy data records as superseded by it', async () => {
  const logs = []
  const handlers = {}
  const ctx = { on: (n, f) => { handlers[n] = f }, get: () => undefined }
  let n = 0
  let t = 1000
  const store = createStore({ now: () => ++t, uuid: () => 'u' + ++n })
  let verdict
  const gate = new Promise((resolve) => { verdict = resolve }) // the model's verdict arrives only after the legacy record is in place
  installCapture(ctx, { store, log: (l) => logs.push(l), summarizer: { summarize: async () => { await gate; return { text: 'Renamed.', source: 'llm', actionable: false } } } })
  await handlers['agent/turn-stopping']({ agent: { id: 'a1', session: { deriveMessages: () => [{ role: 'assistant', content: 'Done: renamed it, tests pass.' }] } } })
  const added = store.snapshot().open[0] // the new result: its id is read, not assumed
  const old = store.add({ type: 'completed', sessionId: 'a1', payload: { reply: 'Which port do you want?' } })
  assert.equal(store.resolve(old.id, { kind: 'superseded', by: 'newer', newerId: added.id }), true)
  verdict()
  await settle()
  const snap = store.snapshot()
  assert.deepEqual(snap.open.map((i) => i.payload.reply), ['Which port do you want?'])
  assert.equal(snap.resolved.find((i) => i.payload.reply === 'Done: renamed it, tests pass.').resolution.kind, 'no-action')
  assert.ok(logs.some((l) => /brought back 1/.test(l)), logs.join('|'))
})

// ---- RULE 2: a question handled in its own session leaves the list at once ----
const reply = (callId, answers, sessionId = 'a1') => ({ id: sessionId }, ({ type: 'user/message', data: { id: 'm1', source: { kind: 'user-question-reply', callId, outcome: 'answered' }, content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', callId, answers }) }] } }))
const sessionEvent = (x, sessionId, event) => x.fire('session/event', { id: sessionId }, event)
const toolResult = (callId, text) => ({ type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } } })
const openQuestion = (x, { callId = 'c1', sessionId = 'a1' } = {}) => {
  const p = x.fire('user-questions/request', { agent: x.agent(sessionId), questions: QUESTIONS, wait: { callId, timed: true } }, never)
  return { p, id: x.store.snapshot().open.at(-1).id }
}

test('the user answering in the question\'s own session (a question reply) resolves the open item at once', async () => {
  const x = setup()
  const { id } = openQuestion(x)
  sessionEvent(x, 'a1', reply('c1', [{ id: 'q1', selected: ['B'] }]))
  const it = x.store.get(id)
  assert.equal(it.status, 'resolved')
  assert.deepEqual({ kind: it.resolution.kind, by: it.resolution.by }, { kind: 'answered', by: 'session' })
  assert.deepEqual(it.resolution.answers, [{ id: 'q1', selected: ['B'] }])
  assert.equal(x.capture.answerQuestion(id, [{ id: 'q1', selected: ['B'] }]).error, 'not-pending') // the card can no longer answer it
})

test('a tool result for the question call resolves the open item, whatever answered it', async () => {
  const x = setup()
  const { id } = openQuestion(x)
  sessionEvent(x, 'a1', toolResult('c1', JSON.stringify({ answers: [{ id: 'q1', selected: ['A (Recommended)'] }] })))
  assert.equal(x.store.get(id).resolution.kind, 'answered')
  assert.equal(x.store.get(id).resolution.by, 'session')
})

test('a pending tool result means the wait timed out: the item expires with the recommended option', async () => {
  const x = setup()
  const { id } = openQuestion(x)
  sessionEvent(x, 'a1', toolResult('c1', JSON.stringify({ pending: true, callId: 'c1' })))
  assert.equal(x.store.get(id).resolution.kind, 'expired')
  assert.deepEqual(x.store.get(id).resolution.assumed, ['A (Recommended)'])
})

test('another session, another call id, or an unrelated event leaves the question waiting', async () => {
  const x = setup()
  const { id } = openQuestion(x)
  sessionEvent(x, 'other', reply('c1', [{ id: 'q1', selected: ['B'] }])) // same call id, different session
  sessionEvent(x, 'a1', reply('c2', [{ id: 'q1', selected: ['B'] }])) // another question of the session
  sessionEvent(x, 'a1', toolResult('c2', '{}'))
  sessionEvent(x, 'a1', { type: 'user/message', data: { source: { kind: 'user' }, content: [] } }) // plain messages are the pre-step's business
  sessionEvent(x, 'a1', { type: 'turn/end', data: { turn: 1 } })
  assert.equal(x.store.get(id).status, 'open')
})

test('an expired question answered in the session is settled, so no late answer is offered', async () => {
  const live = liveServices()
  const x = await expired({ services: live.services })
  sessionEvent(x, 'a1', reply('c1', [{ id: 'q1', selected: ['B'] }]))
  const r = x.store.get(x.id).resolution
  assert.deepEqual({ kind: r.kind, by: r.by }, { kind: 'answered', by: 'session' })
  assert.deepEqual(r.assumed, ['A (Recommended)'])
  assert.equal((await x.capture.lateAnswerQuestion(x.id, [{ id: 'q1', selected: ['B'] }])).error, 'not-expired')
})

test('a late answer sent from the card is not overwritten when its reply reaches the session first', async () => {
  const calls = []
  let x
  const services = { agents: { get: (id) => ({ id }) }, userQuestions: { answer: async (agent, callId) => { calls.push(callId); sessionEvent(x, 'a1', reply('c1', [{ id: 'q1', selected: ['B'] }])); return true } } }
  x = await expired({ services })
  assert.deepEqual(await x.capture.lateAnswerQuestion(x.id, [{ id: 'q1', selected: ['B'] }]), { ok: true, sent: true })
  assert.equal(x.store.get(x.id).resolution.kind, 'late-answered')
  assert.equal(x.store.get(x.id).resolution.by, 'card')
})

test('answering from the card still works exactly as before and later session events change nothing', async () => {
  const x = setup()
  const { p, id } = openQuestion(x)
  assert.equal(x.capture.answerQuestion(id, [{ id: 'q1', selected: ['B'] }]).ok, true)
  assert.deepEqual(await p, { answers: [{ id: 'q1', selected: ['B'] }] })
  sessionEvent(x, 'a1', toolResult('c1', JSON.stringify({ answers: [{ id: 'q1', selected: ['B'] }] })))
  sessionEvent(x, 'a1', reply('c1', [{ id: 'q1', selected: ['A (Recommended)'] }]))
  const r = x.store.get(id).resolution
  assert.deepEqual({ kind: r.kind, by: r.by }, { kind: 'answered', by: 'card' })
})

test('a question the session resolved does not stop DSH from settling the request later', async () => {
  const x = setup()
  let release
  const p = x.fire('user-questions/request', { agent: x.agent(), questions: QUESTIONS, wait: { callId: 'c1' } }, () => new Promise((r) => { release = r }))
  await Promise.resolve() // next() is entered on a microtask
  sessionEvent(x, 'a1', reply('c1', [{ id: 'q1', selected: ['B'] }]))
  release({ answers: [{ id: 'q1', selected: ['B'] }] })
  assert.deepEqual(await p, { answers: [{ id: 'q1', selected: ['B'] }] })
  assert.equal(x.store.snapshot().resolved[0].resolution.by, 'session')
})

test('the user continuing the session with a plain message resolves its open questions, not other sessions\'', async () => {
  const x = setup()
  const mine = openQuestion(x)
  const theirs = openQuestion(x, { callId: 'c9', sessionId: 'a2' })
  await x.fire('agent/pre-step', { agent: x.agent(), messages: [{ role: 'user', source: { kind: 'user' }, content: 'use B please' }] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(x.store.get(mine.id).resolution.kind, 'answered')
  assert.equal(x.store.get(mine.id).resolution.by, 'session')
  assert.equal(x.store.get(theirs.id).status, 'open')
})

test('a step with no user message, an injected context message, or a reply to another question leaves the question waiting', async () => {
  const x = setup()
  const { id } = openQuestion(x)
  const step = (messages) => x.fire('agent/pre-step', { agent: x.agent(), messages }, async () => ({ kind: 'enter', messages: [] }))
  await step([])
  await step([{ role: 'user', source: { kind: 'time-context' }, content: 'now' }])
  await step([{ role: 'user', source: { kind: 'user-question-reply', callId: 'other', outcome: 'answered' }, content: 'x' }])
  assert.equal(x.store.get(id).status, 'open')
  await step([{ role: 'user', source: { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' }, content: 'x' }])
  assert.equal(x.store.get(id).status, 'resolved')
})

test('permission items are not touched by session events', async () => {
  const x = setup()
  void x.fire('approval/request', { agent: x.agent(), toolName: 'shell', callId: 'c1' }, never)
  sessionEvent(x, 'a1', toolResult('c1', 'ok'))
  await x.fire('agent/pre-step', { agent: x.agent(), messages: [{ role: 'user', source: { kind: 'user' }, content: 'hi' }] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(x.store.snapshot().open.length, 1)
})

// ---- a question never vanishes on its own: only a real timeout, the user's cancel or the session ending closes it ----
// Real shapes, from the DSH source: UserQuestionError (user-questions/src/index.ts), the Client's questionError (ui-user-questions slots.ts),
// the gateway's restoreRemoteEventRejection (api-gateway stream-protocol.ts) and api-remotes' forwarded-event-source end.
const MSG = { ASK_TIMED_OUT: 'ask_user_question timed out before the user answered', ASK_ABORTED: 'ask_user_question was aborted before the user answered', ASK_CANCELLED: 'the user cancelled ask_user_question' }
const restored = (code) => Object.assign(new Error(MSG[code]), { name: 'UserQuestionError', code }) // what next() rejects with for a Client rejection
const wireRecord = (code) => ({ name: 'UserQuestionError', message: MSG[code], code }) // the bare wire record
const abortedWith = (cause) => Object.assign(new Error(MSG.ASK_ABORTED, cause === undefined ? undefined : { cause }), { name: 'UserQuestionError', code: 'ASK_ABORTED' }) // abortedQuestion(cause)
const disconnect = () => new Error('api-remotes: forwarded Remote event source ended')
const clock = (start = 5_000_000) => { let t = start; const now = () => t; now.advance = (ms) => { t += ms }; return now }

/** Open a question whose next() we control, let it start, advance the clock, then reject next() with the error. */
async function rejectNext(x, error, { advanceMs = 0, req = {} } = {}) {
  let fail
  const p = x.fire('user-questions/request', { agent: x.agent(), questions: QUESTIONS, wait: { callId: 'c1', timed: true }, ...req }, () => new Promise((_, rej) => { fail = rej }))
  await Promise.resolve(); await Promise.resolve()
  x.now?.advance(advanceMs)
  fail(error)
  await assert.rejects(p, (e) => e === error)
  return x.store.list()[0]
}
const withClock = (opts = {}) => { const now = clock(); return { ...setup({ ...opts, now }), now } }

for (const [label, error] of [
  ['a plain wire record', wireRecord('ASK_TIMED_OUT')],
  ['the Error the gateway restores from the Client', restored('ASK_TIMED_OUT')],
  ['an ASK_ABORTED that wraps the timeout as its cause', abortedWith(restored('ASK_TIMED_OUT'))],
  ['an ASK_ABORTED that wraps the bare wire record', abortedWith(wireRecord('ASK_TIMED_OUT'))],
  ['an error with the timeout text and no code', new Error(MSG.ASK_TIMED_OUT)],
]) {
  test('a timeout shaped as ' + label + ' expires the question and still reaches DSH', async () => {
    const x = withClock()
    const item = await rejectNext(x, error)
    assert.equal(item.status, 'resolved')
    assert.equal(item.resolution.kind, 'expired')
    assert.deepEqual(item.resolution.assumed, ['A (Recommended)'])
  })
}

test('a rejection that merely mentions a network timeout does not expire the question', async () => {
  const x = withClock()
  const item = await rejectNext(x, Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }))
  assert.equal(item.status, 'open')
  assert.equal(item.detached, true)
})

test('the user cancelling the question stays a cancelled item', async () => {
  const x = withClock()
  const item = await rejectNext(x, restored('ASK_CANCELLED'), { advanceMs: 120_000 })
  assert.equal(item.status, 'resolved')
  assert.equal(item.resolution.kind, 'cancelled')
})

test('a disconnect (the forwarded event source ended) keeps the question open and marks it detached', async () => {
  const x = withClock()
  const item = await rejectNext(x, disconnect(), { advanceMs: 20_000 })
  assert.equal(item.status, 'open')
  assert.equal(item.detached, true)
  assert.equal(x.store.snapshot().resolved.length, 0)
})

test('an ASK_ABORTED with no timeout evidence, a generic error and a parent turn abort all keep the question open', async () => {
  for (const error of [restored('ASK_ABORTED'), new TypeError('boom'), Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })]) {
    const x = withClock()
    const item = await rejectNext(x, error, { advanceMs: 30_000 })
    assert.equal(item.status, 'open', String(error.message))
    assert.equal(item.detached, true)
  }
})

test('a parent turn abort (the request signal) keeps the question open, not cancelled', async () => {
  const x = withClock()
  const ac = new AbortController()
  const p = x.fire('user-questions/request', { agent: x.agent(), questions: QUESTIONS, signal: ac.signal, wait: { callId: 'c1', timed: true } }, never)
  x.now.advance(5_000)
  const reason = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  ac.abort(reason)
  await assert.rejects(p, (e) => e === reason)
  const [item] = x.store.list()
  assert.equal(item.status, 'open')
  assert.equal(item.detached, true)
})

test('a known deadline that has passed turns an abort-type rejection into an expiry', async () => {
  const x = withClock()
  await x.fire('tools/pre-execute', { name: 'ask_user_question', callId: 'c1', arguments: { timeout: 360 }, agent: x.agent() }, async () => ({ kind: 'continue' }))
  const item = await rejectNext(x, restored('ASK_ABORTED'), { advanceMs: 360_500 })
  assert.equal(item.resolution.kind, 'expired')
  const early = withClock()
  await early.fire('tools/pre-execute', { name: 'ask_user_question', callId: 'c1', arguments: { timeout: 360 }, agent: early.agent() }, async () => ({ kind: 'continue' }))
  const before = await rejectNext(early, restored('ASK_ABORTED'), { advanceMs: 100_000 })
  assert.equal(before.status, 'open')
})

test('with no known deadline, an abort-type rejection at the 120 s DSH default window is taken as the timeout', async () => {
  for (const advanceMs of [119_500, 120_000, 123_000]) {
    const x = withClock()
    const item = await rejectNext(x, restored('ASK_ABORTED'), { advanceMs })
    assert.equal(item.resolution?.kind, 'expired', 'after ' + advanceMs + ' ms')
  }
  const viaAbort = withClock()
  const ac = new AbortController()
  const p = viaAbort.fire('user-questions/request', { agent: viaAbort.agent(), questions: QUESTIONS, signal: ac.signal }, never)
  viaAbort.now.advance(120_000)
  ac.abort(new Error('aborted'))
  await assert.rejects(p)
  assert.equal(viaAbort.store.list()[0].resolution?.kind, 'expired')
})

test('with no known deadline, only the 120 s window and only an abort-type rejection count: nothing else is guessed', async () => {
  const far = withClock()
  assert.equal((await rejectNext(far, restored('ASK_ABORTED'), { advanceMs: 300_000 })).status, 'open') // 300 s: the deadline is unknown, so it is not a guess
  const soon = withClock()
  assert.equal((await rejectNext(soon, restored('ASK_ABORTED'), { advanceMs: 60_000 })).status, 'open')
  const generic = withClock()
  assert.equal((await rejectNext(generic, new TypeError('boom'), { advanceMs: 120_000 })).status, 'open') // at 120 s but not abort-type
})

test('a call id seen at tools/pre-execute names a question whose request carries none, with its own timeout', async () => {
  const x = withClock()
  await x.fire('tools/pre-execute', { name: 'ask_user_question', callId: 'c7', arguments: { timeout: 360 }, agent: x.agent() }, async () => ({ kind: 'continue' }))
  void x.fire('user-questions/request', { agent: x.agent(), questions: QUESTIONS }, never) // the request has no wait.callId
  const [item] = x.store.snapshot().open
  assert.equal(item.key, 'c7')
  assert.equal(item.payload.callId, 'c7')
  assert.equal(item.expiresAt, x.now() + 360_000)
  void x.fire('user-questions/request', { agent: x.agent(), questions: QUESTIONS }, never) // a second request, no pre-execute seen
  assert.equal(x.store.snapshot().open[1].key, undefined)
})

test('an ask call that ended without a request is forgotten, so it cannot name a later question', async () => {
  const x = withClock()
  await x.fire('tools/pre-execute', { name: 'ask_user_question', callId: 'bad', arguments: {}, agent: x.agent() }, async () => ({ kind: 'continue' }))
  sessionEvent(x, 'a1', toolResult('bad', 'Error: ask_user_question requires at least one question'))
  void x.fire('user-questions/request', { agent: x.agent(), questions: QUESTIONS }, never)
  assert.equal(x.store.snapshot().open[0].key, undefined)
})

test('a closed-without-answer question is logged: id, error name, code, message, seconds and the classification, nothing private', async () => {
  const logs = []
  const x = withClock({ log: (l) => logs.push(l) })
  const item = await rejectNext(x, abortedWith(restored('ASK_TIMED_OUT')), { advanceMs: 12_000 })
  const line = logs.find((l) => l.includes(item.id))
  assert.ok(line, logs.join('|'))
  for (const part of ['UserQuestionError', 'ASK_ABORTED', 'ask_user_question was aborted', '12s', 'timeout']) assert.ok(line.includes(part), part + ' in ' + line)
  assert.ok(!line.includes('Which port?') && !line.includes('Session One'), line)
  const kept = withClock({ log: (l) => logs.push(l) })
  const open = await rejectNext(kept, disconnect())
  assert.ok(logs.some((l) => l.includes(open.id) && l.includes('detached')), logs.join('|'))
})

// ---- the detached question: open, no promise any more ----
async function detached(opts = {}) {
  const x = withClock(opts)
  const item = await rejectNext(x, disconnect(), { advanceMs: 20_000 })
  return { ...x, id: item.id }
}
const live = (answer) => liveServices(answer)
const ANSWER_B = [{ id: 'q1', selected: ['B'] }]

test('answering a detached question from the card steers the reply into the session and records it as answered by the card', async () => {
  const l = live()
  const x = await detached({ services: l.services })
  assert.deepEqual(await x.capture.answerQuestion(x.id, ANSWER_B), { ok: true })
  assert.deepEqual(l.calls, [['a1', 'c1', { answers: ANSWER_B }]])
  const it = x.store.get(x.id)
  assert.equal(it.status, 'resolved')
  assert.deepEqual({ kind: it.resolution.kind, by: it.resolution.by, answers: it.resolution.answers }, { kind: 'answered', by: 'card', answers: ANSWER_B })
})

test('a detached question that DSH no longer holds refuses the answer clearly and then expires in Resolved', async () => {
  const l = live(() => false)
  const x = await detached({ services: l.services })
  assert.deepEqual(await x.capture.answerQuestion(x.id, ANSWER_B), { ok: false, error: 'not-pending' })
  const it = x.store.get(x.id)
  assert.equal(it.status, 'resolved')
  assert.equal(it.resolution.kind, 'expired')
})

test('a detached question whose session is gone refuses with no-session and expires', async () => {
  const x = await detached({ services: { agents: { get: () => undefined }, userQuestions: { answer: async () => true } } })
  assert.deepEqual(await x.capture.answerQuestion(x.id, ANSWER_B), { ok: false, error: 'no-session' })
  assert.equal(x.store.get(x.id).resolution.kind, 'expired')
})

test('a queued reply, a bad answer or a missing service keep the detached question open', async () => {
  const queued = live(() => { throw Object.assign(new Error('queued'), { code: 'REPLY_QUEUED' }) })
  const a = await detached({ services: queued.services })
  assert.deepEqual(await a.capture.answerQuestion(a.id, ANSWER_B), { ok: false, error: 'reply-queued' })
  assert.equal(a.store.get(a.id).status, 'open')
  const fine = live()
  const b = await detached({ services: fine.services })
  assert.equal((await b.capture.answerQuestion(b.id, [{ id: 'q1', selected: ['Z'] }])).error, 'bad-answer')
  assert.equal(fine.calls.length, 0)
  assert.equal(b.store.get(b.id).status, 'open')
  const none = await detached({})
  assert.equal((await none.capture.answerQuestion(none.id, ANSWER_B)).ok, false)
  assert.equal(none.store.get(none.id).status, 'open')
})

test('two answers at once to a detached question: one goes through, the other is refused', async () => {
  let release
  const calls = []
  const x = await detached({ services: { agents: { get: (id) => ({ id }) }, userQuestions: { answer: (agent, callId) => { calls.push(callId); return new Promise((r) => { release = r }) } } } })
  const first = x.capture.answerQuestion(x.id, ANSWER_B)
  const second = await x.capture.answerQuestion(x.id, ANSWER_B)
  assert.equal(second.ok, false)
  release?.(true)
  assert.deepEqual(await first, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal((await x.capture.answerQuestion(x.id, ANSWER_B)).error, 'not-pending') // and once it is answered, nothing more
})

test('the reply reaching the session while the card answer is in flight does not relabel the item', async () => {
  let x
  const services = { agents: { get: (id) => ({ id }) }, userQuestions: { answer: async () => { sessionEvent(x, 'a1', reply('c1', ANSWER_B)); return true } } }
  x = await detached({ services })
  assert.deepEqual(await x.capture.answerQuestion(x.id, ANSWER_B), { ok: true })
  assert.equal(x.store.get(x.id).resolution.by, 'card')
})

test('the session replying to a detached question closes it as answered in the session', async () => {
  const x = await detached({})
  sessionEvent(x, 'a1', reply('c1', ANSWER_B))
  const r = x.store.get(x.id).resolution
  assert.deepEqual({ kind: r.kind, by: r.by, answers: r.answers }, { kind: 'answered', by: 'session', answers: ANSWER_B })
})

test('the tool call of a detached question returning closes it: an answer as answered, a pending result as expired', async () => {
  const a = await detached({})
  sessionEvent(a, 'a1', toolResult('c1', JSON.stringify({ answers: ANSWER_B })))
  assert.deepEqual({ kind: a.store.get(a.id).resolution.kind, by: a.store.get(a.id).resolution.by }, { kind: 'answered', by: 'session' })
  const b = await detached({})
  sessionEvent(b, 'a1', toolResult('c1', JSON.stringify({ pending: true, callId: 'c1' })))
  assert.equal(b.store.get(b.id).resolution.kind, 'expired')
  assert.deepEqual(b.store.get(b.id).resolution.assumed, ['A (Recommended)'])
})

test('the user continuing the session with a plain message closes a detached question', async () => {
  const x = await detached({})
  await x.fire('agent/pre-step', { agent: x.agent(), messages: [{ role: 'user', source: { kind: 'user' }, content: 'use B please' }] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(x.store.get(x.id).resolution.kind, 'answered')
  assert.equal(x.store.get(x.id).resolution.by, 'session')
})

test('the session ending closes a detached question as session-ended', async () => {
  const x = await detached({})
  x.fire('agent/disposed', { agent: x.agent() })
  assert.equal(x.store.get(x.id).resolution.kind, 'session-ended')
})

test('a new question in a session removes that session\'s older detached question from the open list', async () => {
  const { store, fire, agent } = setup()
  const ac = new AbortController()
  const p = fire('user-questions/request', { agent: agent(), questions: QUESTIONS, wait: { callId: 'old' }, signal: ac.signal }, never)
  ac.abort()
  await assert.rejects(p)
  const other = fire('user-questions/request', { agent: agent('a2'), questions: QUESTIONS, wait: { callId: 'x' } }, never)
  assert.equal(store.snapshot().open.filter((i) => i.sessionId === 'a1' && i.detached).length, 1)
  fire('user-questions/request', { agent: agent(), questions: QUESTIONS, wait: { callId: 'new' } }, never)
  const open = store.snapshot().open
  assert.deepEqual(open.filter((i) => i.sessionId === 'a1').map((i) => i.key), ['new'])
  assert.equal(open.filter((i) => i.sessionId === 'a2').length, 1)
  assert.equal(store.snapshot().resolved.find((i) => i.key === 'old').resolution.kind, 'expired')
  void other
})
