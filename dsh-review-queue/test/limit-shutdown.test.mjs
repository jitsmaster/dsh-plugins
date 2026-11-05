import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewQueuePlugin } from '../index.js'

// Review 5: the stop effect must WAIT for limitSignIn.cancel() (it restores the old login and drops the token backup); a host that exits right after the
// teardown returns would otherwise leave the user logged out with the backup on disk.
function ctxWith() {
  const effects = []
  const ctx = {
    on: () => {}, get: () => undefined, effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d) },
    logger: { warn() {}, info() {} }, inject: () => {},
  }
  return { ctx, effects }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('stopping the plugin waits for the sign-in cancel (restore) to finish', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  const { ctx, effects } = ctxWith()
  try {
    const plugin = createReviewQueuePlugin(ctx, { hub: false, stateDir: dir, taskbarBadge: false })
    let finished = false
    plugin.limitSignIn.cancel = async () => { await sleep(60); finished = true; return { ok: true } }
    for (const dispose of effects) await dispose()
    assert.equal(finished, true, 'teardown returned before the restore finished')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Regression review Low: a run that is committed (login verified, still finishing) answers no-run to cancel; the teardown must still wait for it to end.
test('stopping the plugin also waits for a committed run that cancel() refuses (no-run) to finish', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  const { ctx, effects } = ctxWith()
  try {
    const plugin = createReviewQueuePlugin(ctx, { hub: false, stateDir: dir, taskbarBadge: false })
    let finished = false
    plugin.limitSignIn.cancel = async () => ({ ok: false, error: 'no-run' })
    plugin.limitSignIn.whenDone = async () => { await sleep(60); finished = true }
    for (const dispose of effects) await dispose()
    assert.equal(finished, true, 'teardown did not wait for the committed run')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The taskbar badge is torn down AFTER the cancel step: its onChange unsubscribe running proves the rest of the teardown was reached.
function badgeProbe() {
  const probe = { off: false }
  const badgeDeps = {
    platform: 'win32', exists: () => true, spawn: () => { throw new Error('no spawn in tests') }, retryMs: 1e9, debounceMs: 1e9,
    queue: { count: () => ({ total: 0 }), onChange: () => () => { probe.off = true } },
  }
  return { probe, badgeDeps }
}

test('a failing cancel does not stop the rest of the teardown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  const { ctx, effects } = ctxWith()
  const { probe, badgeDeps } = badgeProbe()
  try {
    const plugin = createReviewQueuePlugin(ctx, { hub: false, stateDir: dir, taskbarBadge: true, badgeDeps })
    plugin.limitSignIn.cancel = async () => { throw new Error('boom') }
    for (const dispose of effects) await dispose()
    assert.equal(probe.off, true, 'the teardown after the cancel never ran')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a cancel that never finishes cannot stall the teardown past limitCancelTimeoutMs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  const { ctx, effects } = ctxWith()
  const { probe, badgeDeps } = badgeProbe()
  try {
    const plugin = createReviewQueuePlugin(ctx, { hub: false, stateDir: dir, taskbarBadge: true, badgeDeps, limitCancelTimeoutMs: 40 })
    plugin.limitSignIn.cancel = () => new Promise(() => {})
    const started = Date.now()
    for (const dispose of effects) await dispose()
    assert.equal(probe.off, true, 'the teardown after the cancel never ran')
    assert.ok(Date.now() - started < 2000, 'teardown waited for a hanging cancel')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})