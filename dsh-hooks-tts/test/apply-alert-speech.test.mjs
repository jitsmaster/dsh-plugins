// apply()-level: the three speak hooks go through the persistent speak worker (no launcher process per alert): the plugin asks
// the Kokoro server itself, caches the WAV and hands the worker a file. No real process or network is used: child_process.spawn
// and fetch are replaced.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(10) } return true }
const launcher = (script) => ({ type: 'command', command: 'hook-cmd', async: true, args: ['-File', 'scripts/detach-launcher.ps1', '-ScriptPath', 'scripts/' + script] })

async function withApplied(fn, { config = {}, settings = { ttsEnabled: true }, muted = false } = {}) {
  const cp = require('node:child_process')
  const realSpawn = cp.spawn
  const realFetch = globalThis.fetch
  const realSetInterval = globalThis.setInterval
  const spawns = []
  const fetches = []
  const handlers = new Map()
  const effects = []
  cp.spawn = (cmd, args) => {
    const child = new EventEmitter()
    const rec = { cmd, args, child, input: '' }
    spawns.push(rec)
    child.pid = 4242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { on() {}, write(c) { rec.input += c }, end() { if (cmd === 'hook-cmd') setImmediate(() => child.emit('close', 0)) } }
    child.kill = () => { setImmediate(() => child.emit('exit', null, 'SIGTERM')); return true }
    return child
  }
  syncBuiltinESMExports()
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('RIFFxxxxWAVEfake') }
  }
  globalThis.setInterval = () => ({ unref() { return this } })
  try {
    const stateDir = mkdtempSync(join(tmpdir(), 'alert-speech-apply-'))
    const configPath = join(stateDir, 'hooks.json')
    writeFileSync(configPath, JSON.stringify({ hooks: { Stop: [{ hooks: [launcher('stop-speak.ps1')] }] } }))
    writeFileSync(join(stateDir, 'settings.json'), JSON.stringify(settings))
    if (muted) writeFileSync(join(stateDir, 'tts-muted.flag'), '')
    const ctx = new Proxy(function () {}, {
      get(_t, k) {
        if (k === 'on') return (event, handler) => { handlers.set(event, handler) }
        if (k === 'effect') return (setup, label) => { effects.push({ setup, label }) }
        if (k === 'get') return () => undefined
        if (typeof k === 'symbol' || k === 'then') return undefined
        return new Proxy(function () {}, { get: () => undefined, apply: () => undefined })
      },
    })
    apply(ctx, { stateDir, configPath, sttAutoStart: false, ttsUrl: 'http://tts.test/tts', ttsSpeed: 1.2, ...config })
    const cleanups = effects.map((e) => e.setup())
    const agent = { id: 'sess-1', session: { header: { cwd: tmpdir() }, deriveMessages: () => [{ role: 'assistant', content: 'All finished.' }] } }
    const stop = () => handlers.get('agent/turn-stopping')({ agent, signal: undefined })
    const workerSpawns = () => spawns.filter((s) => /speak-worker\.ps1$/.test(String(s.args?.at(-1))))
    const launcherSpawns = () => spawns.filter((s) => s.cmd === 'hook-cmd')
    const shutdown = async () => { for (const c of cleanups) await c?.() }
    await fn({ stateDir, stop, fetches, workerSpawns, launcherSpawns, shutdown })
  } finally {
    cp.spawn = realSpawn
    globalThis.fetch = realFetch
    globalThis.setInterval = realSetInterval
    syncBuiltinESMExports()
  }
}

test('AS1 a Stop alert asks the server itself and hands the worker a cached WAV, without starting a launcher', async () => {
  await withApplied(async (h) => {
    await h.stop()
    assert.equal(await until(() => h.workerSpawns().length === 1 && h.workerSpawns()[0].input.includes('"file"')), true, 'the worker got a file request')
    assert.equal(h.launcherSpawns().length, 0, 'no launcher process')
    assert.equal(h.fetches.length, 1)
    assert.equal(h.fetches[0].url, 'http://tts.test/tts')
    assert.equal(h.fetches[0].body.voice_gender, 'male')
    assert.equal(h.fetches[0].body.speed, 1.2)
    assert.equal(h.fetches[0].body.pause_s, 0.5)
    const req = JSON.parse(h.workerSpawns()[0].input.trim().split('\n')[0])
    assert.equal(req.gender, 'male')
    assert.equal(req.priority, 'Normal')
    assert.equal(existsSync(req.file), true)
    assert.equal(req.file.startsWith(join(h.stateDir, 'tts-cache')), true)
    await h.shutdown()
  })
})

test('AS2 a repeated phrase is not requested again', async () => {
  await withApplied(async (h) => {
    await h.stop()
    await until(() => h.workerSpawns()[0]?.input.includes('"file"'))
    await h.stop()
    assert.equal(await until(() => h.workerSpawns()[0].input.trim().split('\n').length === 2), true)
    assert.equal(h.fetches.length, 1)
    await h.shutdown()
  })
})

test('AS3 read-outs switched off or muted: nothing is requested or played', async () => {
  await withApplied(async (h) => {
    await h.stop(); await sleep(50)
    assert.equal(h.fetches.length + h.workerSpawns().length + h.launcherSpawns().length, 0)
    await h.shutdown()
  }, { settings: { ttsEnabled: false } })
  await withApplied(async (h) => {
    await h.stop(); await sleep(50)
    assert.equal(h.fetches.length, 0)
    assert.equal(h.launcherSpawns().length, 0)
    await h.shutdown()
  }, { muted: true })
})

test('AS4 ttsAlertsViaWorker: false keeps the old launcher scripts', async () => {
  await withApplied(async (h) => {
    await h.stop()
    assert.equal(await until(() => h.launcherSpawns().length === 1), true)
    assert.equal(h.fetches.length, 0)
    await h.shutdown()
  }, { config: { ttsAlertsViaWorker: false } })
})
