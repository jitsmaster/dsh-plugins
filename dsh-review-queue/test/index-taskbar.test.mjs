import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

function ctxWith() {
  const effects = []
  const handlers = {}
  const ctx = {
    on: (n, f) => { (handlers[n] ??= []).push(f) }, get: () => undefined, effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d) },
    logger: { warn() {}, info() {} }, inject: () => {},
  }
  return { ctx, effects, handlers }
}
function recordingSpawn() {
  const runs = []
  const spawn = (exe, args) => { const c = new EventEmitter(); c.stderr = new EventEmitter(); runs.push(args); setImmediate(() => c.emit('exit', 0)); return c }
  return { spawn, runs }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms))
const lastCount = (runs) => Number(runs.at(-1)[runs.at(-1).indexOf('-Count') + 1])

test('the plugin sets the taskbar badge from the waiting count and removes it when stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  const { ctx, effects, handlers } = ctxWith()
  const { spawn, runs } = recordingSpawn()
  try {
    apply(ctx, { stateDir: dir, taskbarBadge: true, badgeDeps: { spawn, platform: 'win32', debounceMs: 5, exists: () => true } })
    await tick(40)
    assert.equal(lastCount(runs), 0)
    const agent = { id: 's1', session: { header: { cwd: 'D:/dev' }, deriveMessages: () => [{ role: 'assistant', content: 'Done.' }] } }
    await handlers['agent/turn-stopping'][0]({ agent })
    await tick(80)
    assert.equal(lastCount(runs), 1)
    for (const dispose of effects) await dispose()
    assert.equal(lastCount(runs), 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('taskbarBadge: false starts nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  const { ctx } = ctxWith()
  const { spawn, runs } = recordingSpawn()
  try {
    apply(ctx, { stateDir: dir, taskbarBadge: false, badgeDeps: { spawn, platform: 'win32' } })
    await tick(30)
    assert.equal(runs.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
