// apply()-level, slice 7: the alert headline says the item's task-list position (via ctx.get('reviewQueue').snapshot()) for all three
// event types, live and when held while a voice flow runs (re-rendered at replay), and falls back to the old headline whenever the
// item is not in the list or the queue misbehaves. No real process is started (spawn is replaced; stdin of each hook is recorded).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

const require = createRequire(import.meta.url)
const ttsGroup = (matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: 'hook-cmd', args: ['scripts/detach-launcher.ps1'] }] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(10) } return true }

/** The review queue as the plugin sees it: items in list order; the getter itself or snapshot() can be made to throw. */
function fakeQueue() {
  const q = { open: [], snapshotThrows: false, getThrows: false, absent: false }
  q.service = { snapshot() { if (q.snapshotThrows) throw new Error('queue broke'); return { open: q.open } } }
  return q
}

async function withApplied(queue, fn) {
  const cp = require('node:child_process')
  const realSpawn = cp.spawn
  const realSetInterval = globalThis.setInterval
  const realWebSocket = globalThis.WebSocket
  const spawns = []
  const bodies = []
  const sockets = []
  const timers = []
  const handlers = new Map()
  const allHandlers = new Map()
  const effects = []
  cp.spawn = (cmd, args) => {
    spawns.push({ cmd, args })
    const child = new EventEmitter()
    child.pid = 4242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { on() {}, write() {}, end(data) { if (cmd === 'hook-cmd') bodies.push(JSON.parse(data)); setImmediate(() => child.emit('close', 0)) } }
    child.kill = () => true
    return child
  }
  syncBuiltinESMExports()
  globalThis.setInterval = (f, ms) => { timers.push({ fn: f, ms }); return { unref() { return this } } }
  globalThis.WebSocket = class { constructor(url) { this.url = url; sockets.push(this) } close() {} }
  try {
    const stateDir = mkdtempSync(join(tmpdir(), 'alert-position-'))
    const configPath = join(stateDir, 'hooks.json')
    writeFileSync(configPath, JSON.stringify({ hooks: { PermissionRequest: [ttsGroup()], PreToolUse: [ttsGroup('AskUserQuestion')], Stop: [ttsGroup()] } }))
    writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({ voiceControl: true, ttsEnabled: true }))
    writeFileSync(join(stateDir, 'stt-secret'), 'secret')
    const ctx = new Proxy(function () {}, {
      get(_t, k) {
        if (k === 'on') return (event, handler) => { handlers.set(event, handler); allHandlers.set(event, [...allHandlers.get(event) ?? [], handler]) }
        if (k === 'effect') return (setup, label) => { effects.push({ setup, label }) }
        if (k === 'get') return (name) => {
          if (name !== 'reviewQueue') return undefined
          if (queue.getThrows) throw new Error('service lookup broke')
          return queue.absent ? undefined : queue.service
        }
        if (typeof k === 'symbol' || k === 'then') return undefined
        return new Proxy(function () {}, { get: () => undefined, apply: () => undefined })
      },
    })
    apply(ctx, { stateDir, configPath })
    const voiceTick = () => { for (const t of timers.filter((x) => x.ms === 5000)) t.fn() }
    const socketEvent = (type) => { sockets[0].onmessage({ data: JSON.stringify({ type }) }) }
    const cleanups = effects.map((e) => e.setup())
    const shutdown = async () => { for (const c of cleanups) await c?.() }
    const headlines = () => bodies.map((b) => b.headline)
    await fn({ handlers, allHandlers, voiceTick, socketEvent, sockets, headlines, shutdown })
  } finally {
    cp.spawn = realSpawn
    syncBuiltinESMExports()
    globalThis.setInterval = realSetInterval
    globalThis.WebSocket = realWebSocket
  }
}

const agent = {
  id: 'sess-1',
  session: { header: { cwd: 'D:\\dev\\dsh-plugins' }, deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'Shipped it.' }] }] },
}
const done = (sessionId = 'sess-1') => ({ type: 'completed', sessionId })
const perm = (toolName, sessionId = 'sess-1') => ({ type: 'permission', sessionId, payload: { toolName } })
const ask = (key, sessionId = 'sess-1') => ({ type: 'question', sessionId, key })
const other = (n) => Array.from({ length: n }, (_, i) => ({ type: 'completed', sessionId: 'x' + i }))

const connect = (h) => { h.voiceTick(); h.sockets[0].onopen() } // connected, mic closed: alerts play at once
const openMic = (h) => { connect(h); h.socketEvent('listening') }
const stop = (h) => h.handlers.get('agent/turn-stopping')({ agent, signal: undefined })
const request = (h, toolName = 'write') => { h.handlers.get('approval/request')({ agent, toolName, reason: 'because', signal: undefined }, () => new Promise(() => {})); return sleep(30) }
const question = (h, callId = 'call-1') => h.handlers.get('tools/pre-execute')({ agent, name: 'ask_user_question', arguments: { questions: [{ question: 'Which one?' }] }, callId, signal: undefined }, async () => ({ kind: 'allow' }))

test('W1 Stop for an item already in the list says its position', async () => {
  const q = fakeQueue(); q.open = [...other(2), done()]
  await withApplied(q, async (h) => {
    connect(h)
    await stop(h)
    assert.deepEqual(h.headlines(), ['Item three, done in dsh-plugins. Shipped it.'])
    await h.shutdown()
  })
})

test('W2 a permission request already in the list says its position', async () => {
  const q = fakeQueue(); q.open = [...other(3), perm('write')]
  await withApplied(q, async (h) => {
    connect(h)
    await request(h, 'write')
    assert.deepEqual(h.headlines(), ['Item four, approve write file?'])
    await h.shutdown()
  })
})

test('W3 a question already in the list says its position', async () => {
  const q = fakeQueue(); q.open = [other(1)[0], ask('call-1')]
  await withApplied(q, async (h) => {
    connect(h)
    await question(h, 'call-1')
    assert.deepEqual(h.headlines(), ['Item two, question: Which one?'])
    await h.shutdown()
  })
})

test('W4 the item is not in the list (queue absent, empty, other session, not captured yet): the old headlines, nothing lost', async () => {
  const scenarios = { absent: (q) => { q.absent = true }, empty: () => {}, 'other session': (q) => { q.open = [done('someone-else')] }, 'question not captured yet': (q) => { q.open = [ask('older-call')] } }
  for (const [name, setUp] of Object.entries(scenarios)) {
    const q = fakeQueue(); setUp(q)
    await withApplied(q, async (h) => {
      connect(h)
      await stop(h); await request(h, 'write'); await question(h, 'call-1')
      assert.deepEqual(h.headlines(), ['Done on: Workspace: dsh-plugins. Shipped it.', 'Approve write file?', 'Question: Which one?'], name)
      await h.shutdown()
    })
  }
})

test('W5 a queue that throws (lookup or snapshot) never breaks an alert: it is spoken with the old headline', async () => {
  for (const mode of ['getThrows', 'snapshotThrows']) {
    const q = fakeQueue(); q.open = [done()]; q[mode] = true
    await withApplied(q, async (h) => {
      connect(h)
      await stop(h); await request(h, 'edit'); await question(h)
      assert.deepEqual(h.headlines(), ['Done on: Workspace: dsh-plugins. Shipped it.', 'Approve edit file?', 'Question: Which one?'], mode)
      await h.shutdown()
    })
  }
})

test('W6 a Stop alert held while a flow runs is re-rendered at replay: the position it has THEN', async () => {
  const q = fakeQueue(); q.open = [...other(1), done()] // item two when the alert was raised
  await withApplied(q, async (h) => {
    openMic(h)
    await stop(h)
    assert.deepEqual(h.headlines(), [], 'held while the mic is open')
    q.open = [done(), ...other(1)] // the flow reviewed another item: now item one
    h.socketEvent('idle'); h.voiceTick()
    assert.equal(await until(() => h.headlines().length === 1), true)
    assert.deepEqual(h.headlines(), ['Item one, done in dsh-plugins. Shipped it.'])
    await h.shutdown()
  })
})

test('W7 a held alert whose item left the list meanwhile is still spoken, with the old headline (a done alert is never judged stale)', async () => {
  const q = fakeQueue(); q.open = [done()]
  await withApplied(q, async (h) => {
    openMic(h)
    await stop(h)
    q.open = [] // answered / reviewed / hidden while the flow ran
    h.socketEvent('idle'); h.voiceTick()
    assert.equal(await until(() => h.headlines().length === 1), true)
    assert.deepEqual(h.headlines(), ['Done on: Workspace: dsh-plugins. Shipped it.'])
    await h.shutdown()
  })
})

test('W8 a held alert raised before its item was captured gets its position at replay', async () => {
  const q = fakeQueue() // race: the list does not have the item yet
  await withApplied(q, async (h) => {
    openMic(h)
    await stop(h)
    q.open = [...other(1), done()]
    h.socketEvent('idle'); h.voiceTick()
    assert.equal(await until(() => h.headlines().length === 1), true)
    assert.deepEqual(h.headlines(), ['Item two, done in dsh-plugins. Shipped it.'])
    await h.shutdown()
  })
})

test('W9 held permission and question alerts are re-rendered at replay too', async () => {
  const q = fakeQueue(); q.open = [...other(3), perm('write'), ask('call-1')]
  await withApplied(q, async (h) => {
    openMic(h)
    await request(h, 'write'); await question(h, 'call-1')
    assert.deepEqual(h.headlines(), [])
    q.open = [ask('call-1'), perm('write')] // reordered: the question is item one, the request item two
    h.socketEvent('idle'); h.voiceTick()
    assert.equal(await until(() => h.headlines().length === 2), true)
    assert.deepEqual([...h.headlines()].sort(), ['Item one, question: Which one?', 'Item two, approve write file?'])
    await h.shutdown()
  })
})

test('W10 a throwing queue at replay falls back to the old headline and still plays', async () => {
  const q = fakeQueue(); q.open = [done()]
  await withApplied(q, async (h) => {
    openMic(h)
    await stop(h)
    q.snapshotThrows = true
    h.socketEvent('idle'); h.voiceTick()
    assert.equal(await until(() => h.headlines().length === 1), true)
    assert.deepEqual(h.headlines(), ['Done on: Workspace: dsh-plugins. Shipped it.'])
    await h.shutdown()
  })
})
