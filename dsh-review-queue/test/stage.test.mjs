// Phase 1 of the AI triage plan: one first-match stage table that says, for every item, what it waits for and whether it counts as
// waiting on the user. waitingCount / pausedCount / heldCount / canAct all read it, so the rule exists once. No behaviour change:
// the "legacy" test below keeps the old per-type rule as the oracle and checks the table against it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './client-todo-helpers.mjs'

const { mod, T } = loadClient()
const stageOf = mod.shared.stageOf

const open = (over) => ({ id: 'i', status: 'open', ...over })
const todo = (over) => open({ type: 'todo', text: 'x', state: 'awaiting-confirm', ...over })

/** The rule as it was before the table (client.js waitingCount / pausedCount / heldCount), kept as the oracle. */
const legacyWaits = (i) => i.type !== 'paused' && i.type !== 'onhold' && !(i.type === 'todo' && i.state === 'starting')

test('stageOf is exported through shared and __test', () => {
  assert.equal(typeof stageOf, 'function')
  assert.equal(typeof T.stageOf, 'function')
  assert.equal(T.stageOf, stageOf)
})

test('stageOf: every open item type lands on exactly one stage (first match wins)', () => {
  const cases = [
    [open({ type: 'question' }), 'question', 'user', true],
    [open({ type: 'permission' }), 'permission', 'user', true],
    [open({ type: 'completed' }), 'review', 'user', true],
    [open({ type: 'pr-merged' }), 'archive-offer', 'user', true],
    [open({ type: 'archive' }), 'archive-offer', 'user', true],
    [open({ type: 'paused' }), 'paused', 'session', false],
    [open({ type: 'onhold' }), 'held', 'ticket', false],
    [todo(), 'todo-confirm', 'user', true],
    [todo({ suggested: { workspaceId: 'w' } }), 'todo-confirm', 'user', true],
    [todo({ suggesting: true }), 'todo-confirm', 'user', true],
    [todo({ state: 'failed', error: 'x' }), 'todo-failed', 'user', true],
    [todo({ state: 'starting' }), 'todo-starting', 'session', false],
  ]
  for (const [item, stage, waitsFor, counts] of cases) {
    const s = stageOf(item)
    assert.equal(s.stage, stage, JSON.stringify(item))
    assert.equal(s.waitsFor, waitsFor, stage + ' waitsFor')
    assert.equal(s.counts, counts, stage + ' counts')
    assert.equal(typeof s.label, 'string', stage + ' label')
    assert.ok(s.label.length > 0, stage + ' label not empty')
  }
})

test('stageOf: a follow-up todo goes through the same todo stages', () => {
  const fu = (over) => todo({ kind: 'followup', ...over })
  assert.equal(stageOf(fu()).stage, 'todo-confirm')
  assert.equal(stageOf(fu({ state: 'failed' })).stage, 'todo-failed')
  assert.equal(stageOf(fu({ state: 'starting' })).stage, 'todo-starting')
})

test('stageOf: resolved items are never waiting', () => {
  for (const type of ['question', 'permission', 'completed', 'pr-merged', 'archive', 'paused', 'onhold', 'todo']) {
    const s = stageOf({ id: 'r', type, status: 'resolved', resolution: { kind: 'reviewed' } })
    assert.equal(s.stage, 'resolved', type)
    assert.equal(s.waitsFor, 'none', type)
    assert.equal(s.counts, false, type)
  }
})

test('stageOf: a resolved item with an AI resolution is its own stage (phase 3 will use it), still never waiting', () => {
  const s = stageOf({ id: 'r', type: 'question', status: 'resolved', resolution: { kind: 'ai-resolved', by: 'ai' } })
  assert.equal(s.stage, 'resolved-ai')
  assert.equal(s.waitsFor, 'none')
  assert.equal(s.counts, false)
})

test('stageOf: an unknown type or an unknown todo state still counts as waiting (what the old rule did), and bad input does not throw', () => {
  assert.equal(stageOf(open({ type: 'something-new' })).stage, 'other')
  assert.equal(stageOf(open({ type: 'something-new' })).counts, true)
  assert.equal(stageOf(todo({ state: 'weird' })).stage, 'todo-other')
  assert.equal(stageOf(todo({ state: 'weird' })).counts, true)
  for (const bad of [undefined, null, {}, 'x', 5]) {
    const s = stageOf(bad)
    assert.equal(s.counts, false, String(bad))
    assert.equal(s.stage, 'none', String(bad))
  }
})

test('stageOf: an item with no status is read as open (the snapshot passes the open list)', () => {
  assert.equal(stageOf({ type: 'question' }).stage, 'question')
})

test('waitingCount / pausedCount / heldCount are the table, and agree with the old per-type rule on every shape', () => {
  const items = [
    open({ type: 'question' }), open({ type: 'permission' }), open({ type: 'completed' }), open({ type: 'pr-merged' }), open({ type: 'archive' }),
    open({ type: 'paused' }), open({ type: 'paused' }), open({ type: 'onhold' }),
    todo(), todo({ state: 'starting' }), todo({ state: 'failed' }), todo({ state: 'weird' }), todo({ kind: 'followup', state: 'starting' }),
    open({ type: 'something-new' }),
  ]
  assert.equal(T.waitingCount(items), items.filter(legacyWaits).length)
  assert.equal(T.waitingCount(items), items.filter((i) => stageOf(i).counts).length)
  assert.equal(mod.shared.pausedCount(items), 2)
  assert.equal(mod.shared.heldCount(items), 1)
  assert.equal(T.waitingCount(undefined), 0)
  assert.equal(mod.shared.pausedCount(undefined), 0)
  assert.equal(mod.shared.heldCount(undefined), 0)
})

test('every open item is in exactly one bucket: waiting + paused + held + other-not-waiting equals the open total', () => {
  const items = [
    open({ type: 'question' }), open({ type: 'paused' }), open({ type: 'onhold' }), todo({ state: 'starting' }), todo(), open({ type: 'completed' }),
  ]
  const waiting = T.waitingCount(items)
  const paused = mod.shared.pausedCount(items)
  const held = mod.shared.heldCount(items)
  const starting = items.filter((i) => stageOf(i).stage === 'todo-starting').length
  assert.equal(waiting + paused + held + starting, items.length)
})

test('canAct: a todo can be acted on exactly in the stages todo-confirm and todo-failed', () => {
  assert.equal(stageOf(todo()).canAct, true)
  assert.equal(stageOf(todo({ state: 'failed' })).canAct, true)
  assert.equal(stageOf(todo({ state: 'starting' })).canAct, false)
  assert.equal(stageOf(todo({ state: 'started', status: 'resolved' })).canAct, false)
  assert.equal(stageOf(open({ type: 'question' })).canAct, false)
})
