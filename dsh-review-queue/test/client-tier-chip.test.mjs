// Slice 0.7 of the grouping/priority plan: the shadow tier chip on a card (severity + urgency, tier in the title). Display only; list order is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './client-todo-helpers.mjs'

const { mod, T } = loadClient()
const tierChip = mod.shared.tierChip

test('tierChip is exported through shared and __test', () => {
  assert.equal(typeof tierChip, 'function')
  assert.equal(T.tierChip, tierChip)
})

test('a blocked high-severity item shows P0 with severity and urgency', () => {
  const c = tierChip({ tier: { tier: 0, severity: 'high', urgency: 'blocked' } })
  assert.equal(c.text, 'P0 High')
  assert.match(c.title, /High severity/)
  assert.match(c.title, /blocked/)
  assert.equal(c.level, 0)
})

test('a free low-severity item shows P3 and says nothing is blocked', () => {
  const c = tierChip({ tier: { tier: 3, severity: 'low', urgency: 'free' } })
  assert.equal(c.text, 'P3 Low')
  assert.match(c.title, /not blocking/)
})

test('housekeeping severity is labelled Housekeeping', () => {
  assert.equal(tierChip({ tier: { tier: 4, severity: 'housekeeping', urgency: 'free' } }).text, 'P4 Housekeeping')
})

test('no chip without a usable tier', () => {
  assert.equal(tierChip(undefined), undefined)
  assert.equal(tierChip({}), undefined)
  assert.equal(tierChip({ tier: {} }), undefined)
  assert.equal(tierChip({ tier: { tier: 9, severity: 'high', urgency: 'free' } }), undefined)
  assert.equal(tierChip({ tier: { tier: 1, severity: 'weird', urgency: 'free' } }), undefined)
})
