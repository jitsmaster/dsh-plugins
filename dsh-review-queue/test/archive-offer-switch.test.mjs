import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { createReviewQueuePlugin } from '../index.js'

// The archive switch (archiveOfferCommands) is shared by the marker/command paths and the session-link tool archive_self:
// the queue exposes it and a capability flag, so a plugin can detect an older queue.
function queueWith(extra = {}) {
  let t = 1000
  const store = createStore({ now: () => ++t })
  const speaker = { speak: () => ({ ok: true }), stop() {} }
  return createReviewQueue({ store, capture: {}, controllerOf: () => undefined, speaker, now: () => 5000, ...extra })
}

test('queue: supports.offerArchive is true and requireConfirm is still true', () => {
  const queue = queueWith()
  assert.equal(queue.supports.offerArchive, true)
  assert.equal(queue.supports.requireConfirm, true)
})

test('queue: archiveOfferEnabled() is true by default and follows the option', () => {
  assert.equal(queueWith().archiveOfferEnabled(), true)
  assert.equal(queueWith({ archiveOfferEnabled: () => true }).archiveOfferEnabled(), true)
  assert.equal(queueWith({ archiveOfferEnabled: () => false }).archiveOfferEnabled(), false)
})

test('queue: archiveOfferEnabled() reads the option on every call; only an explicit false turns it off', () => {
  let on = true
  const queue = queueWith({ archiveOfferEnabled: () => on })
  assert.equal(queue.archiveOfferEnabled(), true)
  on = false
  assert.equal(queue.archiveOfferEnabled(), false)
  on = undefined
  assert.equal(queue.archiveOfferEnabled(), true)
})

function hubWith(localExtra = {}) {
  const client = { state: 'connected', mirror: { ready: true, snapshot: () => ({ open: [], resolved: [] }), workspaces: () => [], onChange: () => () => {} }, onState: () => () => {}, call: async () => ({ ok: true }) }
  const local = { onChange: () => () => {}, stopTip() {}, uiState: () => undefined, snapshot: () => ({ open: [], resolved: [] }), ...localExtra }
  const speaker = { speak: () => ({ ok: true }), stop() {} }
  return createHubQueue({ local, client, speaker, controllerOf: () => ({}), now: () => 5000 })
}

test('hub queue: supports.offerArchive is true and archiveOfferEnabled() forwards to the local service (both values)', () => {
  let value = true
  const hub = hubWith({ archiveOfferEnabled: () => value })
  assert.equal(hub.supports.offerArchive, true)
  assert.equal(hub.supports.requireConfirm, true)
  assert.equal(hub.archiveOfferEnabled(), true)
  value = false
  assert.equal(hub.archiveOfferEnabled(), false)
})

test('hub queue: a local service without archiveOfferEnabled counts as disabled (fails closed) instead of throwing', () => {
  const hub = hubWith()
  assert.equal(hub.archiveOfferEnabled(), false)
})

function ctxWith() {
  const effects = []
  const ctx = {
    on: () => {}, get: () => undefined, effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d) },
    logger: { warn() {}, info() {} }, inject: () => {},
  }
  return { ctx, effects }
}

test('plugin: archiveOfferCommands: false gives local.archiveOfferEnabled() === false; the default is true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-arch-'))
  const { ctx, effects } = ctxWith()
  try {
    const off = createReviewQueuePlugin(ctx, { hub: false, stateDir: dir, taskbarBadge: false, archiveOfferCommands: false })
    assert.equal(off.local.archiveOfferEnabled(), false)
    const on = createReviewQueuePlugin(ctxWith().ctx, { hub: false, stateDir: dir, taskbarBadge: false })
    assert.equal(on.local.archiveOfferEnabled(), true)
    const explicit = createReviewQueuePlugin(ctxWith().ctx, { hub: false, stateDir: dir, taskbarBadge: false, archiveOfferCommands: true })
    assert.equal(explicit.local.archiveOfferEnabled(), true)
    for (const dispose of effects) await dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
