// Spec: docs/voice-two-stage-flow.md §2 "Changed – voice/service.js", §0 D7, §1 T26, §6 (prewarm), §7 SV1–SV5.
// Shapes chosen where the spec is open (implementer: follow these):
// - createVoiceService no longer takes switchTo / speak / minConfidence / router / confirm. New options:
//     speaker    { speak(text, opts) -> Promise<{status}>, warm(), stop() }   (createSpeakWorker result)
//     decide     (utterance, {history}) -> Promise   (decider.decide, wired by index.js)
//     createFlow (deps) -> flow   default createVoiceFlow from ./flow.js; called once (at construction or at the latest on the
//                first reconcile()) with the §2 flow deps. deps.listen === the service's listen; deps.speak goes to
//                speaker.speak; deps.execute is actions.createExecutor({ controller, runSlash, approvals, select, cwdOf, uuid })
//                whose select(id) sets the service's 'selected'; deps.log(stage, data) records a 'flow'-typed entry.
// - svc.listen({ context, window_s }) POSTs http://127.0.0.1:<port>/listen with headers exactly
//   { Authorization: 'Bearer <secret>', 'Content-Type': 'application/json' } and body JSON.stringify({ context, window_s });
//   resolves { started: <response JSON .started === true> }; rejects on a non-ok HTTP status (message contains the status).
// - control('listen') from the GUI is unchanged: init exactly { method: 'POST', headers: { Authorization } }, no body.
// - busy() = client.busy || flow.active(). status() adds flow: flow.snapshot() and selected.
// - flow log entries: record({ type: 'flow', stage, ...data }) (extra keys such as id/turn/dt allowed); record throwing never
//   reaches the flow.
// - agentDisposed(id): clears selected when it is id; if flow.snapshot().action?.sessionId === id the flow is aborted and the
//   service speaks "That session closed. Cancelled." with { priority: 'High', gender: 'female' }.
// - reconcile(): speaker.warm() when enabled; speaker.stop() when disabled. stop(): aborts the flow silently.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceService } from '../voice/service.js'
import { createVoiceFlow } from '../voice/flow.js'

const VOICE = { priority: 'High', gender: 'female' }
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(setImmediate) }

class FakeSocket {
  static instances = []
  constructor(url) { this.url = url; FakeSocket.instances.push(this) }
  close() { this.onclose?.({}) }
}

function make(extra = {}) {
  FakeSocket.instances = []
  const state = { enabled: true }
  const calls = []
  const spoken = []
  const speakerCalls = []
  const agents = new Map()
  const flow = { active: false, snap: { state: 'IDLE', id: null, turn: 0, step: null, action: null }, handled: [], aborts: [], deps: undefined }
  const svc = createVoiceService({
    enabled: () => state.enabled,
    readSecret: () => 'sekret',
    WebSocketImpl: FakeSocket,
    setTimer: () => 1,
    clearTimer: () => {},
    titleOf: (id) => agents.get(id)?.title,
    controller: {
      cancel: async (a) => { calls.push(['cancel', a]) },
      create: async () => ({}), fork: async () => ({}), rename: async () => ({}), selectModel: async () => ({}),
      prompt: async (a) => { calls.push(['prompt', a]) },
    },
    runSlash: async (a) => { calls.push(['slash', a]) },
    speaker: {
      speak: async (text, opts) => { spoken.push([text, opts]); return { status: 'done', ms: 1 } },
      warm: () => { speakerCalls.push('warm') },
      stop: () => { speakerCalls.push('stop') },
      cancel: () => { speakerCalls.push('cancel') },
    },
    decide: async () => ({ ok: false, error: 'llm' }),
    cwdOf: () => undefined,
    createFlow: (deps) => {
      flow.deps = deps
      return {
        handle: (ev) => { flow.handled.push(ev) },
        active: () => flow.active,
        abort: (why) => { flow.aborts.push(why); flow.active = false; flow.snap = { ...flow.snap, state: 'IDLE', action: null } },
        snapshot: () => flow.snap,
      }
    },
    ...extra,
  })
  return { svc, state, calls, spoken, speakerCalls, agents, flow, sock: () => FakeSocket.instances.at(-1) }
}

const okFetch = (seen, body = { started: true }) => async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => body } }

test('reconcile starts the client when enabled and stops it when disabled', () => {
  const h = make()
  h.svc.reconcile()
  assert.equal(FakeSocket.instances.length, 1)
  assert.equal(h.sock().url, 'ws://127.0.0.1:8890/events?token=sekret')
  h.svc.reconcile()
  assert.equal(FakeSocket.instances.length, 1)
  h.state.enabled = false
  h.svc.reconcile()
  assert.equal(h.svc.status().connection, 'disconnected')
  assert.equal(h.svc.status().running, false)
})

test('reconcile prewarms the speak worker while enabled and stops it when disabled', () => {
  const h = make()
  h.svc.reconcile()
  assert.deepEqual(h.speakerCalls.filter((c) => c === 'stop'), [])
  assert.equal(h.speakerCalls[0], 'warm')
  h.state.enabled = false
  h.svc.reconcile()
  assert.equal(h.speakerCalls.at(-1), 'stop')
})

test('a missing secret keeps it off without throwing', () => {
  const h = make({ readSecret: () => { throw new Error('ENOENT') } })
  h.svc.reconcile()
  assert.equal(FakeSocket.instances.length, 0)
  assert.equal(h.svc.status().running, false)
  assert.match(h.svc.status().error, /ENOENT/)
})

test('busy follows listening/transcribing', () => {
  const h = make()
  h.svc.reconcile(); h.sock().onopen({})
  assert.equal(h.svc.busy(), false)
  h.sock().onmessage({ data: JSON.stringify({ type: 'listening' }) })
  assert.equal(h.svc.busy(), true)
  h.sock().onmessage({ data: JSON.stringify({ type: 'idle', reason: 'done' }) })
  assert.equal(h.svc.busy(), false)
})

test('SV1 listen POSTs {context, window_s} as JSON with the bearer secret and reports started', async () => {
  const seen = []
  const h = make({ fetchImpl: okFetch(seen) })
  h.svc.reconcile()
  const context = { flow: 'voice', id: 'ab12cd34', turn: 3, step: 'echo' }
  assert.deepEqual(await h.svc.listen({ context, window_s: 10 }), { started: true })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'http://127.0.0.1:8890/listen')
  assert.equal(seen[0].init.method, 'POST')
  assert.deepEqual(seen[0].init.headers, { Authorization: 'Bearer sekret', 'Content-Type': 'application/json' })
  assert.equal(seen[0].init.body, '{"context":{"flow":"voice","id":"ab12cd34","turn":3,"step":"echo"},"window_s":10}')
})

test('SV1 the flow listens through the same JSON POST', async () => {
  const seen = []
  const h = make({ fetchImpl: okFetch(seen, { started: false }) })
  h.svc.reconcile()
  const context = { flow: 'voice', id: 'f00dcafe', turn: 7, step: 'decision' }
  assert.deepEqual(await h.flow.deps.listen({ context, window_s: 10 }), { started: false })
  assert.equal(seen[0].url, 'http://127.0.0.1:8890/listen')
  assert.equal(seen[0].init.body, JSON.stringify({ context, window_s: 10 }))
  assert.equal(seen[0].init.headers['Content-Type'], 'application/json')
})

test('SV1 listen rejects on an HTTP failure', async () => {
  const h = make({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) })
  h.svc.reconcile()
  await assert.rejects(() => h.svc.listen({ context: { flow: 'voice', id: 'x', turn: 1, step: 'echo' }, window_s: 10 }), /503/)
})

test('SV2 the GUI control listen/finish/cancel still posts without a body, with the bearer secret', async () => {
  const seen = []
  const h = make({ fetchImpl: okFetch(seen) })
  h.svc.reconcile()
  await h.svc.control('listen')
  await h.svc.control('finish')
  // init is exactly { method, headers } plus the request-timeout signal (SV9); no body.
  assert.ok(seen.every((s) => s.init.signal instanceof AbortSignal))
  assert.deepEqual(seen.map(({ url, init: { signal, ...init } }) => ({ url, init })), [
    { url: 'http://127.0.0.1:8890/listen', init: { method: 'POST', headers: { Authorization: 'Bearer sekret' } } },
    { url: 'http://127.0.0.1:8890/finish', init: { method: 'POST', headers: { Authorization: 'Bearer sekret' } } },
  ])
  await assert.rejects(() => h.svc.control('format-disk'), /unknown/i)
})

test('control without a running client fails clearly', async () => {
  const h = make()
  await assert.rejects(() => h.svc.control('listen'), /not running/i)
})

test('control surfaces an HTTP failure', async () => {
  const h = make({ fetchImpl: async () => ({ ok: false, status: 503 }) })
  h.svc.reconcile()
  await assert.rejects(() => h.svc.control('finish'), /503/)
})

test('SV3 busy() is true for the whole voice conversation, not just while STT is busy', () => {
  const h = make()
  h.svc.reconcile(); h.sock().onopen({})
  assert.equal(h.svc.busy(), false)
  h.flow.active = true
  assert.equal(h.svc.busy(), true)
  h.flow.active = false
  assert.equal(h.svc.busy(), false)
})

test('SV3 status exposes the flow snapshot and the selected voice target', () => {
  const h = make()
  h.svc.reconcile()
  h.flow.snap = { state: 'ECHO_LISTEN', id: 'id1', turn: 2, step: 'echo', action: null }
  const s = h.svc.status()
  assert.deepEqual(s.flow, { state: 'ECHO_LISTEN', id: 'id1', turn: 2, step: 'echo', action: null })
  assert.equal(s.selected, undefined)
})

test('SV4 agentDisposed clears the selected target and aborts a flow whose action targets it, saying so', async () => {
  const seen = []
  const h = make({ fetchImpl: okFetch(seen) })
  h.agents.set('a1', { title: 'Voice Work' }); h.agents.set('b2', { title: 'PR 6524' })
  h.svc.agentCreated('a1'); h.svc.agentCreated('b2')
  h.svc.reconcile(); h.sock().onopen({})
  await h.flow.deps.execute(Object.freeze({ action: 'switch', sessionId: 'a1', title: 'Voice Work' }))
  assert.equal(h.svc.status().selected, 'a1')
  h.flow.active = true
  h.flow.snap = { state: 'READBACK_LISTEN', id: 'f1', turn: 4, step: 'decision', action: Object.freeze({ action: 'cancel', sessionId: 'a1', title: 'Voice Work' }) }
  h.svc.agentDisposed('b2')
  await tick()
  assert.deepEqual(h.spoken, [], 'another session closing leaves the flow alone')
  assert.equal(h.svc.busy(), true)
  assert.equal(h.svc.status().selected, 'a1')
  h.svc.agentDisposed('a1')
  await tick()
  assert.equal(h.svc.status().selected, undefined)
  assert.equal(h.flow.aborts.length, 1)
  assert.equal(h.svc.busy(), false)
  assert.deepEqual(h.spoken, [['That session closed. Cancelled.', VOICE]])
})

function disposeSetup(snap, fetchImpl) {
  const h = make({ fetchImpl })
  h.agents.set('a1', { title: 'Voice Work' })
  h.svc.agentCreated('a1')
  h.svc.reconcile(); h.sock().onopen({})
  h.flow.active = true
  h.flow.snap = snap
  return h
}

test('SV6 agentDisposed during a *_LISTEN state cancels the STT listen before speaking', async () => {
  const seen = []
  let release
  const gate = new Promise((r) => { release = r })
  const h = disposeSetup(
    { state: 'READBACK_LISTEN', id: 'f1', turn: 4, step: 'decision', action: Object.freeze({ action: 'cancel', sessionId: 'a1', title: 'Voice Work' }) },
    async (url, init) => { seen.push({ url, init }); await gate; return { ok: true, status: 200, json: async () => ({}) } },
  )
  h.svc.agentDisposed('a1')
  await tick()
  assert.deepEqual(seen.map(({ url, init: { signal, ...init } }) => ({ url, init })), [{ url: 'http://127.0.0.1:8890/cancel', init: { method: 'POST', headers: { Authorization: 'Bearer sekret' } } }])
  assert.deepEqual(h.spoken, [], 'nothing is spoken into the still-open mic window')
  release()
  await tick()
  assert.deepEqual(h.spoken, [['That session closed. Cancelled.', VOICE]])
})

test('SV6 agentDisposed outside a listen does not cancel STT; a failing cancel still speaks', async () => {
  const seen = []
  const h = disposeSetup(
    { state: 'READBACK_SPEAK', id: 'f1', turn: 5, step: 'decision', action: Object.freeze({ action: 'cancel', sessionId: 'a1', title: 'Voice Work' }) },
    okFetch(seen),
  )
  h.svc.agentDisposed('a1')
  await tick()
  assert.deepEqual(seen, [])
  assert.deepEqual(h.spoken, [['That session closed. Cancelled.', VOICE]])
  const g = disposeSetup(
    { state: 'READBACK_LISTEN', id: 'f2', turn: 4, step: 'decision', action: Object.freeze({ action: 'cancel', sessionId: 'a1', title: 'Voice Work' }) },
    async () => ({ ok: false, status: 500 }),
  )
  g.svc.agentDisposed('a1')
  await tick(6)
  assert.deepEqual(g.spoken, [['That session closed. Cancelled.', VOICE]])
})

test('SV7 agentDisposed leaves a frozen new action alone (its session is only the cwd source)', async () => {
  const seen = []
  const h = disposeSetup(
    { state: 'READBACK_LISTEN', id: 'f1', turn: 4, step: 'decision', action: Object.freeze({ action: 'new', sessionId: 'a1', title: 'Voice Work', text: 'hi' }) },
    okFetch(seen),
  )
  h.svc.agentDisposed('a1')
  await tick()
  assert.equal(h.flow.aborts.length, 0)
  assert.deepEqual(h.spoken, [])
  assert.deepEqual(seen, [])
  assert.equal(h.svc.busy(), true)
})

for (const state of ['EXECUTE', 'END_SPEAK']) {
  test('SV8 agentDisposed after the action ran (' + state + ') neither aborts the flow nor says the session closed', async () => {
    const seen = []
    const h = disposeSetup(
      { state, id: 'f1', turn: 6, step: 'decision', action: Object.freeze({ action: 'cancel', sessionId: 'a1', title: 'Voice Work' }) },
      okFetch(seen),
    )
    h.svc.agentDisposed('a1')
    await tick()
    assert.equal(h.flow.aborts.length, 0)
    assert.deepEqual(h.spoken, [])
    assert.deepEqual(seen, [])
  })
}

test('SV4 stop() aborts the flow without speaking', () => {
  const h = make()
  h.svc.reconcile(); h.sock().onopen({})
  h.flow.active = true
  h.svc.stop()
  assert.equal(h.flow.aborts.length, 1)
  assert.equal(h.svc.busy(), false)
  assert.deepEqual(h.spoken, [])
})

test('SV5 every STT event reaches flow.handle unchanged; lastTranscript is still reported', () => {
  const h = make()
  h.svc.reconcile(); h.sock().onopen({})
  const events = [
    { type: 'listening', context: null },
    { type: 'transcript', id: 7, revision: 1, text: 'fix the parser', confidence: 0.8, context: null, source: 'hotkey', seconds: 1.2 },
    { type: 'idle', reason: 'done', context: { flow: 'voice', id: 'f1', turn: 2, step: 'echo' } },
  ]
  for (const e of events) h.sock().onmessage({ data: JSON.stringify(e) })
  assert.deepEqual(h.flow.handled, events)
  assert.equal(h.svc.status().lastTranscript.text, 'fix the parser')
})

test('SV5 flow log entries are recorded typed flow, and a failing recorder never reaches the flow', () => {
  const records = []
  const h = make({ record: (r) => records.push(r) })
  h.svc.reconcile()
  h.flow.deps.log('answer', { step: 'echo', text: 'yes', kind: 'yes' })
  const { type, stage, step, text, kind } = records.at(-1)
  assert.deepEqual({ type, stage, step, text, kind }, { type: 'flow', stage: 'answer', step: 'echo', text: 'yes', kind: 'yes' })
  const bad = make({ record: () => { throw new Error('disk full') } })
  bad.svc.reconcile()
  assert.doesNotThrow(() => bad.flow.deps.log('end', { line: 'Cancelled.' }))
})

test('SV5 the flow speaks through the speak worker', async () => {
  const h = make()
  h.svc.reconcile()
  assert.deepEqual(await h.flow.deps.speak('I heard: x. Is that right?', VOICE), { status: 'done', ms: 1 })
  assert.deepEqual(h.spoken, [['I heard: x. Is that right?', VOICE]])
})

test('reconcile asks the launcher to ensure STT only while enabled and not connected', async () => {
  const calls = []
  const h = make({ ensureStt: async () => { calls.push('ensure'); return 'started' } })
  h.svc.reconcile()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls, ['ensure'])
  h.sock().onopen({})
  h.svc.reconcile()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls, ['ensure'])
  h.state.enabled = false
  h.svc.reconcile()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls, ['ensure'])
})

test('an ensureStt failure never breaks reconcile', async () => {
  const h = make({ ensureStt: async () => { throw new Error('x') } })
  h.svc.reconcile()
  await new Promise((r) => setImmediate(r))
  assert.equal(h.svc.status().running, true)
})

test('SV9 the flow cancels speech through the speak worker (barge-in / abort silence queued and in-flight lines)', () => {
  const h = make()
  h.svc.reconcile()
  assert.equal(typeof h.flow.deps.cancelSpeech, 'function')
  h.flow.deps.cancelSpeech()
  assert.deepEqual(h.speakerCalls.filter((c) => c === 'cancel'), ['cancel'])
})

test('SV9 cancelSpeech tolerates a speaker without cancel() and one that throws', () => {
  const bare = make({ speaker: { speak: async () => ({ status: 'done', ms: 1 }), warm() {}, stop() {} } })
  assert.doesNotThrow(() => bare.flow.deps.cancelSpeech())
  const bad = make({ speaker: { speak: async () => ({ status: 'done', ms: 1 }), warm() {}, stop() {}, cancel() { throw new Error('x') } } })
  assert.doesNotThrow(() => bad.flow.deps.cancelSpeech())
})

/** A fetch that never answers on its own: it only settles when its request signal aborts (like a stuck daemon). */
const hangingFetch = (seen = []) => (url, init) => new Promise((_resolve, reject) => {
  seen.push({ url, init })
  const signal = init?.signal
  if (!signal) return // no timeout wired: hangs forever, the test's own guard fails it
  const abort = () => reject(signal.reason ?? new Error('aborted'))
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
})
const withDeadline = (promise, ms = 1500) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('HUNG'), ms))])

test('SV10 listen() gives up on a daemon that accepts the connection but never answers', async () => {
  const seen = []
  const h = make({ fetchImpl: hangingFetch(seen), requestTimeoutMs: 40 })
  h.svc.reconcile()
  const r = await withDeadline(h.svc.listen({ context: { flow: 'voice', id: 'x', turn: 1, step: 'echo' }, window_s: 10 }).then(() => 'resolved', (e) => 'rejected: ' + e.name))
  assert.match(r, /^rejected: /)
  assert.ok(seen[0].init.signal instanceof AbortSignal)
})

test('SV10 control() gives up on a daemon that never answers', async () => {
  const h = make({ fetchImpl: hangingFetch(), requestTimeoutMs: 40 })
  h.svc.reconcile()
  for (const action of ['listen', 'finish', 'cancel']) {
    const r = await withDeadline(h.svc.control(action).then(() => 'resolved', (e) => 'rejected: ' + e.name))
    assert.match(r, /^rejected: /, action)
  }
})

test('SV10 the default request timeout is 5000 ms for both listen() and control()', async (t) => {
  const real = AbortSignal.timeout.bind(AbortSignal)
  const asked = []
  t.mock.method(AbortSignal, 'timeout', (ms) => { asked.push(ms); return real(ms) })
  const seen = []
  const h = make({ fetchImpl: okFetch(seen) })
  h.svc.reconcile()
  await h.svc.listen({ context: { flow: 'voice', id: 'x', turn: 1, step: 'echo' }, window_s: 10 })
  await h.svc.control('finish')
  assert.deepEqual(asked, [5000, 5000])
  assert.equal(seen.length, 2)
})

test('SV11 a /listen that never answers ends the flow with Speech service unavailable. instead of hanging busy', async () => {
  const spoken = []
  const h = make({
    fetchImpl: hangingFetch(),
    requestTimeoutMs: 40,
    createFlow: createVoiceFlow,
    speaker: { speak: async (text, opts) => { spoken.push([text, opts]); return { status: 'done', ms: 1 } }, warm() {}, stop() {}, cancel() {} },
  })
  h.svc.reconcile(); h.sock().onopen({})
  h.sock().onmessage({ data: JSON.stringify({ type: 'transcript', revision: 1, text: 'open the parser', context: null, source: 'hotkey', seconds: 1 }) })
  await tick()
  assert.equal(h.svc.busy(), true, 'the flow waits for the listen POST')
  for (let i = 0; i < 100 && h.svc.busy(); i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.svc.busy(), false, 'the flow ended; read-outs are no longer suppressed')
  assert.deepEqual(spoken.map(([s]) => s), ['I heard: open the parser. Is that right?', 'Speech service unavailable. Cancelled.'])
})

test('SV9 a pending approval is summarised for the decider and frozen (summary + count) into a validated approve action', () => {
  const h = make({ summaryOf: (req) => (req.callId === 'c1' ? 'rm -rf build' : undefined) })
  h.svc.agentCreated('a1')
  h.agents.set('a1', { title: 'Voice\u200B Work' })
  h.svc.intercept({ agent: { id: 'a1' }, toolName: 'pwsh', callId: 'c1' }, () => new Promise(() => {}))
  const ctx = h.svc.context()
  assert.equal(ctx.sessions[0].title, 'Voice Work', 'titles are sanitised before the decider sees them')
  assert.equal(ctx.sessions[0].pending, 'permission: run command rm -rf build')
  const v = h.flow.deps.validate({ action: 'approve', session: 's1' })
  assert.equal(v.ok, true)
  assert.equal(v.action.summary, 'rm -rf build')
  assert.equal(v.action.pendingCount, 1)
  assert.equal(h.flow.deps.readBack(v.action), 'approve run command rm -rf build in Voice Work')
})

test('SV9 without a summaryOf the read-back says the details are not available', () => {
  const h = make()
  h.svc.agentCreated('a1')
  h.svc.intercept({ agent: { id: 'a1' }, toolName: 'pwsh' }, () => new Promise(() => {}))
  assert.equal(h.svc.context().sessions[0].pending, 'permission: run command')
  const v = h.flow.deps.validate({ action: 'approve', session: 's1' })
  assert.match(h.flow.deps.readBack(v.action), /details not available/)
})

test('SV10 the flow classifies answers step-aware: the read-back step takes only strict confirmation words', () => {
  const h = make()
  assert.equal(h.flow.deps.classify('ok', 'echo'), 'yes')
  assert.equal(h.flow.deps.classify('ok', 'decision'), 'text')
  assert.equal(h.flow.deps.classify('confirm', 'decision'), 'yes')
})
