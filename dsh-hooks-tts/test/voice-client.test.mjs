import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEventsUrl, createVoiceClient } from '../voice/client.js'

class FakeSocket {
  static instances = []
  constructor(url) {
    this.url = url
    this.closed = false
    FakeSocket.instances.push(this)
  }
  open() { this.onopen?.({}) }
  say(obj) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }) }
  drop() { this.onclose?.({}) }
  close() { this.closed = true; this.onclose?.({}) }
}

function harness(extra = {}) {
  FakeSocket.instances = []
  const timers = []
  const log = { events: [], states: [], busy: [] }
  const client = createVoiceClient({
    url: 'ws://127.0.0.1:8890/events?token=s',
    WebSocketImpl: FakeSocket,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {},
    backoff: { initialMs: 100, maxMs: 400, factor: 2 },
    onEvent: (e) => log.events.push(e),
    onState: (s) => log.states.push(s),
    onBusy: (b) => log.busy.push(b),
    ...extra,
  })
  return { client, timers, log, sock: () => FakeSocket.instances.at(-1) }
}

test('buildEventsUrl puts the token in the query and defaults to loopback 8890', () => {
  assert.equal(buildEventsUrl({ token: 'a b' }), 'ws://127.0.0.1:8890/events?token=a%20b')
  assert.equal(buildEventsUrl({ port: 9000, token: 'x' }), 'ws://127.0.0.1:9000/events?token=x')
})

test('start connects, reports connecting then connected once open', () => {
  const h = harness()
  h.client.start()
  assert.equal(h.client.state, 'connecting')
  h.sock().open()
  assert.equal(h.client.state, 'connected')
  assert.deepEqual(h.log.states, ['connecting', 'connected'])
})

test('events are parsed and forwarded; garbage frames are ignored', () => {
  const h = harness()
  h.client.start(); h.sock().open()
  h.sock().say({ type: 'hello' })
  h.sock().say('not json')
  h.sock().say('null')
  assert.deepEqual(h.log.events, [{ type: 'hello' }])
})

test('busy is true from listening/transcribing until idle or error', () => {
  const h = harness()
  h.client.start(); h.sock().open()
  assert.equal(h.client.busy, false)
  h.sock().say({ type: 'listening' })
  assert.equal(h.client.busy, true)
  h.sock().say({ type: 'transcribing' })
  assert.equal(h.client.busy, true)
  h.sock().say({ type: 'idle', reason: 'done' })
  assert.equal(h.client.busy, false)
  h.sock().say({ type: 'listening' })
  h.sock().say({ type: 'error', message: 'x' })
  assert.equal(h.client.busy, false)
  assert.deepEqual(h.log.busy, [true, false, true, false])
})

test('lastTranscript keeps the newest non-empty transcript', () => {
  const h = harness()
  h.client.start(); h.sock().open()
  h.sock().say({ type: 'transcript', id: 1, text: 'hello', confidence: 0.9 })
  h.sock().say({ type: 'transcript', id: 2, text: '   ', confidence: 0.1 })
  assert.equal(h.client.lastTranscript.id, 1)
  h.sock().say({ type: 'transcript', id: 1, text: 'hello there', revision: 2 })
  assert.equal(h.client.lastTranscript.text, 'hello there')
})

test('a dropped socket reconnects with doubling backoff capped at maxMs, reset after hello', () => {
  const h = harness()
  h.client.start(); h.sock().open()
  h.sock().drop()
  assert.equal(h.client.state, 'disconnected')
  assert.equal(h.timers.at(-1).ms, 100)
  h.timers.at(-1).fn(); h.sock().drop()
  assert.equal(h.timers.at(-1).ms, 200)
  h.timers.at(-1).fn(); h.sock().drop()
  assert.equal(h.timers.at(-1).ms, 400)
  h.timers.at(-1).fn(); h.sock().drop()
  assert.equal(h.timers.at(-1).ms, 400)
  h.timers.at(-1).fn(); h.sock().open(); h.sock().say({ type: 'hello' })
  h.sock().drop()
  assert.equal(h.timers.at(-1).ms, 100)
})

test('a drop while busy clears busy', () => {
  const h = harness()
  h.client.start(); h.sock().open(); h.sock().say({ type: 'listening' })
  h.sock().drop()
  assert.equal(h.client.busy, false)
})

test('stop closes the socket and never reconnects', () => {
  const h = harness()
  h.client.start(); const s = h.sock(); s.open()
  const before = h.timers.length
  h.client.stop()
  assert.equal(s.closed, true)
  assert.equal(h.client.state, 'disconnected')
  assert.equal(h.timers.length, before)
})

test('start is idempotent', () => {
  const h = harness()
  h.client.start(); h.client.start()
  assert.equal(FakeSocket.instances.length, 1)
})

test('a constructor that throws is retried with backoff', () => {
  let n = 0
  const Boom = class { constructor() { n++; throw new Error('nope') } }
  const h = harness({ WebSocketImpl: Boom })
  h.client.start()
  assert.equal(n, 1)
  assert.equal(h.client.state, 'disconnected')
  assert.equal(h.timers.at(-1).ms, 100)
})

test('busy clears itself if idle never arrives', () => {
  const h = harness({ busyTimeoutMs: 90000 })
  h.client.start(); h.sock().open()
  h.sock().say({ type: 'listening' })
  assert.equal(h.client.busy, true)
  const t = h.timers.find((x) => x.ms === 90000)
  assert.ok(t, 'a failsafe timer is armed')
  t.fn()
  assert.equal(h.client.busy, false)
})
