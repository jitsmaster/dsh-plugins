// Slice 3: the AI gate on ALL Auto rules: an item may be acted on only when its code-proven severity is Low or Housekeeping.
import test from 'node:test'
import assert from 'node:assert/strict'
import { triageOutcome } from '../triage.js'

const GOOD = { needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null, matched_rule: 'green-done', attention: 10 }
const rule = (mode) => ({ id: 'green-done', name: 'd', class: 'done', enabled: true, mode })
const okFacts = { riskFlags: [], safe: true, needsUser: false, sessionContinues: true, actionItem: false, summaryPending: false }
const run = (mode, over = {}) => triageOutcome({ item: { id: 'i1', type: 'completed', status: 'open' }, judgment: GOOD, rule: rule(mode), facts: okFacts, ...over })

test('auto: a Low severity done card still acts', () => {
  const o = run('auto')
  assert.deepEqual([o.verdict, o.act, o.reasons], ['handle', true, []])
})

test('auto: a card whose severity is above Low is kept (tier-above-auto)', () => {
  const o = run('auto', { judgment: { ...GOOD, severity: 'medium' } })
  assert.deepEqual([o.verdict, o.act], ['ask', false])
  assert.ok(o.reasons.includes('tier-above-auto'))
})

test('auto: a high severity is above Low too', () => {
  const o = run('auto', { judgment: { ...GOOD, severity: 'high' } })
  assert.ok(o.reasons.includes('tier-above-auto'))
})

test('observe: the gate never applies (paper handling is unchanged)', () => {
  const o = run('observe', { judgment: { ...GOOD, severity: 'high' } })
  assert.equal(o.reasons.includes('tier-above-auto'), false)
})

// Class floors: a question's own floor is Medium (the judge never lowers it), so an auto question rule may act at Medium but never above.
const qRule = { id: 'straightforward-question', name: 'q', class: 'question', enabled: true, mode: 'auto' }
const qItem = { id: 'q1', type: 'question', status: 'open' }
const runQ = (judgment) => triageOutcome({ item: qItem, judgment: { ...GOOD, matched_rule: 'straightforward-question', ...judgment }, rule: qRule, facts: okFacts })

test('auto question: Medium severity (its own floor) is not vetoed by the gate', () => {
  assert.equal(runQ({}).reasons.includes('tier-above-auto'), false)
})

test('auto question: a High severity is vetoed', () => {
  assert.ok(runQ({ severity: 'high' }).reasons.includes('tier-above-auto'))
})

test('auto question: a risk flag is vetoed', () => {
  const o = triageOutcome({ item: qItem, judgment: { ...GOOD, matched_rule: 'straightforward-question' }, rule: qRule, facts: { ...okFacts, riskFlags: ['x'] } })
  assert.ok(o.reasons.includes('tier-above-auto'))
})

test('auto: an attention score of 30+ maps to Medium, so the gate vetoes even when the rule threshold would allow it', () => {
  const o = run('auto', { judgment: { ...GOOD, attention: 35 }, rule: { ...rule('auto'), threshold: 50 } })
  assert.ok(o.reasons.includes('tier-above-auto'))
  assert.equal(o.act, false)
})
