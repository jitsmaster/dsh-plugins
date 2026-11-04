// Phase 3 slice 1: index.js wiring. With config.triage: true the queue gets a triageApi, and the runner shares the same rules and memory
// instances: a mode change or a correction made through the queue changes what the runner does at once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewQueuePlugin } from '../index.js'

const GOOD = {
  needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null,
  matched_rule: 'ro-permission', attention: 10, reversible: true, touches_outside_workspace: false, read_only: true,
}
const perm = (detail = 'git status') => ({ type: 'permission', sessionId: 's1', workspace: 'D:/w', payload: { toolName: 'shell', detail, summary: detail } })

function fakeCtx() {
  return {
    on: () => {}, get: () => undefined, effect: () => {}, logger: { warn() {}, info() {} },
    inject: (_names, fn) => fn({ effect: (f) => f(), connection: { admit: () => ({}) }, webServer: { register: () => {} } }),
  }
}

function boot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-triage-'))
  const calls = []
  const judge = { judge: async (arg) => { calls.push(arg); return { judgment: GOOD, raw: '' } } }
  const plugin = createReviewQueuePlugin(fakeCtx(), { hub: false, stateDir: dir, triage: true, triageDeps: { judge } })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { plugin, calls, dir }
}

test('with triage on, the queue serves the rule set and the lessons from a triageApi', (t) => {
  const { plugin } = boot(t)
  const out = plugin.local.triageRules()
  assert.equal(out.ok, true)
  assert.deepEqual(out.rules.map((r) => r.id), ['ro-permission', 'green-done', 'straightforward-question'])
  assert.deepEqual(out.lessons, [])
  assert.ok(out.rules.every((r) => r.mode === 'observe' && /^[0-9a-f]{8}$/.test(r.version)))
})

test('a mode change through the queue reaches the runner at once: switched off, a new item gets no judge call', async (t) => {
  const { plugin, calls } = boot(t)
  const before = plugin.store.add(perm())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(calls.length, 1) // control: observe judges
  assert.equal(plugin.store.get(before.id).triage?.verdict, 'handle')
  assert.deepEqual(plugin.local.triageRuleMode('ro-permission', 'off'), { ok: true })
  const after = plugin.store.add(perm())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(calls.length, 1)
  assert.equal(plugin.store.get(after.id).triage, undefined)
})

test('a correction recorded through the queue is seen by the runner: the same command is then held back by the shared memory', async (t) => {
  const { plugin, calls } = boot(t)
  const first = plugin.store.add(perm())
  plugin.store.resolve(first.id, { kind: 'ai-resolved', by: 'ai', action: 'approved', ruleId: 'ro-permission', ruleVersion: plugin.local.triageRules().rules[0].version, threshold: 8, basis: 'rule', evidenceSource: 'code', quote: 'git status', score: 10, decidedAt: 1 })
  assert.deepEqual(await plugin.local.triageReview(first.id, { review: 'overrule-rule' }), { ok: true })
  assert.equal(plugin.local.triageRules().lessons.length, 1)
  const again = plugin.store.add(perm())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(calls.length, 0)
  assert.equal(plugin.store.get(again.id).triage?.reason, 'past-correction')
})

// --- question triage reads the user's earlier messages from the session thread by default ---
import { writeLog } from './paused-helpers.mjs'
import { log as logRec } from './paused-helpers.mjs'

const QGOOD = { needs_decision: false, answer_basis: 'quoted-source', answer: 'Yes', evidence_quote: 'post both replies and resolve the threads', evidence_source: 'user-', matched_rule: 'straightforward-question', attention: 5 }
const question = () => ({ type: 'question', sessionId: 'sess-q', workspace: 'D:/w', payload: { questions: [{ id: 'q1', question: 'Post both replies and resolve the threads?', options: [{ label: 'Yes' }, { label: 'No' }] }] } })

function bootQuestion(t, triageDeps = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-triage-q-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  writeLog(join(dir, 'sessions'), 'sess-q', [[logRec.head(), logRec.turnStart(1), logRec.user('Please post both replies and resolve the threads.'), logRec.assistant('Done, shall I post?'), logRec.turnEnd(1)]])
  const calls = []
  const judge = { judge: async (arg) => { calls.push(arg); return { judgment: QGOOD, raw: '' } } }
  const plugin = createReviewQueuePlugin(fakeCtx(), { hub: false, stateDir: join(dir, 'state'), triage: true, triageDeps: { judge, ...triageDeps } })
  t.after(() => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; rmSync(dir, { recursive: true, force: true }) })
  return { plugin, calls }
}

test('the default rule set includes the straightforward-question rule in observe mode', (t) => {
  const { plugin } = boot(t)
  const rule = plugin.local.triageRules().rules.find((r) => r.id === 'straightforward-question')
  assert.equal(rule?.class, 'question')
  assert.equal(rule?.mode, 'observe')
})

test('by default the judge of a question gets the user messages of the session as quotable sources (assistant text never)', async (t) => {
  const { plugin, calls } = bootQuestion(t)
  plugin.store.add(question())
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(calls.length, 1)
  const sources = calls[0].sources
  assert.equal(sources.length, 1)
  assert.match(sources[0].id, /^user-/)
  assert.equal(sources[0].userAuthored, true)
  assert.equal(sources[0].text, 'Please post both replies and resolve the threads.')
})

test('config.triageDeps.sourcesOf overrides the default sources', async (t) => {
  const mine = [{ id: 'custom', text: 'custom source', userAuthored: true }]
  const { plugin, calls } = bootQuestion(t, { sourcesOf: () => mine })
  plugin.store.add(question())
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].sources, mine)
})

// --- the default sourcesOf only reads the thread for question items ---
function bootCounting(t, type) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-triage-src-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  writeLog(join(dir, 'sessions'), 'sess-q', [[logRec.head(), logRec.turnStart(1), logRec.user('Please do it.'), logRec.assistant('Done.'), logRec.turnEnd(1)]])
  const calls = []
  const judge = { judge: async (arg) => { calls.push(arg); return { judgment: type === 'permission' ? GOOD : { ...GOOD, matched_rule: 'green-done' }, raw: '' } } }
  const plugin = createReviewQueuePlugin(fakeCtx(), { hub: false, stateDir: join(dir, 'state'), triage: true, triageDeps: { judge } })
  t.after(() => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; rmSync(dir, { recursive: true, force: true }) })
  return { plugin, calls }
}

test('by default a permission item gets no thread sources (the judge sees an empty list)', async (t) => {
  const { plugin, calls } = bootCounting(t, 'permission')
  plugin.store.add({ type: 'permission', sessionId: 'sess-q', workspace: 'D:/w', payload: { toolName: 'shell', detail: 'git status', summary: 'git status' } })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].sources, [])
})

test('by default a done item gets no thread sources', async (t) => {
  const { plugin, calls } = bootCounting(t, 'completed')
  plugin.store.add({ type: 'completed', sessionId: 'sess-q', workspace: 'D:/w', payload: { reply: 'Renamed the helper and ran the build.' } })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].sources, [])
})
