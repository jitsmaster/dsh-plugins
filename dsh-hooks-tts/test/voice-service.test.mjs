import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceService } from '../voice/service.js'

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
  const agents = new Map()
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
    switchTo: async () => {},
    speak: (s) => spoken.push(s),
    ...extra,
  })
  return { svc, state, calls, spoken, agents, sock: () => FakeSocket.instances.at(-1) }
}

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

test('a transcript reaches the dispatcher: stop cancels the last alerted agent', async () => {
  const h = make()
  h.agents.set('a1', { title: 'Voice Work' })
  h.svc.agentCreated('a1')
  h.svc.noteAlert('a1')
  h.svc.reconcile(); h.sock().onopen({})
  h.sock().onmessage({ data: JSON.stringify({ type: 'transcript', id: 1, text: 'stop', confidence: 0.9 }) })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(h.calls, [['cancel', { sessionId: 'a1' }]])
  assert.equal(h.svc.status().lastTranscript.text, 'stop')
})

test('disposed agents are no longer targets', async () => {
  const h = make()
  h.agents.set('a1', { title: 'Voice Work' })
  h.svc.agentCreated('a1'); h.svc.noteAlert('a1'); h.svc.agentDisposed('a1')
  h.svc.reconcile(); h.sock().onopen({})
  h.sock().onmessage({ data: JSON.stringify({ type: 'transcript', id: 1, text: 'stop', confidence: 0.9 }) })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(h.calls, [])
})

test('approve with no pending request is spoken, not thrown', async () => {
  const h = make()
  h.agents.set('a1', { title: 'Voice Work' })
  h.svc.agentCreated('a1'); h.svc.noteAlert('a1')
  h.svc.reconcile(); h.sock().onopen({})
  h.sock().onmessage({ data: JSON.stringify({ type: 'transcript', id: 1, text: 'approve', confidence: 0.9 }) })
  await new Promise((r) => setImmediate(r))
  assert.match(h.spoken.at(-1), /No pending/i)
})

test('slash commands go to the injected runner', async () => {
  const h = make()
  h.agents.set('a1', { title: 'Voice Work' })
  h.svc.agentCreated('a1'); h.svc.noteAlert('a1')
  h.svc.reconcile(); h.sock().onopen({})
  h.sock().onmessage({ data: JSON.stringify({ type: 'transcript', id: 1, text: 'compact', confidence: 0.9 }) })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(h.calls, [['slash', { sessionId: 'a1', name: 'compact', input: '' }]])
})

test('control posts listen/finish/cancel to the STT service with the bearer secret', async () => {
  const seen = []
  const h = make({ fetchImpl: async (url, init) => { seen.push([url, init.method, init.headers.Authorization]); return { ok: true } } })
  h.svc.reconcile()
  await h.svc.control('listen')
  assert.deepEqual(seen, [['http://127.0.0.1:8890/listen', 'POST', 'Bearer sekret']])
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
