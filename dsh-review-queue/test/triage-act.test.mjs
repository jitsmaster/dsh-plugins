// Slice 2 of Auto triage: the generic act plumbing in the runner. With no class actor a rule in auto mode still only observes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { createStore } from '../store.js'
import { createTriageRunner, DEFAULT_RULES } from '../triage-runner.js'

const GOOD = {
  needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null,
  matched_rule: 'ro-permission', attention: 10, reversible: true, touches_outside_workspace: false, read_only: true,
}
const perm = (detail = 'git status', payload = {}) => ({ type: 'permission', sessionId: 's1', workspace: tmpdir(), payload: { toolName: 'shell', detail, summary: detail, callId: 'c1', ...payload } })
const autoRules = () => DEFAULT_RULES.map((r) => ({ ...r, mode: 'auto' }))

/** hook: runs inside the judge call (after the raise, before the act), to change the world between judge and act. */
function setup({ actor, hook, rules = autoRules(), ...deps } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const entries = []
  const logLines = []
  const judge = { judge: async () => { await hook?.(store); return { judgment: GOOD, raw: '' } } }
  const calls = []
  const actors = actor ? { permission: async (arg) => { calls.push(arg); return actor(arg, store) } } : {}
  const runner = createTriageRunner({ store, judge, triageLog: { append: (e) => entries.push(e) }, log: (l) => logLines.push(l), rules, actors, ...deps })
  assert.equal(runner.start(), true)
  return { store, runner, entries, calls, logLines }
}
const approve = (arg, store) => { store.resolve(arg.item.id, { ...arg.resolutionBase, action: 'approve' }); return { ok: true, action: 'approve' } }
const act = (entries) => entries.filter((e) => e.stage === 'act')

test('no actor: an auto rule observes exactly as before (note only, judge entry records the rule mode)', async () => {
  const { store, runner, entries } = setup()
  const item = store.add(perm())
  await runner.idle()
  assert.equal(store.get(item.id).status, 'open')
  assert.equal(store.get(item.id).triage.mode, 'observe')
  assert.equal(store.get(item.id).triage.verdict, 'handle')
  assert.equal(entries.at(-1).stage, 'judge')
  assert.equal(entries.at(-1).mode, 'auto')
  assert.equal(act(entries).length, 0)
})

test('an observe rule with an actor never calls it', async () => {
  const { store, runner, calls, entries } = setup({ actor: approve, rules: DEFAULT_RULES })
  const item = store.add(perm())
  await runner.idle()
  assert.equal(calls.length, 0)
  assert.equal(store.get(item.id).triage.mode, 'observe')
  assert.equal(entries.at(-1).mode, 'observe')
})

test('actor success: act entry with preState, resolutionBase handed over, no note, not watched', async () => {
  const { store, runner, calls, entries } = setup({ actor: approve, now: () => 5000 })
  const item = store.add(perm('git status --token=abcdef123456 ' + 'x'.repeat(600)))
  await runner.idle()
  assert.equal(calls.length, 1)
  const base = calls[0].resolutionBase
  assert.deepEqual(base, { kind: 'ai-resolved', by: 'ai', ruleId: 'ro-permission', ruleVersion: base.ruleVersion, threshold: calls[0].outcome.threshold, score: 10, decidedAt: 5000, basis: 'none' })
  assert.match(base.ruleVersion, /^[0-9a-f]{8}$/)
  assert.equal(calls[0].rule.id, 'ro-permission')
  assert.equal(calls[0].judgment.matched_rule, 'ro-permission')
  const stored = store.get(item.id)
  assert.equal(stored.status, 'resolved')
  assert.equal(stored.resolution.by, 'ai')
  assert.equal(stored.triage, undefined)
  const [a] = act(entries)
  assert.equal(a.result, 'done')
  assert.equal(a.action, 'approve')
  assert.equal(a.mode, 'auto')
  assert.equal(a.ruleId, 'ro-permission')
  assert.equal(a.itemId, item.id)
  assert.equal(a.score, 10)
  assert.equal(a.basis, 'none')
  assert.equal(a.preState.type, 'permission')
  assert.equal(a.preState.sessionId, 's1')
  assert.equal(a.preState.toolName, 'shell')
  assert.ok(a.preState.command.length <= 500)
  assert.ok(!a.preState.command.includes('abcdef123456'), 'redacted')
  assert.ok(a.preState.summaryHead.length <= 200)
  await runner.idle()
  assert.equal(entries.filter((e) => e.stage === 'feedback').length, 0)
})

test('resolutionBase carries the capped quote (300) and the evidence source', async () => {
  const judgment = { ...GOOD, matched_rule: 'straightforward-question', answer: 'Yes', evidence_quote: 'q'.repeat(500), evidence_source: 'user-9', answer_basis: 'quoted-source' }
  let n = 0
  const store = createStore({ now: () => 1, uuid: () => 'i' + ++n })
  const seen = []
  const entries = []
  const runner = createTriageRunner({
    store, judge: { judge: async () => ({ judgment }) }, triageLog: { append: (e) => entries.push(e) }, rules: autoRules(),
    sourcesOf: () => [{ id: 'user-9', userAuthored: true, text: 'q'.repeat(500) + ' go ahead' }],
    actors: { question: async (arg) => { seen.push(arg); return { ok: false, reason: 'nope' } } },
  })
  runner.start()
  store.add({ type: 'question', sessionId: 's1', workspace: 'D:/w', payload: { callId: 'c1', questions: [{ id: 'q1', question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }] }] } })
  await runner.idle()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].resolutionBase.quote.length, 300)
  assert.equal(seen[0].resolutionBase.evidenceSource, 'user-9')
})

test('a payload change between judge and act is refused as changed-meanwhile; the actor is not called and no note is left', async () => {
  const { store, runner, calls, entries } = setup({
    actor: approve,
    hook: (s) => s.update(s.list({ status: 'open' })[0].id, { payload: { toolName: 'shell', detail: 'git log', summary: 'git status', callId: 'c1' } }),
  })
  const item = store.add(perm())
  await runner.idle()
  assert.equal(calls.length, 0)
  assert.equal(store.get(item.id).status, 'open')
  assert.equal(store.get(item.id).triage, undefined)
  const [a] = act(entries)
  assert.equal(a.result, 'refused')
  assert.equal(a.reason, 'changed-meanwhile')
})

test('a change to the summary alone is not part of the fingerprint', async () => {
  const { store, runner, calls } = setup({
    actor: approve,
    hook: (s) => s.update(s.list({ status: 'open' })[0].id, { payload: { toolName: 'shell', detail: 'git status', summary: 'a better summary arrived', callId: 'c1' } }),
  })
  const item = store.add(perm())
  await runner.idle()
  assert.equal(calls.length, 1)
  assert.equal(store.get(item.id).status, 'resolved')
})

test('a changed callId is refused', async () => {
  const { store, runner, calls, entries } = setup({
    actor: approve,
    hook: (s) => s.update(s.list({ status: 'open' })[0].id, { payload: { toolName: 'shell', detail: 'git status', summary: 'git status', callId: 'c2' } }),
  })
  store.add(perm())
  await runner.idle()
  assert.equal(calls.length, 0)
  assert.equal(act(entries)[0].reason, 'changed-meanwhile')
})

test('mode flipped to observe or off between judge and act: the actor is not called', async () => {
  for (const flipped of ['observe', 'off']) {
    let mode = 'auto'
    const { store, runner, calls, entries } = setup({
      actor: approve,
      rules: () => DEFAULT_RULES.map((r) => ({ ...r, mode })),
      hook: () => { mode = flipped },
    })
    const item = store.add(perm())
    await runner.idle()
    assert.equal(calls.length, 0, flipped)
    assert.equal(store.get(item.id).status, 'open', flipped)
    assert.equal(act(entries)[0]?.result, 'refused', flipped)
    assert.equal(act(entries)[0]?.reason, 'changed-meanwhile', flipped)
  }
})

test('switch turned off or an onHold / neverAuto mark set between judge and act: the actor is not called', async () => {
  let on = true
  const a = setup({ actor: approve, enabled: () => on, hook: () => { on = false } })
  a.store.add(perm())
  await a.runner.idle()
  assert.equal(a.calls.length, 0)
  for (const mark of ['onHold', 'neverAuto']) {
    let marks = {}
    const b = setup({ actor: approve, marksOf: () => marks, hook: () => { marks = { [mark]: true } } })
    const item = b.store.add(perm())
    await b.runner.idle()
    assert.equal(b.calls.length, 0, mark)
    assert.equal(b.store.get(item.id).status, 'open', mark)
  }
})

test('actor refusal or lost race: logged, the item stays an ordinary open card without a note', async () => {
  for (const [reason, expected] of [['nope', 'refused'], ['not-pending', 'lost-race'], ['lost-race', 'lost-race']]) {
    const { store, runner, entries } = setup({ actor: () => ({ ok: false, reason }) })
    const item = store.add(perm())
    await runner.idle()
    assert.equal(store.get(item.id).status, 'open')
    assert.equal(store.get(item.id).triage, undefined)
    assert.equal(act(entries)[0].result, expected, reason)
    assert.equal(act(entries)[0].reason, reason)
  }
})

test('an actor that throws is refused with reason error, logged, and run() does not throw', async () => {
  const { store, runner, entries, logLines } = setup({ actor: () => { throw new Error('boom') } })
  const item = store.add(perm())
  await runner.idle()
  assert.equal(store.get(item.id).status, 'open')
  assert.equal(act(entries)[0].result, 'refused')
  assert.equal(act(entries)[0].reason, 'error')
  assert.ok(logLines.some((l) => l.includes('boom')))
})
