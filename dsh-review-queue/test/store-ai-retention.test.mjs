// Phase 3 slice 1: "Resolved by AI" items are kept 30 days, every other resolved item keeps its 7-day retention.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as storeModule from '../store.js'

const { createStore, RETENTION_MS } = storeModule
const DAY = 24 * 3600 * 1000
const ai = { kind: 'ai-resolved', by: 'ai', action: 'approved', ruleId: 'ro-permission', ruleVersion: 'abcd1234', threshold: 8, basis: 'rule', evidenceSource: 'code', quote: 'git status', score: 10, decidedAt: 0 }

function setup() {
  let clock = 0
  let n = 0
  const store = createStore({ now: () => clock, uuid: () => 'i' + ++n })
  return { store, at: (ms) => { clock = ms } }
}

test('AI_RETENTION_MS is exported as 30 days and RETENTION_MS stays 7 days', () => {
  assert.equal(storeModule.AI_RETENTION_MS, 30 * DAY)
  assert.equal(RETENTION_MS, 7 * DAY)
})

test('an AI-resolved item 29 days old is kept by prune', () => {
  const { store, at } = setup()
  const item = store.add({ type: 'permission', sessionId: 's' })
  store.resolve(item.id, ai)
  at(29 * DAY)
  store.prune()
  assert.equal(store.get(item.id)?.status, 'resolved')
})

test('an AI-resolved item 31 days old is pruned', () => {
  const { store, at } = setup()
  const item = store.add({ type: 'permission', sessionId: 's' })
  store.resolve(item.id, ai)
  at(31 * DAY)
  store.prune()
  assert.equal(store.get(item.id), undefined)
})

test('a non-AI resolved item 8 days old is pruned while an AI one of the same age stays', () => {
  const { store, at } = setup()
  const human = store.add({ type: 'completed', sessionId: 's' })
  const bot = store.add({ type: 'completed', sessionId: 's' })
  store.resolve(human.id, { kind: 'reviewed', by: 'card' })
  store.resolve(bot.id, { ...ai, action: 'cleared' })
  at(8 * DAY)
  store.prune()
  assert.equal(store.get(human.id), undefined)
  assert.equal(store.get(bot.id)?.status, 'resolved')
})

test('a non-AI resolved item 6 days old is kept', () => {
  const { store, at } = setup()
  const human = store.add({ type: 'completed', sessionId: 's' })
  store.resolve(human.id, { kind: 'reviewed', by: 'card' })
  at(6 * DAY)
  store.prune()
  assert.equal(store.get(human.id)?.status, 'resolved')
})

test('open items are never pruned, however old', () => {
  const { store, at } = setup()
  const open = store.add({ type: 'question', sessionId: 's' })
  at(400 * DAY)
  store.prune()
  assert.equal(store.get(open.id)?.status, 'open')
})

test('the retentionMs option governs non-AI items only; AI retention stays 30 days', () => {
  let clock = 0
  const store = createStore({ now: () => clock, retentionMs: 1 * DAY })
  const human = store.add({ type: 'completed', sessionId: 's' })
  const bot = store.add({ type: 'completed', sessionId: 's' })
  store.resolve(human.id, { kind: 'reviewed', by: 'card' })
  store.resolve(bot.id, ai)
  clock = 2 * DAY
  store.prune()
  assert.equal(store.get(human.id), undefined)
  assert.equal(store.get(bot.id)?.status, 'resolved')
  clock = 31 * DAY
  store.prune()
  assert.equal(store.get(bot.id), undefined)
})
