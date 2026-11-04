// Slice 3 of Auto triage: the done-card actor (rule green-done). Auto clears a done card only while the session still continues, and only with the
// auto-only vetoes (action item, summary pending); observe is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { triageOutcome } from '../triage.js'
import { createTriageRunner, factsOf, DEFAULT_RULES } from '../triage-runner.js'
import { createDoneActor } from '../triage-act-done.js'
import { loadClient } from './client-todo-helpers.mjs'

const GOOD = {
  needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null,
  matched_rule: 'green-done', attention: 10,
}
const REPLY = 'Renamed the helper and ran the build.'
const done = (over = {}) => ({ type: 'completed', sessionId: 's1', workspace: 'D:/w', summary: 'Renamed the helper.', summarySource: 'auto', payload: { reply: REPLY }, ...over })
const modeRules = (mode) => DEFAULT_RULES.map((r) => ({ ...r, mode }))

// --- the pure verdict: auto-only vetoes -----------------------------------------------------------------------------------------------
const rule = (mode) => ({ id: 'green-done', name: 'd', class: 'done', enabled: true, mode })
const verdict = (mode, facts) => triageOutcome({ item: { id: 'i1', type: 'completed', status: 'open' }, judgment: GOOD, rule: rule(mode), facts })
const okFacts = { riskFlags: [], safe: true, needsUser: false, sessionContinues: true }

test('auto: an action item or a pending summary vetoes a done card; clean facts handle and act', () => {
  const clean = verdict('auto', { ...okFacts, actionItem: false, summaryPending: false })
  assert.deepEqual([clean.verdict, clean.act, clean.reasons], ['handle', true, []])
  const action = verdict('auto', { ...okFacts, actionItem: true, summaryPending: false })
  assert.deepEqual([action.verdict, action.act, action.reasons], ['ask', false, ['action-item']])
  const pending = verdict('auto', { ...okFacts, actionItem: false, summaryPending: true })
  assert.deepEqual([pending.verdict, pending.act, pending.reasons], ['ask', false, ['summary-pending']])
  const both = verdict('auto', { ...okFacts, actionItem: true, summaryPending: true })
  assert.deepEqual(both.reasons, ['action-item', 'summary-pending'])
})

test('auto: facts that do not say either way fail closed (the runner always supplies them)', () => {
  assert.deepEqual(verdict('auto', okFacts).reasons, ['action-item', 'summary-pending'])
})

test('observe: the two new facts change nothing, the outcome is identical with and without them', () => {
  const without = verdict('observe', okFacts)
  for (const extra of [{ actionItem: true, summaryPending: true }, { actionItem: false, summaryPending: false }]) {
    assert.deepEqual(verdict('observe', { ...okFacts, ...extra }), without)
  }
  assert.equal(JSON.stringify(verdict('observe', { ...okFacts, actionItem: true, summaryPending: true })), JSON.stringify(without))
  assert.deepEqual([without.verdict, without.act, without.reasons], ['handle', false, []])
})

test('auto: the session-finished veto applies even when the runner relaxes it (only an observe rule is relaxed)', () => {
  const o = triageOutcome({ item: { id: 'i1', type: 'completed' }, judgment: GOOD, rule: rule('auto'), facts: { ...okFacts, sessionContinues: false, actionItem: false, summaryPending: false }, relax: { sessionFinished: true } })
  assert.deepEqual([o.verdict, o.act], ['ask', false])
  assert.deepEqual(o.reasons, ['session-finished'])
})

test('factsOf exposes actionItem and summaryPending from the card fields the auto-clear sweep reads', () => {
  const f = (item) => factsOf({ type: 'completed', payload: { reply: REPLY }, ...item })
  assert.equal(f({ summary: 'ok', summarySource: 'auto' }).actionItem, false)
  assert.equal(f({ summary: 'ok', summarySource: 'auto' }).summaryPending, false)
  assert.equal(f({ summary: 'Do <u>**this**</u>', summarySource: 'auto' }).actionItem, true)
  assert.equal(f({ summary: 'ok', summarySource: 'auto', actionable: true }).actionItem, true)
  assert.equal(f({ summary: 'ok' }).summaryPending, true, 'no summarySource yet')
  assert.equal(f({ summary: 'ok', summarySource: 'fallback' }).summaryPending, true)
  assert.equal(f({}).summaryPending, true)
})

// --- the actor ------------------------------------------------------------------------------------------------------------------------
const base = { kind: 'ai-resolved', by: 'ai', ruleId: 'green-done', ruleVersion: 'abcd1234', threshold: 25, score: 10, decidedAt: 5000, basis: 'none' }

test('actor: resolves an open done card with the resolution shape (action cleared, no quote), returns ok', async () => {
  const store = createStore({ now: () => 1000, uuid: () => 'i1' })
  const item = store.add(done())
  const res = await createDoneActor({ store })({ item, resolutionBase: base })
  assert.deepEqual(res, { ok: true, action: 'cleared' })
  const stored = store.get(item.id)
  assert.equal(stored.status, 'resolved')
  assert.deepEqual(stored.resolution, { ...base, action: 'cleared' })
  assert.ok(!('quote' in stored.resolution) && !('evidenceSource' in stored.resolution) && !('answer' in stored.resolution))
})

test('actor: an item that is already resolved is a lost race and stays unchanged', async () => {
  const store = createStore({ now: () => 1000, uuid: () => 'i1' })
  const item = store.add(done())
  store.resolve(item.id, { kind: 'reviewed', by: 'card' })
  const before = JSON.stringify(store.get(item.id))
  assert.deepEqual(await createDoneActor({ store })({ item, resolutionBase: base }), { ok: false, reason: 'lost-race' })
  assert.equal(JSON.stringify(store.get(item.id)), before)
})

test('actor: anything that is not a done card is refused and left open', async () => {
  let n = 0
  const store = createStore({ now: () => 1000, uuid: () => 'i' + ++n })
  const perm = store.add({ type: 'permission', sessionId: 's1', payload: { toolName: 'shell', detail: 'ls' } })
  const res = await createDoneActor({ store })({ item: perm, resolutionBase: base })
  assert.equal(res.ok, false)
  assert.equal(store.get(perm.id).status, 'open')
})

// --- shared UI helpers cope with a resolution that has no quote / answer / basis ------------------------------------------------------
test('a done card AI-cleared without quote, answer or basis reads cleanly through the shared helpers', () => {
  const { mod } = loadClient()
  const S = mod.shared
  const it = { id: 'x', type: 'completed', status: 'resolved', title: 'Done', resolution: { kind: 'ai-resolved', by: 'ai', action: 'cleared', ruleId: 'green-done', score: 10 } }
  assert.equal(S.isAiResolved(it), true)
  assert.equal(S.resolutionText(it), 'AI cleared it as handled')
  const d = S.aiDetail(it)
  assert.equal(d.quote, '')
  assert.equal(d.ruleId, 'green-done')
  assert.ok(!JSON.stringify(d).includes('undefined'))
})

// --- end to end through the runner ----------------------------------------------------------------------------------------------------
/** hook: runs inside the judge call (after the raise, before the act). */
function setup({ rules = modeRules('auto'), hook, judgment = GOOD, continues = true, ...deps } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const entries = []
  const judge = { judge: async () => { await hook?.(store); return { judgment, raw: '' } } }
  const runner = createTriageRunner({
    store, judge, triageLog: { append: (e) => entries.push(e) }, rules, sessionContinuesOf: () => continues,
    actors: { done: createDoneActor({ store }) }, ...deps,
  })
  assert.equal(runner.start(), true)
  return { store, runner, entries }
}
const stage = (entries, s) => entries.filter((e) => e.stage === s)

test('e2e auto + session continues: the card is resolved ai-resolved, logged as an act, with no "would handle" note', async () => {
  const { store, runner, entries } = setup()
  const item = store.add(done())
  await runner.idle()
  const s = store.get(item.id)
  assert.equal(s.status, 'resolved')
  assert.equal(s.resolution.kind, 'ai-resolved')
  assert.equal(s.resolution.by, 'ai')
  assert.equal(s.resolution.action, 'cleared')
  assert.equal(s.resolution.ruleId, 'green-done')
  assert.equal(s.triage, undefined, 'no would-handle note')
  const [a] = stage(entries, 'act')
  assert.equal(a.result, 'done')
  assert.equal(a.action, 'cleared')
  assert.equal(a.preState.type, 'completed')
})

test('e2e observe, same inputs: the card stays open with the would-handle note (unchanged)', async () => {
  const { store, runner, entries } = setup({ rules: modeRules('observe') })
  const item = store.add(done())
  await runner.idle()
  assert.equal(store.get(item.id).status, 'open')
  assert.equal(store.get(item.id).triage.verdict, 'handle')
  assert.equal(store.get(item.id).triage.would, 'clear this done card as handled')
  assert.equal(stage(entries, 'act').length, 0)
})

test('e2e auto + the session has finished: stays open, logged as ask (session-final veto), the judge is not even called', async () => {
  const { store, runner, entries } = setup({ continues: false })
  const item = store.add(done())
  await runner.idle()
  assert.equal(store.get(item.id).status, 'open')
  assert.equal(stage(entries, 'act').length, 0)
  const e = entries.at(-1)
  assert.equal(e.verdict, 'ask')
  assert.ok(e.reasons.includes('session-finished'))
})

test('e2e auto + an action item (bold summary or actionable) stays open', async () => {
  for (const over of [{ summary: 'Please check <u>**the build**</u>' }, { actionable: true }]) {
    const { store, runner, entries } = setup()
    const item = store.add(done(over))
    await runner.idle()
    assert.equal(store.get(item.id).status, 'open', JSON.stringify(over))
    assert.equal(stage(entries, 'act').length, 0)
    assert.ok(stage(entries, 'judge').at(-1).reasons.includes('action-item'))
  }
})

test('e2e auto + summary pending (fallback or none) stays open; the judge still ran', async () => {
  for (const over of [{ summarySource: 'fallback' }, { summarySource: undefined, summary: undefined }]) {
    const { store, runner, entries } = setup()
    const item = store.add(done(over))
    await runner.idle()
    assert.equal(store.get(item.id).status, 'open', JSON.stringify(over))
    assert.equal(stage(entries, 'act').length, 0)
    assert.ok(stage(entries, 'judge').at(-1).reasons.includes('summary-pending'))
  }
})

test('e2e auto: a summary that arrives while the judge runs counts (the verdict reads the card as it is after the judge)', async () => {
  const { store, runner } = setup({ hook: (s) => s.update(s.list({ status: 'open' })[0].id, { summary: 'Renamed the helper.', summarySource: 'auto', actionable: false }) })
  const item = store.add(done({ summary: 'fallback text', summarySource: 'fallback' }))
  await runner.idle()
  assert.equal(store.get(item.id).status, 'resolved')
})

test('e2e auto: an action item that arrives while the judge runs vetoes', async () => {
  const { store, runner } = setup({ hook: (s) => s.update(s.list({ status: 'open' })[0].id, { summary: 'Do <u>**this**</u>' }) })
  const item = store.add(done())
  await runner.idle()
  assert.equal(store.get(item.id).status, 'open')
})

test('e2e: the global switch off, or the item put on hold between judge and act, leaves the card open', async () => {
  let on = true
  const a = setup({ enabled: () => on, hook: () => { on = false } })
  const i1 = a.store.add(done())
  await a.runner.idle()
  assert.equal(a.store.get(i1.id).status, 'open')
  let marks = {}
  const b = setup({ marksOf: () => marks, hook: () => { marks = { onHold: true } } })
  const i2 = b.store.add(done())
  await b.runner.idle()
  assert.equal(b.store.get(i2.id).status, 'open')
  assert.equal(stage(b.entries, 'act').length, 0)
})

test('e2e: an AI-cleared done card can be reopened through the service; reopening records no review by itself', async () => {
  const { store, runner } = setup()
  const item = store.add(done())
  await runner.idle()
  assert.equal(store.get(item.id).status, 'resolved')
  const queue = createReviewQueue({ store, capture: {}, now: () => 9000 })
  assert.deepEqual(queue.reopen(item.id), { ok: true })
  assert.equal(store.get(item.id).status, 'open')
  assert.equal(store.get(item.id).resolution, undefined)
})
