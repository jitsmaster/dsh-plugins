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
