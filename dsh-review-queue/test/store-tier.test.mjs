import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'

function make(io) {
  let t = 1_000_000
  let n = 0
  return createStore({ now: () => t, uuid: () => 'id' + ++n, io })
}

const TYPES = {
  permission: { type: 'permission', sessionId: 's', payload: { toolName: 'Bash', detail: 'git status' } },
  question: { type: 'question', sessionId: 's', payload: { questions: [] } },
  completed: { type: 'completed', sessionId: 's', payload: { reply: 'done' } },
  paused: { type: 'paused', sessionId: 's', payload: {} },
  todo: { type: 'todo', payload: { } },
  onhold: { type: 'onhold', sessionId: 's', payload: {} },
  archive: { type: 'archive', sessionId: 's', payload: {} },
  'pr-merged': { type: 'pr-merged', sessionId: 's', payload: {} },
}

test('add stores a code-only tier on every item type', () => {
  const store = make()
  const expect = { permission: [0, 'high', 'blocked'], question: [1, 'medium', 'blocked'], completed: [3, 'low', 'free'], paused: [4, 'housekeeping', 'free'], todo: [4, 'housekeeping', 'free'], onhold: [4, 'housekeeping', 'free'], archive: [4, 'housekeeping', 'free'], 'pr-merged': [4, 'housekeeping', 'free'] }
  for (const [type, input] of Object.entries(TYPES)) {
    const item = store.add(input)
    assert.equal(item.tier.tier, expect[type][0], type + ' tier')
    assert.equal(item.tier.severity, expect[type][1], type + ' severity')
    assert.equal(item.tier.urgency, expect[type][2], type + ' urgency')
    assert.equal(item.tier.at, 1_000_000)
  }
})

test('a tier the caller passes in is replaced by the code-only one (no item arrives with a forged tier)', () => {
  const store = make()
  const item = store.add({ ...TYPES.permission, tier: { severity: 'low', urgency: 'free', tier: 4, at: 1 } })
  assert.equal(item.tier.tier, 0)
})

test('the tier is in the snapshot and survives save and load', () => {
  let saved
  const store = make({ read: () => saved, write: (t) => { saved = t } })
  store.add(TYPES.question)
  assert.equal(store.snapshot().open[0].tier.tier, 1)
  const again = make({ read: () => saved, write: () => {} })
  assert.equal(again.snapshot().open[0].tier.tier, 1)
})

test('update ignores a tier in the patch (no caller can forge or lower it that way)', () => {
  const store = make()
  const item = store.add(TYPES.permission)
  store.update(item.id, { summary: 's', tier: { severity: 'low', urgency: 'free', tier: 4, at: 5 } })
  assert.equal(store.get(item.id).tier.tier, 0)
  assert.equal(store.get(item.id).summary, 's')
})

test('setTier replaces the tier (the triage runner does this after the judge) and rejects a malformed one', () => {
  const store = make()
  const item = store.add(TYPES.question)
  assert.equal(store.setTier(item.id, { severity: 'high', urgency: 'blocked', tier: 0, at: 5, extra: 'x' }), true)
  assert.deepEqual(store.get(item.id).tier, { severity: 'high', urgency: 'blocked', tier: 0, at: 5 })
  for (const bad of [undefined, null, 'x', { severity: 'weird', urgency: 'free', tier: 1 }, { severity: 'low', urgency: 'free', tier: 9 }, { severity: 'low', urgency: 'later', tier: 3 }]) {
    assert.equal(store.setTier(item.id, bad), false)
  }
  assert.equal(store.get(item.id).tier.tier, 0)
  assert.equal(store.setTier('nope', { severity: 'low', urgency: 'free', tier: 3, at: 1 }), false)
})

test('setTier with an identical tier changes nothing (no version bump, no persist)', () => {
  const store = make()
  const item = store.add(TYPES.permission)
  const before = store.snapshot().snapshotId
  assert.equal(store.setTier(item.id, { ...store.get(item.id).tier }), true)
  assert.equal(store.snapshot().snapshotId, before)
})

test('setTier and restore reject a tier that does not match the matrix cell', () => {
  const store = make()
  const item = store.add(TYPES.permission)
  assert.equal(store.setTier(item.id, { severity: 'low', urgency: 'blocked', tier: 0, at: 1 }), false)
  assert.equal(store.get(item.id).tier.tier, 0)
  const old = JSON.stringify({ v: 1, seq: 1, items: [{ id: 'a', seq: 1, type: 'permission', status: 'open', createdAt: 1, sessionId: 's', payload: {}, tier: { severity: 'low', urgency: 'free', tier: 0, at: 1 } }] })
  assert.equal(make({ read: () => old, write: () => {} }).snapshot().open[0].tier.tier, 0)
  assert.equal(make({ read: () => old, write: () => {} }).snapshot().open[0].tier.severity, 'high')
})

test('a prototype-chain severity is not a valid tier', () => {
  const store = make()
  const item = store.add(TYPES.permission)
  for (const severity of ['toString', 'constructor', '__proto__']) {
    assert.equal(store.setTier(item.id, { severity, urgency: 'free', at: 1 }), false, severity)
  }
  const old = JSON.stringify({ v: 1, seq: 1, items: [{ id: 'a', seq: 1, type: 'permission', status: 'open', createdAt: 1, sessionId: 's', payload: {}, tier: { severity: 'toString', urgency: 'free' } }] })
  assert.equal(make({ read: () => old, write: () => {} }).snapshot().open[0].tier.severity, 'high')
})

test('a malformed or forged-shape tier in a restored file is rebuilt from code', () => {
  const mk = (tier) => JSON.stringify({ v: 1, seq: 1, items: [{ id: 'a', seq: 1, type: 'permission', status: 'open', createdAt: 1, sessionId: 's', payload: {}, tier }] })
  for (const bad of [{ severity: 'low', urgency: 'free', tier: 99 }, { severity: 'x', urgency: 'free', tier: 1 }, {}, []]) {
    assert.equal(make({ read: () => mk(bad), write: () => {} }).snapshot().open[0].tier.tier, 0)
  }
  const good = { severity: 'high', urgency: 'blocked', tier: 0, at: 3 }
  assert.deepEqual(make({ read: () => mk(good), write: () => {} }).snapshot().open[0].tier, good)
})

test('an item restored from an older file without a tier gets one on load', () => {
  const old = JSON.stringify({ v: 1, seq: 1, items: [{ id: 'a', seq: 1, type: 'completed', status: 'open', createdAt: 1, sessionId: 's', payload: { reply: 'x' } }] })
  const store = make({ read: () => old, write: () => {} })
  assert.equal(store.snapshot().open[0].tier.tier, 3)
})
