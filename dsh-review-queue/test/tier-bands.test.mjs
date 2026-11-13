// Slice 0 decision (2026-11-12): the model's attention score maps to severity 0-29 low, 30-69 medium, 70+ high. Advisory: it can only raise the code floor.
import test from 'node:test'
import assert from 'node:assert/strict'
import { severityFromAttention, severityOf, tierOf } from '../tier.js'

test('severityFromAttention bands', () => {
  assert.equal(severityFromAttention(0), 'low')
  assert.equal(severityFromAttention(29), 'low')
  assert.equal(severityFromAttention(30), 'medium')
  assert.equal(severityFromAttention(69), 'medium')
  assert.equal(severityFromAttention(70), 'high')
  assert.equal(severityFromAttention(100), 'high')
})

test('tierOf treats a prototype-chain severity as Medium', () => {
  assert.equal(tierOf('toString', 'free'), 2)
  assert.equal(tierOf('constructor', 'blocked'), 1)
})

test('severityFromAttention ignores a bad score', () => {
  for (const v of [undefined, null, NaN, '60', -5, 101, Infinity]) assert.equal(severityFromAttention(v), undefined)
})

test('severityOf: attention raises the floor but never lowers it', () => {
  assert.equal(severityOf({ item: { type: 'completed' }, judgment: { attention: 75 } }), 'high')
  assert.equal(severityOf({ item: { type: 'completed' }, judgment: { attention: 60 } }), 'medium')
  assert.equal(severityOf({ item: { type: 'permission' }, judgment: { attention: 5 } }), 'high')
  assert.equal(severityOf({ item: { type: 'completed' }, judgment: { attention: 10 } }), 'low')
})

test('severityOf: an explicit judge severity still counts alongside attention (the higher wins)', () => {
  assert.equal(severityOf({ item: { type: 'completed' }, judgment: { severity: 'high', attention: 10 } }), 'high')
})
