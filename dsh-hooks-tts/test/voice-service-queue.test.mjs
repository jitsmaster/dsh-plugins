// Wiring of the task-list fast path: createVoiceService builds the flow's `queue` dependency from a lazily resolved
// reviewQueue service (ctx.get('reviewQueue') in index.js). Absent service => no fast path, behaviour as before.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceService } from '../voice/service.js'
import { createVoiceFlow } from '../voice/flow.js'

const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(setImmediate) }

class FakeSocket {
  static instances = []
  constructor(url) { this.url = url; FakeSocket.instances.push(this) }
  close() { this.onclose?.({}) }
}

function fakeQueue(over = {}) {
  const calls = []
  const q = {
    calls,
    uiCommand: (cmd) => { calls.push(['uiCommand', cmd]); return { ok: true, seq: 1 } },
    count: () => ({ total: 2, byType: { question: 1, permission: 0, completed: 1 } }),
    readPosition: (n) => { calls.push(['readPosition', n]); return { ok: true, id: 'x' } },
    next: () => ({ ok: true, id: 'y' }), again: () => ({ ok: true, id: 'x' }),
    stop: () => { calls.push(['stop']); return { ok: true } },
    openTarget: () => ({ sessionId: 'sess-9', title: 'Review the plan' }),
    ...over,
  }
  return q
}

function make({ reviewQueue, real = true, ...extra } = {}) {
  FakeSocket.instances = []
  const spoken = []
  const box = { deps: undefined }
  const svc = createVoiceService({
    enabled: () => true,
    readSecret: () => 'sekret',
    WebSocketImpl: FakeSocket,
    setTimer: () => 1,
    clearTimer: () => {},
    controller: { cancel: async () => {}, create: async () => ({}), fork: async () => ({}), rename: async () => ({}), selectModel: async () => ({}), prompt: async () => {} },
    runSlash: async () => {},
    speaker: { speak: async (text, opts) => { spoken.push([text, opts]); return { status: 'done', ms: 1 } }, warm() {}, stop() {}, cancel() {} },
    // The echo opens a listen: without a stub it would hit a real port and its refusal ("Speech service unavailable") could land inside the assertions.
    fetchImpl: async () => ({ ok: true, json: async () => ({ started: true }) }),
    decide: async () => ({ ok: false, error: 'llm' }),
    createFlow: (deps) => { box.deps = deps; return real ? createVoiceFlow(deps) : { handle() {}, active: () => false, abort() {}, snapshot: () => ({ state: 'IDLE' }) } },
    ...(reviewQueue !== undefined ? { reviewQueue } : {}),
    ...extra,
  })
  svc.reconcile()
  const send = (event) => FakeSocket.instances.at(-1).onmessage?.({ data: JSON.stringify(event) })
  return { svc, spoken, box, send }
}

test('SQ1 the flow gets a queue dependency only when a reviewQueue getter is wired', () => {
  assert.equal(make({ real: false }).box.deps.queue, undefined)
  const wired = make({ real: false, reviewQueue: () => undefined }).box.deps.queue
  assert.equal(typeof wired.match, 'function')
  assert.equal(typeof wired.run, 'function')
  assert.equal(typeof wired.stop, 'function')
})

test('SQ2 the getter is resolved on every call: a service that appears later is used, a missing one is not', () => {
  let q
  const h = make({ real: false, reviewQueue: () => q })
  assert.equal(h.box.deps.queue.match('show the task list'), undefined, 'absent: not a command')
  q = fakeQueue()
  assert.deepEqual(h.box.deps.queue.match('show the task list'), { kind: 'show' })
})

test('SQ3 end to end: "show the task list" runs against the service and speaks the outcome', async () => {
  const q = fakeQueue()
  const h = make({ reviewQueue: () => q })
  h.box.deps.queue // sanity
  h.svc.status() // no throw
  h.send({ type: 'transcript', revision: 1, text: 'Show the task list.', context: null, source: 'hotkey' })
  await tick()
  assert.deepEqual(q.calls, [['uiCommand', 'show']])
  assert.deepEqual(h.spoken.map((s) => s[0]), ['Task list showing.'])
})

test('SQ4 end to end: how many items speaks the count wording', async () => {
  const h = make({ reviewQueue: () => fakeQueue() })
  h.send({ type: 'transcript', revision: 1, text: 'how many items', context: null })
  await tick()
  assert.deepEqual(h.spoken.map((s) => s[0]), ['Two waiting: one question, one done.'])
})

test('SQ5 open selects the first item session as the voice target and hides the list', async () => {
  const q = fakeQueue()
  const h = make({ reviewQueue: () => q })
  h.send({ type: 'transcript', revision: 1, text: "Open the first item's session.", context: null })
  await tick()
  assert.equal(h.svc.status().selected, 'sess-9')
  assert.deepEqual(q.calls, [['uiCommand', 'hide']])
  assert.deepEqual(h.spoken.map((s) => s[0]), ['Opened Review the plan.'])
})

test('SQ6 with no reviewQueue service the same words are echoed as today', async () => {
  const h = make({ reviewQueue: () => undefined })
  h.send({ type: 'transcript', revision: 1, text: 'show the task list', context: null })
  await tick()
  assert.deepEqual(h.spoken.map((s) => s[0]), ['I heard: show the task list. Is that right?'])
})

test('SQ7 a getter that throws never crashes voice: the words are echoed', async () => {
  const h = make({ reviewQueue: () => { throw new Error('no such service') } })
  h.send({ type: 'transcript', revision: 1, text: 'stop', context: null })
  await tick()
  assert.deepEqual(h.spoken.map((s) => s[0]), ['I heard: stop. Is that right?'])
  assert.doesNotThrow(() => h.send({ type: 'listening', context: null }))
})

test('SQ8 the hotkey (listening with no context) stops the reader through the service', async () => {
  const q = fakeQueue()
  const h = make({ reviewQueue: () => q })
  h.send({ type: 'listening', context: null })
  assert.deepEqual(q.calls, [['stop']])
})

test('SQ9 "stop" stops the reader and cuts speech, silently', async () => {
  const q = fakeQueue()
  const cuts = []
  const h = make({ reviewQueue: () => q, speaker: { speak: async () => ({ status: 'done' }), warm() {}, stop() {}, cancel: () => cuts.push('cancel') } })
  h.send({ type: 'transcript', revision: 1, text: 'stop reading', context: null })
  await tick()
  assert.deepEqual(q.calls, [['stop']])
  assert.ok(cuts.length >= 1)
  assert.deepEqual(h.spoken, [])
})

test('SQ10 a queue call that throws is spoken as a failure and the flow ends', async () => {
  const q = fakeQueue({ count: () => { throw new Error('store is locked') } })
  const h = make({ reviewQueue: () => q })
  h.send({ type: 'transcript', revision: 1, text: 'how many items', context: null })
  await tick()
  assert.deepEqual(h.spoken.map((s) => s[0]), ['That failed: store is locked.'])
  assert.equal(h.svc.busy(), false)
})

// ---- slice 5: reply by voice, end to end through the service with the real flow and runner ----

function replyQueue(over = {}) {
  const calls = []
  const state = { open: [{ id: 'd1', type: 'completed', sessionId: 's1', createdAt: 1, seq: 1, title: 'Fix parser', payload: { reply: 'All done.' }, position: 1 }], snapshotId: 'e:1' }
  const q = fakeQueue({
    snapshot: () => ({ snapshotId: state.snapshotId, open: state.open }),
    count: () => ({ total: state.open.length, byType: {} }),
    reply: async (id, text) => { calls.push(['reply', id, text]); state.open = state.open.filter((i) => i.id !== id); return { ok: true } },
    ...over,
  })
  q.state = state
  q.replyCalls = calls
  return q
}

/** A service whose /listen answers started:true and records the flow contexts, so the test can answer them. */
function makeReply(reviewQueue) {
  const contexts = []
  const fetchImpl = async (url, opts) => { contexts.push(JSON.parse(opts.body).context); return { ok: true, json: async () => ({ started: true }) } }
  const h = make({ reviewQueue: () => reviewQueue, fetchImpl })
  h.answer = async (text) => { h.send({ type: 'transcript', revision: 1, text, context: contexts.at(-1) }); await tick() }
  h.contexts = contexts
  return h
}

test('SQ11 end to end: reply to the first item -> dictate -> read-back -> yes sends through the card service call', async () => {
  const q = replyQueue()
  const h = makeReply(q)
  h.send({ type: 'transcript', revision: 1, text: 'Reply to the first item.', context: null })
  await tick()
  assert.deepEqual(h.spoken, [], 'no echo and no line before the dictation')
  assert.equal(h.contexts.at(-1).step, 'reply-dictate')
  await h.answer('add unit tests')
  assert.deepEqual(h.spoken.map((s) => s[0]), ['Send to Fix parser: add unit tests. Say yes to send, or say the prompt again to replace it.'])
  assert.equal(h.contexts.at(-1).step, 'reply-confirm')
  await h.answer('yes')
  assert.deepEqual(q.replyCalls, [['reply', 'd1', 'add unit tests']])
  assert.equal(h.spoken.at(-1)[0], 'Task Fix parser, reply sent. Nothing waiting.')
  assert.equal(h.svc.busy(), false)
})

test('SQ12 end to end: the first item is a question -> one spoken line, no dictation', async () => {
  const q = replyQueue()
  q.state.open = [{ id: 'q1', type: 'question', sessionId: 's2', createdAt: 1, seq: 1, title: 'Pick one', payload: {}, position: 1 }]
  const h = makeReply(q)
  h.send({ type: 'transcript', revision: 1, text: 'reply to the first item', context: null })
  await tick()
  assert.deepEqual(h.spoken.map((s) => s[0]), ['Voice reply works on done items only. Answer it on screen.'])
  assert.equal(h.contexts.length, 0)
  assert.deepEqual(q.replyCalls, [])
})

test('SQ13 end to end: the item left the queue while the user dictated -> "That item changed. Nothing done."', async () => {
  const q = replyQueue()
  const h = makeReply(q)
  h.send({ type: 'transcript', revision: 1, text: 'reply to the first item', context: null })
  await tick()
  await h.answer('add unit tests')
  q.state.open = []; q.state.snapshotId = 'e:2'
  await h.answer('yes')
  assert.deepEqual(q.replyCalls, [])
  assert.equal(h.spoken.at(-1)[0], 'That item changed. Nothing done.')
})

test('SQ14 end to end: an empty task list says Nothing waiting and a throwing service is a failure line', async () => {
  const empty = replyQueue(); empty.state.open = []
  const a = makeReply(empty)
  a.send({ type: 'transcript', revision: 1, text: 'reply to the first item', context: null })
  await tick()
  assert.deepEqual(a.spoken.map((s) => s[0]), ['Nothing waiting.'])
  const broken = replyQueue({ snapshot: () => { throw new Error('store is locked') } })
  const b = makeReply(broken)
  b.send({ type: 'transcript', revision: 1, text: 'reply to the first item', context: null })
  await tick()
  assert.deepEqual(b.spoken.map((s) => s[0]), ['That failed: store is locked.'])
  assert.equal(b.svc.busy(), false)
})
