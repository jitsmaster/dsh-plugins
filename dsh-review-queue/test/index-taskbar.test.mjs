import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewQueuePlugin } from '../index.js'

function ctxWith() {
  const effects = []
  const ctx = {
    on: () => {}, get: () => undefined, effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d) },
    logger: { warn() {}, info() {} }, inject: () => {},
  }
  return { ctx, effects }
}
function recordingSpawn() {
  const runs = []
  const spawn = (exe, args) => { const c = new EventEmitter(); c.stderr = new EventEmitter(); runs.push(args); setImmediate(() => c.emit('exit', 0)); return c }
  return { spawn, runs }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

test('the plugin sets the taskbar badge from the waiting count and removes it when stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  const { ctx, effects } = ctxWith()
  const { spawn, runs } = recordingSpawn()
  try {
    const plugin = createReviewQueuePlugin(ctx, { hub: false, stateDir: dir, taskbarBadge: true, badgeDeps: { spawn, platform: 'win32', debounceMs: 5, exists: () => true } })
    await tick(40)
    assert.equal(Number(runs.at(-1)[runs.at(-1).indexOf('-Count') + 1]), 0)
    plugin.store.add({ type: 'completed', sessionId: 's1', workspace: 'w', payload: { summary: 'x' } })
    await tick(60)
    assert.equal(Number(runs.at(-1)[runs.at(-1).indexOf('-Count') + 1]), 1)
    for (const dispose of effects) await dispose()
    assert.equal(Number(runs.at(-1)[runs.at(-1).indexOf('-Count') + 1]), 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('taskbarBadge: false starts nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  const { ctx } = ctxWith()
  const { spawn, runs } = recordingSpawn()
  try {
    createReviewQueuePlugin(ctx, { hub: false, stateDir: dir, taskbarBadge: false, badgeDeps: { spawn, platform: 'win32' } })
    await tick(30)
    assert.equal(runs.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
