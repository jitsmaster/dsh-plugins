// apply()-level: a PermissionRequest read-out held while a voice flow runs is marked "tracked" when voice control already
// tracks the request, so it is dropped (not spoken late) when the request was answered meanwhile (F-H4); the same for a held
// ask_user_question alert whose question was answered meanwhile (F-H4b); a held Stop alert is replayed; the held alerts are
// flushed when the voice flow ends, not only on the 5 s tick (F-H4c).
// No real process is started: child_process.spawn is replaced (hook launchers and the speak worker are recorded), the STT
// socket is a fake and the 5 s voice timer is driven by hand.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

async function withApplied(fn) {
  const cp = require('node:child_process')
  const realSpawn = cp.spawn
  const realSetInterval = globalThis.setInterval
  const realWebSocket = globalThis.WebSocket
  const spawns = []
  const sockets = []
  const timers = []
  const handlers = new Map()
  const allHandlers = new Map() // every handler per event (several plugin modules register the same event)
  const effects = []
  cp.spawn = (cmd, args) => {
    spawns.push({ cmd, args })
    const child = new EventEmitter()
    child.pid = 4242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { on() {}, write() {}, end() { setImmediate(() => child.emit('close', 0)) } }
    child.kill = () => true
    return child
  }
  syncBuiltinESMExports()
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return { unref() { return this } } }
  globalThis.WebSocket = class { constructor(url) { this.url = url; sockets.push(this) } close() {} }
  try {
    const stateDir = mkdtempSync(join(tmpdir(), 'held-alerts-'))
    const configPath = join(stateDir, 'hooks.json')
    writeFileSync(configPath, JSON.stringify({ hooks: { PermissionRequest: [ttsGroup()], PreToolUse: [ttsGroup('AskUserQuestion')], Stop: [ttsGroup()] } }))
    writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({ voiceControl: true, ttsEnabled: true }))
    writeFileSync(join(stateDir, 'stt-secret'), 'secret')
    const ctx = new Proxy(function () {}, {
      get(_t, k) {
        if (k === 'on') return (event, handler) => { handlers.set(event, handler); allHandlers.set(event, [...allHandlers.get(event) ?? [], handler]) }
        if (k === 'effect') return (setup, label) => { effects.push({ setup, label }) }
        if (k === 'get') return () => undefined
        if (typeof k === 'symbol' || k === 'then') return undefined
        return new Proxy(function () {}, { get: () => undefined, apply: () => undefined })
      },
    })
    apply(ctx, { stateDir, configPath, sttAutoStart: false })
    const voiceTick = () => { for (const t of timers.filter((x) => x.ms === 5000)) t.fn() }
    const socketEvent = (type) => { sockets[0].onmessage({ data: JSON.stringify({ type }) }) }
    const hookSpawns = () => spawns.filter((s) => s.cmd === 'hook-cmd')
    const cleanups = effects.map((e) => e.setup())
    const shutdown = async () => { for (const c of cleanups) await c?.() }
    await fn({ stateDir, handlers, allHandlers, voiceTick, socketEvent, sockets, hookSpawns, shutdown })
  } finally {
    cp.spawn = realSpawn
    syncBuiltinESMExports()
    globalThis.setInterval = realSetInterval
    globalThis.WebSocket = realWebSocket
  }
}

const agent = { id: 'sess-1', session: { header: { cwd: tmpdir() } } }

/** Voice mic open (a flow is busy), then a permission request arrives. Returns the answer function of the request. */
async function openMicAndRequest(h) {
  h.voiceTick() // reconcile: voice control is on, so the STT client starts
  assert.equal(h.sockets.length, 1, 'the STT socket was opened')
  h.sockets[0].onopen()
  h.socketEvent('listening')
  let answer
  const next = () => new Promise((resolve) => { answer = resolve })
  const done = h.handlers.get('approval/request')({ agent, toolName: 'pwsh', reason: 'run it', signal: undefined }, next)
  await sleep(20)
  assert.equal(h.hookSpawns().length, 0, 'the read-out is held while the mic is open')
  return { answer: (outcome) => answer(outcome), done }
}

test('H1 a held permission alert for a request that voice then answered is not spoken after the flow ends', async () => {
  await withApplied(async (h) => {
    const { answer, done } = await openMicAndRequest(h)
    answer('allowed-once') // the voice flow (or the GUI) answered the request
    assert.equal(await done, 'allowed-once')
    h.socketEvent('idle')
    h.voiceTick()
    await sleep(100)
    assert.equal(h.hookSpawns().length, 0, 'the answered request is not announced late')
    await h.shutdown()
    const log = readFileSync(join(h.stateDir, 'voice.log'), 'utf8')
    assert.match(log, /"stage":"dropped-stale"/)
  })
})

test('H2 a held permission alert for a request that is still pending is spoken once the flow ends', async () => {
  await withApplied(async (h) => {
    await openMicAndRequest(h)
    h.socketEvent('idle')
    h.voiceTick()
    assert.equal(await until(() => h.hookSpawns().length === 1), true, 'the still-pending request is announced after the flow')
    assert.deepEqual(h.hookSpawns()[0].args, ['scripts/detach-launcher.ps1'])
    await h.shutdown()
  })
})

/** Mic open (a flow is busy). */
function openMic(h) {
  h.voiceTick()
  h.sockets[0].onopen()
  h.socketEvent('listening')
}

/**
 * An ask_user_question call: tools/pre-execute decides (its alert hook runs while the mic is open), the tool then waits for the
 * user. answer() delivers the tool result through every tools/post-execute handler, as DSH does when the question is answered.
 */
async function askQuestion(h) {
  const exec = { agent, name: 'ask_user_question', arguments: { questions: [{ question: 'Which one?' }] }, callId: 'call-1', signal: undefined }
  const decision = await h.handlers.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
  await sleep(20)
  const answer = async () => {
    for (const handler of h.allHandlers.get('tools/post-execute')) { try { await handler(exec, { content: [{ type: 'text', text: 'ok' }] }, async () => ({ additionalContexts: [] })) } catch { /* another module's handler needs more of the real runtime */ } }
  }
  return { answer }
}

test('H3 a held question alert whose question was answered meanwhile is dropped as stale, not spoken late', async () => {
  await withApplied(async (h) => {
    openMic(h)
    const { answer } = await askQuestion(h)
    assert.equal(h.hookSpawns().length, 0, 'the question alert is held while the mic is open')
    await answer() // answered by voice (or in the GUI) while the flow ran
    h.socketEvent('idle')
    h.voiceTick()
    await sleep(100)
    assert.equal(h.hookSpawns().length, 0, 'the answered question is not announced late')
    await h.shutdown()
    assert.match(readFileSync(join(h.stateDir, 'voice.log'), 'utf8'), /"stage":"dropped-stale"/)
  })
})

test('H4 a held question alert for a question that is still pending is spoken once the flow ends', async () => {
  await withApplied(async (h) => {
    openMic(h)
    const { answer } = await askQuestion(h)
    h.socketEvent('idle')
    h.voiceTick()
    assert.equal(await until(() => h.hookSpawns().length === 1), true, 'the unanswered question is announced after the flow')
    await answer()
    await h.shutdown()
  })
})

test('H5 a question raised while no flow runs is never held: its alert is spoken at once, and answering it afterwards speaks nothing more', async () => {
  await withApplied(async (h) => {
    h.voiceTick(); h.sockets[0].onopen() // connected, mic closed: nothing is held
    const { answer } = await askQuestion(h)
    assert.equal(h.hookSpawns().length, 1, 'spoken right away')
    await answer()
    assert.equal(h.hookSpawns().length, 1, 'answering it later does not replay or add anything')
    await h.shutdown()
  })
})

test('H6 a held Stop alert is replayed when the flow ends (Stop alerts are never judged stale)', async () => {
  await withApplied(async (h) => {
    openMic(h)
    await h.handlers.get('agent/turn-stopping')({ agent, signal: undefined })
    assert.equal(h.hookSpawns().length, 0, 'the Stop alert is held while the mic is open')
    h.socketEvent('idle')
    h.voiceTick()
    assert.equal(await until(() => h.hookSpawns().length === 1), true, 'the Stop alert is spoken after the flow')
    await h.shutdown()
  })
})

test('H7 the held alerts are flushed when the flow ends, without waiting for the 5 s tick', async () => {
  await withApplied(async (h) => {
    await openMicAndRequest(h)
    h.socketEvent('idle') // flow end: no voiceTick() here
    assert.equal(await until(() => h.hookSpawns().length === 1, 3000), true, 'the held alert is spoken shortly after the mic closes')
    await h.shutdown()
  })
})
