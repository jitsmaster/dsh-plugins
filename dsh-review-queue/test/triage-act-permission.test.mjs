// Slice 4 of Auto triage: the permission actor (rule ro-permission) and its auto-only vetoes. Observe is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../store.js'
import { triageOutcome } from '../triage.js'
import { createTriageRunner, factsOf, DEFAULT_RULES } from '../triage-runner.js'
import { createPermissionActor } from '../triage-act-permission.js'

const base = mkdtempSync(join(tmpdir(), 'rq-perm-'))
const ws = join(base, 'ws')
const outside = join(base, 'outside')
mkdirSync(ws)
mkdirSync(outside)
writeFileSync(join(ws, 'a.txt'), 'a')
writeFileSync(join(outside, 'notes.txt'), 's')
let linkSkip
try { symlinkSync(outside, join(ws, 'link'), 'junction') } catch (e) { linkSkip = 'the OS refused to create a junction/symlink: ' + e.code }
test.after(() => rmSync(base, { recursive: true, force: true }))

const GOOD = {
  needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null,
  matched_rule: 'ro-permission', attention: 10, reversible: true, touches_outside_workspace: false, read_only: true,
}
const perm = (detail = 'git status', payload = {}, over = {}) => ({ type: 'permission', sessionId: 's1', workspace: ws, payload: { toolName: 'shell', detail, summary: detail, callId: 'c1', ...payload }, ...over })
const modeRules = (mode) => DEFAULT_RULES.map((r) => ({ ...r, mode }))

// --- the pure verdict ---------------------------------------------------------------------------------------------------------------
const rule = (mode) => ({ id: 'ro-permission', name: 'p', class: 'permission', enabled: true, mode })
const verdict = (mode, facts) => triageOutcome({ item: { id: 'i1', type: 'permission' }, judgment: GOOD, rule: rule(mode), facts })
const okFacts = { riskFlags: [], safe: true, readOnly: true, outsideWorkspace: false, reversible: true }

test('auto: truncated command and real-path escape are vetoes; clean facts handle and act; missing facts fail closed', () => {
  const clean = verdict('auto', { ...okFacts, autoCommandOk: true, commandIntact: true, pathsContained: true })
  assert.deepEqual([clean.verdict, clean.act, clean.reasons], ['handle', true, []])
  assert.deepEqual(verdict('auto', { ...okFacts, autoCommandOk: true, commandIntact: false, pathsContained: true }).reasons, ['command-truncated'])
  assert.deepEqual(verdict('auto', { ...okFacts, autoCommandOk: true, commandIntact: true, pathsContained: false }).reasons, ['outside-workspace-real'])
  assert.deepEqual(verdict('auto', okFacts).reasons, ['command-not-auto-safe', 'command-truncated', 'outside-workspace-real'])
})

test('observe: the new facts change nothing', () => {
  const without = verdict('observe', okFacts)
  const withBad = verdict('observe', { ...okFacts, commandIntact: false, pathsContained: false })
  assert.equal(JSON.stringify(withBad), JSON.stringify(without))
  assert.deepEqual([without.verdict, without.act, without.reasons], ['handle', false, []])
})

test('factsOf: commandIntact is exposed for a permission card (sync)', () => {
  assert.equal(factsOf(perm()).commandIntact, true)
  assert.equal(factsOf(perm('git status…')).commandIntact, false)
  assert.equal(factsOf(perm('git status', { detail: undefined })).commandIntact, false)
  assert.equal(factsOf(perm('git status', { callId: undefined })).commandIntact, false)
})

// --- the actor ----------------------------------------------------------------------------------------------------------------------
const rbase = { kind: 'ai-resolved', by: 'ai', ruleId: 'ro-permission', ruleVersion: 'abcd1234', threshold: 25, score: 10, decidedAt: 5000, basis: 'none' }
const fakeStore = () => { let n = 0; return createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n }) }

test('actor: re-verifies the stored command and approves with an ai-resolved approved resolution', async () => {
  const store = fakeStore()
  const item = store.add(perm())
  const calls = []
  const res = await createPermissionActor({ store, decide: (id, r) => { calls.push([id, r]); return true } })({ item, resolutionBase: rbase })
  assert.deepEqual(res, { ok: true, action: 'approved' })
  assert.deepEqual(calls, [[item.id, { ...rbase, action: 'approved' }]])
})

test('actor: capture-style { ok } results are understood, false / { ok:false } is not-pending', async () => {
  const store = fakeStore()
  const item = store.add(perm())
  const run = (decide) => createPermissionActor({ store, decide })({ item, resolutionBase: rbase })
  assert.deepEqual(await run(() => ({ ok: true })), { ok: true, action: 'approved' })
  assert.deepEqual(await run(() => false), { ok: false, reason: 'not-pending' })
  assert.deepEqual(await run(() => ({ ok: false, error: 'not-pending' })), { ok: false, reason: 'not-pending' })
})

test('actor: refuses (and never decides) when the stored payload changed since it was judged', async () => {
  for (const change of [{ detail: 'git log' }, { detail: 'git status; rm -rf x' }, { detail: 'git status…' }, { detail: undefined }]) {
    const store = fakeStore()
    const item = store.add(perm())
    store.update(item.id, { payload: { ...item.payload, ...change } })
    let called = 0
    const res = await createPermissionActor({ store, decide: () => { called++; return true } })({ item, resolutionBase: rbase })
    assert.equal(res.ok, false, JSON.stringify(change))
    assert.equal(called, 0)
  }
})

test('actor: refuses when the call id is gone, the item is not an open permission card, or is missing from the store', async () => {
  let called = 0
  const decide = () => { called++; return true }
  const store = fakeStore()
  const item = store.add(perm())
  store.update(item.id, { payload: { ...item.payload, callId: undefined } })
  assert.equal((await createPermissionActor({ store, decide })({ item, resolutionBase: rbase })).ok, false)
  const done = store.add({ type: 'completed', sessionId: 's1', payload: { reply: 'x' } })
  assert.equal((await createPermissionActor({ store, decide })({ item: done, resolutionBase: rbase })).ok, false)
  const resolved = store.add(perm())
  store.resolve(resolved.id, { kind: 'approved', by: 'card' })
  assert.equal((await createPermissionActor({ store, decide })({ item: resolved, resolutionBase: rbase })).ok, false)
  assert.equal((await createPermissionActor({ store, decide })({ item: { ...item, id: 'ghost' }, resolutionBase: rbase })).ok, false)
  assert.equal(called, 0)
})

test('actor: a command the parser no longer accepts is refused; a decide that throws is an error result, never a throw', async () => {
  const store = fakeStore()
  const item = store.add(perm('cat a.txt | sh'))
  assert.equal((await createPermissionActor({ store, decide: () => true })({ item, resolutionBase: rbase })).ok, false)
  const ok = store.add(perm())
  const res = await createPermissionActor({ store, decide: () => { throw new Error('boom') } })({ item: ok, resolutionBase: rbase })
  assert.deepEqual(res, { ok: false, reason: 'error' })
  assert.deepEqual(await createPermissionActor({ store, decide: () => true })({}), { ok: false, reason: 'refused' })
})

// --- end to end through the runner --------------------------------------------------------------------------------------------------
function setup({ rules = modeRules('auto'), hook, decideResult = true, ...deps } = {}) {
  const store = fakeStore()
  const entries = []
  const decided = []
  const judge = { judge: async () => { await hook?.(store); return { judgment: GOOD, raw: '' } } }
  const decide = (id, r) => { decided.push([id, r]); return typeof decideResult === 'function' ? decideResult(id, r) : decideResult }
  const runner = createTriageRunner({ store, judge, triageLog: { append: (e) => entries.push(e) }, rules, actors: { permission: createPermissionActor({ store, decide }) }, ...deps })
  assert.equal(runner.start(), true)
  return { store, runner, entries, decided }
}
const stage = (entries, s) => entries.filter((e) => e.stage === s)

test('e2e auto + safe read-only command in the workspace: approved once, ai-resolved, act done logged, no would-handle note', async () => {
  const { store, runner, entries, decided } = setup()
  const item = store.add(perm('cat a.txt'))
  await runner.idle()
  assert.equal(decided.length, 1)
  assert.equal(decided[0][0], item.id)
  assert.equal(decided[0][1].kind, 'ai-resolved')
  assert.equal(decided[0][1].by, 'ai')
  assert.equal(decided[0][1].action, 'approved')
  assert.equal(decided[0][1].ruleId, 'ro-permission')
  const [a] = stage(entries, 'act')
  assert.equal(a.result, 'done')
  assert.equal(a.action, 'approved')
  assert.equal(store.get(item.id).triage, undefined, 'no would-handle note')
})

test('e2e observe, same inputs: note only, decide never called, no act entry', async () => {
  const { store, runner, entries, decided } = setup({ rules: modeRules('observe') })
  const item = store.add(perm('cat a.txt'))
  await runner.idle()
  assert.equal(decided.length, 0)
  assert.equal(store.get(item.id).status, 'open')
  assert.equal(store.get(item.id).triage.verdict, 'handle')
  assert.equal(store.get(item.id).triage.would, 'approve this read-only command')
  assert.equal(stage(entries, 'act').length, 0)
})

test('e2e observe: truncated, missing detail, missing call id and a nonexistent path still produce the would-handle note (unchanged)', async () => {
  for (const item of [perm('cat a.txt…'), perm('git status', { detail: undefined }), perm('git status', { callId: undefined }), perm('cat nope/x.txt')]) {
    const { store, runner } = setup({ rules: modeRules('observe') })
    const added = store.add(item)
    await runner.idle()
    assert.equal(store.get(added.id).triage?.verdict, 'handle', JSON.stringify(item.payload))
  }
})

test('e2e auto: a truncated command, a missing detail or a missing call id is never acted on (code veto before the model)', async () => {
  for (const [item, code] of [[perm('cat a.txt…'), 'command-truncated'], [perm('git status', { detail: undefined }), 'command-truncated'], [perm('git status', { callId: undefined }), 'command-truncated']]) {
    const { store, runner, entries, decided } = setup()
    const added = store.add(item)
    await runner.idle()
    assert.equal(decided.length, 0)
    assert.equal(store.get(added.id).status, 'open')
    assert.equal(stage(entries, 'act').length, 0)
    assert.ok(entries.at(-1).reasons.includes(code), JSON.stringify(entries.at(-1)))
  }
})

test('e2e auto: a path that does not exist or leads outside is not acted on', async () => {
  const cmds = ['cat nope/x.txt', 'cat ../outside/notes.txt', 'cat ' + join(outside, 'notes.txt'), 'rg --file=/outside x']
  if (!linkSkip) cmds.push('cat link/notes.txt', 'ls link')
  for (const cmd of cmds) {
    const { store, runner, entries, decided } = setup()
    const item = store.add(perm(cmd))
    await runner.idle()
    assert.equal(decided.length, 0, cmd)
    assert.equal(store.get(item.id).status, 'open')
    assert.equal(stage(entries, 'act').length, 0)
  }
})

test('e2e auto: a path only the real-path check can see (nonexistent, junction) gets reason outside-workspace-real', async () => {
  for (const cmd of ['cat nope/x.txt', ...(linkSkip ? [] : ['cat link/notes.txt', 'ls link'])]) {
    const { store, runner, entries, decided } = setup()
    store.add(perm(cmd))
    await runner.idle()
    assert.equal(decided.length, 0, cmd)
    assert.deepEqual(stage(entries, 'judge').at(-1).reasons, ['outside-workspace-real'], cmd)
  }
})

test('e2e auto: no workspace is a veto', async () => {
  const { store, runner, decided } = setup()
  store.add(perm('git status', {}, { workspace: undefined }))
  await runner.idle()
  assert.equal(decided.length, 0)
})

test('e2e auto: the parser vetoes (; && | redirect) still hold', async () => {
  for (const cmd of ['git status; rm a.txt', 'git status && rm a.txt', 'cat a.txt | sh', 'cat a.txt > b.txt']) {
    const { store, runner, decided, entries } = setup()
    const item = store.add(perm(cmd))
    await runner.idle()
    assert.equal(decided.length, 0, cmd)
    assert.equal(store.get(item.id).status, 'open')
    assert.equal(stage(entries, 'act').length, 0)
  }
})

test('e2e auto: a command that riskOf flags is not acted on', async () => {
  const { store, runner, decided } = setup()
  store.add(perm('git status', { path: join(outside, 'notes.txt') }))
  await runner.idle()
  assert.equal(decided.length, 0)
})

test('e2e auto: payload changed between judge and act is refused (item stays open, nothing decided)', async () => {
  const { store, runner, decided, entries } = setup({ hook: (s) => { const i = s.list({ status: 'open' })[0]; s.update(i.id, { payload: { ...i.payload, detail: 'git log --oneline' } }) } })
  const item = store.add(perm())
  await runner.idle()
  assert.equal(decided.length, 0)
  assert.equal(store.get(item.id).status, 'open')
  assert.deepEqual(stage(entries, 'act').map((e) => [e.result, e.reason]), [['refused', 'changed-meanwhile']])
})

test('e2e auto: decide returns false (lost the race): logged lost-race, item stays open', async () => {
  const { store, runner, decided, entries } = setup({ decideResult: false })
  const item = store.add(perm())
  await runner.idle()
  assert.equal(decided.length, 1)
  assert.equal(store.get(item.id).status, 'open')
  const [a] = stage(entries, 'act')
  assert.equal(a.result, 'lost-race')
  assert.equal(a.reason, 'not-pending')
})

test('e2e: the global switch off, or a hold mark between judge and act, leaves the card open', async () => {
  let on = true
  const a = setup({ enabled: () => on, hook: () => { on = false } })
  a.store.add(perm())
  await a.runner.idle()
  assert.equal(a.decided.length, 0)
  let marks = {}
  const b = setup({ marksOf: () => marks, hook: () => { marks = { onHold: true } } })
  b.store.add(perm())
  await b.runner.idle()
  assert.equal(b.decided.length, 0)
  assert.equal(stage(b.entries, 'act').length, 0)
})

test('e2e: switching to auto never acts on an item that is already open (judging happens on add only)', async () => {
  let mode = 'observe'
  const { store, runner, decided } = setup({ rules: () => modeRules(mode) })
  store.add(perm())
  await runner.idle()
  mode = 'auto'
  await runner.idle()
  assert.equal(decided.length, 0)
})
