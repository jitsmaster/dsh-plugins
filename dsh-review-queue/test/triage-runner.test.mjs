// Phase 2 of the AI triage plan: the observe-mode runner. It listens to store.onAdd, never blocks or loses the raise, never acts,
// and only puts a "would handle" note on the card; the user's later action is compared with it automatically.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createTriageRunner, factsOf, feedbackOf, pathsInside, ruleVersion, DEFAULT_RULES } from '../triage-runner.js'

const GOOD = {
  needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null,
  matched_rule: 'ro-permission', attention: 10, reversible: true, touches_outside_workspace: false, read_only: true,
}
const perm = (detail = 'git status', over = {}) => ({ type: 'permission', sessionId: 's1', workspace: 'D:/w', payload: { toolName: 'shell', detail, summary: detail }, ...over })
const done = (reply = 'Renamed the helper and ran the build.') => ({ type: 'completed', sessionId: 's1', workspace: 'D:/w', payload: { reply } })

function setup({ judgment = GOOD, judge, ...deps } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const calls = []
  const logLines = []
  const entries = []
  const j = judge ?? { judge: async (arg) => { calls.push(arg); return { judgment, raw: '' } } }
  const runner = createTriageRunner({ store, judge: j, triageLog: { append: (e) => entries.push(e) }, log: (l) => logLines.push(l), ...deps })
  assert.equal(runner.start(), true)
  return { store, runner, calls, logLines, entries }
}

test('store.onAdd announces each add once with a copy, and a throwing listener never loses the item', () => {
  const store = createStore()
  const seen = []
  store.onAdd(() => { throw new Error('bad listener') })
  const off = store.onAdd((item) => { seen.push(item); item.type = 'mutated' })
  const added = store.add({ type: 'question', sessionId: 's' })
  assert.equal(seen.length, 1)
  assert.equal(store.get(added.id).type, 'question')
  store.update(added.id, { x: 1 })
  assert.equal(seen.length, 1)
  off()
  store.add({ type: 'question' })
  assert.equal(seen.length, 1)
})

test('a safe read-only permission gets the AI-would-handle note and nothing is done to it', async () => {
  const { store, runner, calls, entries } = setup()
  const item = store.add(perm())
  assert.equal(store.get(item.id).triage, undefined) // the raise is not held up
  await runner.idle()
  const t = store.get(item.id).triage
  assert.equal(t.verdict, 'handle')
  assert.equal(t.mode, 'observe')
  assert.equal(t.ruleId, 'ro-permission')
  assert.equal(t.score, 10)
  assert.equal(store.get(item.id).status, 'open')
  assert.equal(calls.length, 1)
  assert.equal(entries.at(-1).verdict, 'handle')
  assert.match(entries.at(-1).ruleVersion, /^[0-9a-f]{8}$/)
})

test('a rule in auto mode still only observes in phase 2 (nothing is approved)', async () => {
  const rules = DEFAULT_RULES.map((r) => ({ ...r, mode: 'auto' }))
  const { store, runner } = setup({ rules })
  const item = store.add(perm())
  await runner.idle()
  assert.equal(store.get(item.id).status, 'open')
  assert.equal(store.get(item.id).triage.mode, 'observe')
})

test('a code veto means no model call at all (table)', async () => {
  const cases = [
    ['mutating command', perm('git push origin main')],
    ['chained', perm('git status; rm -rf x')],
    ['recursive delete', perm('rm -rf build')],
    ['protected file', perm('cat .env')],
    ['path outside the workspace', perm('cat D:/other/file.txt')],
    ['not a shell tool', perm('git status', { payload: { toolName: 'write_file', detail: 'git status' } })],
    ['done card that asks something', done('All good. Should I merge it now?')],
    ['done card of a finished session', done()], // sessionContinuesOf defaults to false
    ['a type triage never touches', { type: 'todo', text: 'x' }],
  ]
  for (const [name, input] of cases) {
    const { store, runner, calls, entries } = setup()
    const item = store.add(input)
    await runner.idle()
    assert.equal(calls.length, 0, name)
    assert.equal(store.get(item.id).triage, undefined, name)
    if (input.type !== 'todo') assert.equal(entries.at(-1).stage, 'code-veto', name)
  }
})

test('a done card is handled on paper only while the session continues', async () => {
  const { store, runner } = setup({ judgment: { ...GOOD, matched_rule: 'green-done', read_only: undefined, reversible: undefined, touches_outside_workspace: undefined }, sessionContinuesOf: () => true })
  const item = store.add(done())
  await runner.idle()
  assert.equal(store.get(item.id).triage.ruleId, 'green-done')
})

test('the model cannot lift a veto: a high score, a wrong rule, needs_decision or a user mark leave a normal card', async () => {
  const cases = [
    ['score above the threshold', { ...GOOD, attention: 80 }, {}],
    ['needs_decision', { ...GOOD, needs_decision: true }, {}],
    ['no rule matched', { ...GOOD, matched_rule: null }, {}],
    ['rule of another class', { ...GOOD, matched_rule: 'green-done' }, {}],
    ['advisory disagrees with code', { ...GOOD, read_only: false }, {}],
    ['on hold', GOOD, { marksOf: () => ({ onHold: true }) }],
  ]
  for (const [name, judgment, deps] of cases) {
    const { store, runner, calls, entries } = setup({ judgment, ...deps })
    const item = store.add(perm())
    await runner.idle()
    assert.equal(store.get(item.id).triage, undefined, name)
    assert.ok(calls.length <= 1, name)
    assert.ok(entries.length >= 1 && entries.every((e) => e.verdict === 'ask'), name)
  }
})

test('failures leave a normal card and never throw: no judgment, a throwing judge, a store without onAdd', async () => {
  const none = setup({ judge: { judge: async () => ({ note: 'timed out after 10 s', raw: '' }) } })
  const a = none.store.add(perm())
  await none.runner.idle()
  assert.equal(none.store.get(a.id).triage, undefined)
  assert.equal(none.entries.at(-1).reasons[0], 'no-judgment')

  const boom = setup({ judge: { judge: async () => { throw new Error('boom') } } })
  const b = boom.store.add(perm())
  await boom.runner.idle()
  assert.equal(boom.store.get(b.id).status, 'open')
  assert.equal(boom.entries.at(-1).reasons[0], 'no-judgment')

  const mirror = createTriageRunner({ store: { onChange: () => () => {} }, judge: {} })
  assert.equal(mirror.start(), false)
})

test('the user acting while the judge is thinking wins: no note is put on a resolved item', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { store, runner, entries } = setup({ judge: { judge: async () => { await gate; return { judgment: GOOD, raw: '' } } } })
  const item = store.add(perm())
  await Promise.resolve()
  store.resolve(item.id, { kind: 'approved', by: 'card' })
  release()
  await runner.idle()
  assert.equal(store.get(item.id).triage, undefined)
  assert.deepEqual(entries.at(-1).reasons, ['changed-meanwhile'])
})

test('a rule switched off, or triage disabled, means no judging', async () => {
  const off = setup({ rules: DEFAULT_RULES.map((r) => ({ ...r, mode: 'off' })) })
  off.store.add(perm())
  await off.runner.idle()
  assert.equal(off.calls.length, 0)
  let on = false
  const disabled = setup({ enabled: () => on })
  disabled.store.add(perm())
  await disabled.runner.idle()
  assert.equal(disabled.calls.length, 0)
  on = true
  disabled.store.add(perm())
  await disabled.runner.idle()
  assert.equal(disabled.calls.length, 1)
})

test('only maxInFlight judge calls run at once; the rest stay normal cards and are logged as busy', async () => {
  const gates = []
  let started = 0
  const judge = { judge: async () => { started++; await new Promise((r) => gates.push(r)); return { judgment: GOOD, raw: '' } } }
  const { store, runner, entries } = setup({ judge, maxInFlight: 2 })
  for (let i = 0; i < 4; i++) store.add(perm())
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(started, 2)
  assert.equal(entries.filter((e) => e.stage === 'skipped').length, 2)
  gates.forEach((g) => g())
  await runner.idle()
})

test('automatic observe feedback: the user approving matches, denying overrules, nothing else is compared', async () => {
  const run = async (resolution) => {
    const { store, runner, entries } = setup()
    const item = store.add(perm())
    await runner.idle()
    store.resolve(item.id, resolution)
    return { t: store.get(item.id).triage, entries }
  }
  const agreed = await run({ kind: 'approved', by: 'card' })
  assert.equal(agreed.t.review, 'matched-user')
  assert.equal(agreed.entries.at(-1).stage, 'feedback')
  assert.equal((await run({ kind: 'denied', by: 'card' })).t.review, 'overruled')
  assert.equal((await run({ kind: 'cancelled' })).t.review, undefined)
})

test('feedbackOf: done cards compare reviewed with replied; an item with no proposal gives nothing', () => {
  const base = { status: 'resolved', triage: { verdict: 'handle' } }
  assert.equal(feedbackOf({ ...base, type: 'completed', resolution: { kind: 'reviewed' } }), 'matched-user')
  assert.equal(feedbackOf({ ...base, type: 'completed', resolution: { kind: 'no-action' } }), 'matched-user')
  assert.equal(feedbackOf({ ...base, type: 'completed', resolution: { kind: 'replied' } }), 'overruled')
  assert.equal(feedbackOf({ type: 'completed', status: 'resolved', resolution: { kind: 'reviewed' } }), undefined)
  assert.equal(feedbackOf({ ...base, type: 'completed', status: 'open' }), undefined)
  assert.equal(feedbackOf({ ...base, triage: { verdict: 'handle', review: 'agreed' }, type: 'completed', resolution: { kind: 'replied' } }), undefined)
})

test('pathsInside: absolute paths must lie under the workspace; relative ones and flags are fine', () => {
  assert.equal(pathsInside('cat src/a.js', 'D:/w'), true)
  assert.equal(pathsInside('cat D:\\w\\src\\a.js', 'D:/w'), true)
  assert.equal(pathsInside('cat d:/W/a.js', 'D:/w'), true)
  assert.equal(pathsInside('cat D:/wx/a.js', 'D:/w'), false)
  assert.equal(pathsInside('cat /etc/passwd', 'D:/w'), false)
  assert.equal(pathsInside('cat ~/notes', 'D:/w'), false)
  assert.equal(pathsInside('cat D:/w/a.js', ''), false)
  assert.equal(pathsInside('git log -n 5', 'D:/w'), true)
})

test('factsOf is computed by code: risk flags and the parser decide, not the item wording', () => {
  const f = factsOf(perm('git status'))
  assert.deepEqual([f.safe, f.readOnly, f.outsideWorkspace, f.riskFlags], [true, true, false, []])
  assert.equal(factsOf(perm('git reset --hard')).safe, false)
  assert.equal(factsOf({ type: 'completed', payload: { reply: 'Done?' } }, { sessionContinuesOf: () => true }).needsUser, true)
  assert.equal(factsOf({ type: 'question', payload: {} }).safe, false)
})

test('ruleVersion changes when the instruction changes and is stable otherwise', () => {
  const r = DEFAULT_RULES[0]
  assert.equal(ruleVersion(r), ruleVersion({ ...r }))
  assert.notEqual(ruleVersion(r), ruleVersion({ ...r, instruction: r.instruction + ' Also x.' }))
})

test('review fix: a held session mark placed while the judge thinks vetoes the note (marks are read from the item as it is now)', async () => {
  let held = false
  let release
  const gate = new Promise((r) => { release = r })
  const { store, runner, entries } = setup({ judge: { judge: async () => { await gate; return { judgment: GOOD, raw: '' } } }, marksOf: () => ({ onHold: held }) })
  const item = store.add(perm())
  await Promise.resolve()
  held = true
  release()
  await runner.idle()
  assert.equal(store.get(item.id).triage, undefined)
  assert.equal(entries.at(-1).verdict, 'ask')
  assert.ok(entries.at(-1).reasons.includes('user-mark') || entries.at(-1).reasons.includes('changed-meanwhile'))
})

test('review fix: a proposal made before a restart still gets its feedback', () => {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const item = store.add(perm())
  store.update(item.id, { triage: { verdict: 'handle', ruleId: 'ro-permission', ruleVersion: 'abcd1234' } })
  const entries = []
  const runner = createTriageRunner({ store, judge: { judge: async () => ({}) }, triageLog: { append: (e) => entries.push(e) } })
  runner.start()
  store.resolve(item.id, { kind: 'approved', by: 'card' })
  assert.equal(store.get(item.id).triage.review, 'matched-user')
  assert.equal(entries.at(-1).stage, 'feedback')
  runner.stop()
})

test('review fix: stop() detaches both listeners', async () => {
  const { store, runner, calls } = setup()
  runner.stop()
  store.add(perm())
  await runner.idle()
  assert.equal(calls.length, 0)
})
