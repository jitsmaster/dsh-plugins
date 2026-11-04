// Slice 2 of the AI triage plan: how an item resolved by the AI reads and filters, shared by the desktop overlay and the phone (exports.shared).
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './client-todo-helpers.mjs'

const { mod, T } = loadClient()
const S = mod.shared

const ai = (over = {}, item = {}) => ({ id: 'a' + Math.random(), type: 'permission', status: 'resolved', title: 'Run ls', resolution: { kind: 'ai-resolved', by: 'ai', action: 'approved', ruleId: 'r1', ...over }, ...item })
const me = (kind = 'approved', item = {}) => ({ id: 'm' + Math.random(), type: 'permission', status: 'resolved', title: 'Run pwd', resolution: { kind, by: 'card' }, ...item })
const open = (item = {}) => ({ id: 'o' + Math.random(), type: 'permission', status: 'open', title: 'Run cat', ...item })

test('the new helpers are exported through shared and __test', () => {
  for (const name of ['aiDetail', 'aiUnseenCount']) {
    assert.equal(typeof S[name], 'function', name + ' in shared')
    assert.equal(T[name], S[name], name + ' in __test')
  }
  assert.deepEqual(Array.from(S.RESOLVED_BY), ['all', 'me', 'ai'])
  assert.deepEqual(Array.from(T.RESOLVED_BY), ['all', 'me', 'ai'])
})

test('resolutionText says what the AI did', () => {
  const text = (over) => S.resolutionText(ai(over))
  assert.equal(text({ action: 'answered', answer: 'Use main' }), 'AI answered: Use main')
  assert.equal(text({ action: 'answered' }), 'AI answered')
  assert.equal(text({ action: 'approved' }), 'AI approved it')
  assert.equal(text({ action: 'cleared' }), 'AI cleared it as handled')
  assert.equal(text({ action: 'resumed' }), 'AI resumed the session')
  assert.equal(text({ action: 'teleported' }), 'Resolved by AI')
  assert.equal(text({ action: undefined }), 'Resolved by AI')
})

test('resolutionText appends the review outcome', () => {
  assert.equal(S.resolutionText(ai({ review: 'agreed' })), 'AI approved it (you agreed)')
  assert.equal(S.resolutionText(ai({ review: 'matched-user' })), 'AI approved it (you agreed)')
  assert.equal(S.resolutionText(ai({ review: 'overruled' })), 'AI approved it (you marked it wrong)')
  assert.equal(S.resolutionText(ai({ review: 'bogus' })), 'AI approved it')
  assert.equal(S.resolutionText(ai({ action: 'answered', answer: 'Yes', review: 'overruled' })), 'AI answered: Yes (you marked it wrong)')
  assert.equal(S.resolutionText(ai({ action: 'zzz', review: 'agreed' })), 'Resolved by AI (you agreed)')
})

test('resolutionText caps a long answer at 200 characters with an ellipsis', () => {
  const exact = 'a'.repeat(200)
  assert.equal(S.resolutionText(ai({ action: 'answered', answer: exact })), 'AI answered: ' + exact)
  assert.equal(S.resolutionText(ai({ action: 'answered', answer: 'b'.repeat(5000) })), 'AI answered: ' + 'b'.repeat(200) + '…')
  assert.equal(S.resolutionText(ai({ action: 'answered', answer: 'c'.repeat(201), review: 'agreed' })), 'AI answered: ' + 'c'.repeat(200) + '… (you agreed)')
})

test('resolutionText ignores an answer that is not a string and never throws', () => {
  for (const answer of [{ a: 1 }, ['x'], 42, true, null, undefined]) {
    const t = S.resolutionText(ai({ action: 'answered', answer }))
    assert.equal(t, 'AI answered')
    assert.ok(!t.includes('[object Object]'))
  }
})

test('resolutionText of other kinds is unchanged', () => {
  assert.equal(S.resolutionText({ resolution: { kind: 'approved', by: 'card' } }), 'Approved here')
  assert.equal(S.resolutionText({ resolution: { kind: 'weird' } }), 'Resolved')
})

test('aiDetail gives the quote, rule and rounded score of an AI-resolved item', () => {
  const d = S.aiDetail(ai({ quote: 'ls -la', ruleId: 'r1', score: 9.6 }, { triage: { ruleName: 'Read-only commands' } }))
  assert.deepEqual({ ...d }, { quote: 'ls -la', ruleName: 'Read-only commands', ruleId: 'r1', score: 10 })
  assert.equal(S.aiDetail(ai({ ruleId: 'r2', score: 3.4 })).ruleName, 'r2', 'the rule id stands in for a missing name')
  assert.equal(S.aiDetail(ai({ ruleId: 'r2', score: 3.4 })).score, 3)
  assert.equal(S.aiDetail(ai({ ruleId: 'r2' }, { triage: {} })).ruleName, 'r2')
})

test('aiDetail copes with a missing quote and a score that is not a finite number', () => {
  assert.equal(S.aiDetail(ai({})).quote, '')
  assert.equal(S.aiDetail(ai({ quote: 12 })).quote, '')
  for (const score of [undefined, null, '7', NaN, Infinity, -Infinity, {}]) assert.equal(S.aiDetail(ai({ score })).score, undefined, String(score))
  assert.equal(S.aiDetail(ai({ score: 0 })).score, 0)
})

test('aiDetail caps the quote at 300 characters with an ellipsis', () => {
  assert.equal(S.aiDetail(ai({ quote: 'q'.repeat(300) })).quote, 'q'.repeat(300))
  assert.equal(S.aiDetail(ai({ quote: 'q'.repeat(10000) })).quote, 'q'.repeat(300) + '…')
})

test('aiDetail is undefined for anything that is not a resolved AI-resolved item', () => {
  assert.equal(S.aiDetail(me()), undefined)
  assert.equal(S.aiDetail(open({ resolution: { kind: 'ai-resolved' } })), undefined)
  assert.equal(S.aiDetail(ai({}, { status: 'open' })), undefined)
  assert.equal(S.aiDetail({ status: 'resolved' }), undefined)
  assert.equal(S.aiDetail({ status: 'resolved', resolution: null }), undefined)
  for (const bad of [undefined, null, 'x', 5, []]) assert.equal(S.aiDetail(bad), undefined)
})

test('filterItems resolvedBy "ai" keeps only AI-resolved items among the resolved', () => {
  const a = ai(), m = me(), o = open()
  assert.deepEqual(S.filterItems([a, m], { type: 'all', query: '', resolvedBy: 'ai' }), [a])
  assert.deepEqual(S.filterItems([a, m, o], { type: 'all', query: '', resolvedBy: 'ai' }), [a, o], 'an open item is never filtered by it')
})

test('filterItems resolvedBy "me" keeps the resolved items the AI did not resolve', () => {
  const a = ai(), m = me(), m2 = me('denied'), noKind = { id: 'x', status: 'resolved' }, o = open(), noStatus = { id: 'ns', type: 'permission' }
  assert.deepEqual(S.filterItems([a, m, m2, noKind, o, noStatus], { resolvedBy: 'me' }), [m, m2, noKind, o, noStatus])
})

test('filterItems resolvedBy "all", missing and unknown values keep everything', () => {
  const items = [ai(), me(), open()]
  for (const resolvedBy of ['all', undefined, null, '', 'AI', 'bogus', 7, {}]) assert.equal(S.filterItems(items, { type: 'all', query: '', resolvedBy }).length, 3, String(resolvedBy))
  assert.equal(S.filterItems(items, { type: 'all', query: '' }).length, 3)
  assert.equal(S.filterItems(items, undefined).length, 3)
})

test('filterItems resolvedBy combines with the type filter and the text query', () => {
  const aPerm = ai({}, { title: 'Run ls' }), aDone = ai({}, { type: 'completed', title: 'Build ls' }), mPerm = me('approved', { title: 'Run ls' })
  assert.deepEqual(S.filterItems([aPerm, aDone, mPerm], { type: 'permission', query: '', resolvedBy: 'ai' }), [aPerm])
  assert.deepEqual(S.filterItems([aPerm, aDone, mPerm], { type: 'all', query: 'build', resolvedBy: 'ai' }), [aDone])
  assert.deepEqual(S.filterItems([aPerm, aDone, mPerm], { type: 'all', query: 'ls', resolvedBy: 'me' }), [mPerm])
  assert.deepEqual(S.filterItems([aPerm, mPerm], { type: 'completed', query: '', resolvedBy: 'ai' }), [])
})

test('aiUnseenCount counts AI-resolved items not yet seen or reviewed', () => {
  const list = [ai(), ai({ seen: true }), ai({ review: 'agreed' }), ai({ review: 'overruled' }), ai({ seen: false }), me(), ai({ seen: 'yes' })]
  assert.equal(S.aiUnseenCount(list), 3)
  assert.equal(S.aiUnseenCount([]), 0)
  assert.equal(S.aiUnseenCount([me(), me()]), 0)
  assert.equal(S.aiUnseenCount([{ resolution: null }, {}, null, undefined]), 0)
})

test('aiUnseenCount of something that is not an array is 0', () => {
  for (const bad of [undefined, null, 'x', 4, {}, { length: 2 }]) assert.equal(S.aiUnseenCount(bad), 0)
})

test('filterBarVisible stays as it was for the existing rules', () => {
  const few = { open: [open()], resolved: [me()] }
  assert.equal(S.filterBarVisible(few, { type: 'all', query: '' }), false)
  assert.equal(S.filterBarVisible(few, { type: 'all', query: 'x' }), true)
  assert.equal(S.filterBarVisible(few, { type: 'todo', query: '' }), true)
  assert.equal(S.filterBarVisible({ open: [open(), open()], resolved: [me(), me()] }, { type: 'all', query: '' }), true)
  assert.equal(S.filterBarVisible(few, { type: 'all', query: '', resolvedBy: 'all' }), false)
})

test('filterBarVisible shows while a resolvedBy filter is active', () => {
  const few = { open: [], resolved: [me()] }
  assert.equal(S.filterBarVisible(few, { type: 'all', query: '', resolvedBy: 'ai' }), true)
  assert.equal(S.filterBarVisible(few, { type: 'all', query: '', resolvedBy: 'me' }), true)
})

test('filterBarVisible shows once an AI-resolved item exists, so the AI filter can be reached', () => {
  assert.equal(S.filterBarVisible({ open: [], resolved: [ai()] }, { type: 'all', query: '' }), true)
  assert.equal(S.filterBarVisible({ open: [], resolved: [ai()] }, undefined), true)
  assert.equal(S.filterBarVisible({ open: [ai()], resolved: [] }, { type: 'all', query: '' }), false, 'only snap.resolved counts')
  assert.equal(S.filterBarVisible({ open: [], resolved: [me()] }, { type: 'all', query: '' }), false)
})

test('the desktop filter starts with resolvedBy "all"', () => {
  assert.deepEqual({ ...T.state.filter }, { type: 'all', query: '', resolvedBy: 'all', resolvedType: 'all' })
})
