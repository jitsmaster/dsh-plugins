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

const GREEN_DONE = { ...GOOD, matched_rule: 'green-done', read_only: undefined, reversible: undefined, touches_outside_workspace: undefined }

test('observe mode now handles a done card of a finished session on paper, and the log records sessionContinues false', async () => {
  const { store, runner, calls, entries } = setup({ judgment: { ...GREEN_DONE, attention: 5 } }) // sessionContinuesOf defaults to false
  const item = store.add(done())
  await runner.idle()
  assert.equal(calls.length, 1)
  assert.equal(store.get(item.id).triage?.verdict, 'handle')
  assert.equal(store.get(item.id).triage?.ruleId, 'green-done')
  assert.equal(entries.at(-1).stage, 'judge')
  assert.equal(entries.at(-1).verdict, 'handle')
  assert.equal(entries.at(-1).reasons.includes('session-finished'), false)
  assert.equal(entries.at(-1).sessionContinues, false)
})

test('the judge log entry of a done card whose session continues records sessionContinues true', async () => {
  const { store, runner, entries } = setup({ judgment: GREEN_DONE, sessionContinuesOf: () => true })
  store.add(done())
  await runner.idle()
  assert.equal(entries.at(-1).stage, 'judge')
  assert.equal(entries.at(-1).sessionContinues, true)
})

test('the judge log entry of an asked done card (high score) also carries sessionContinues', async () => {
  const { store, runner, entries } = setup({ judgment: { ...GREEN_DONE, attention: 90 } })
  store.add(done())
  await runner.idle()
  assert.equal(entries.at(-1).verdict, 'ask')
  assert.equal(entries.at(-1).sessionContinues, false)
})

test('a code-veto record of a done card carries sessionContinues', async () => {
  for (const continues of [false, true]) {
    const { store, runner, calls, entries } = setup({ sessionContinuesOf: () => continues })
    store.add(done('All good. Should I merge it now?'))
    await runner.idle()
    assert.equal(calls.length, 0)
    assert.equal(entries.at(-1).stage, 'code-veto')
    assert.ok(entries.at(-1).reasons.includes('needs-user'))
    assert.equal(entries.at(-1).sessionContinues, continues)
  }
})

test('auto is never relaxed: an auto done rule on a finished session is still a code veto with no model call', async () => {
  const rules = DEFAULT_RULES.map((r) => ({ ...r, mode: 'auto' }))
  const { store, runner, calls, entries } = setup({ rules, judgment: GREEN_DONE })
  const item = store.add(done())
  await runner.idle()
  assert.equal(calls.length, 0)
  assert.equal(store.get(item.id).triage, undefined)
  assert.equal(entries.at(-1).stage, 'code-veto')
  assert.ok(entries.at(-1).reasons.includes('session-finished'))
})

test('factsOf: a done card whose reply only mentions a PR, a handoff or a ticket does not need the user; a question still does', () => {
  for (const reply of ['Tests pass.\n\nPR #123 is open.', 'Handoff written to the vault.', 'AB#25870 updated.']) {
    assert.equal(factsOf({ type: 'completed', payload: { reply } }).needsUser, false, reply)
  }
  assert.equal(factsOf({ type: 'completed', payload: { reply: 'PR #123 is open. Should I merge it?' } }).needsUser, true)
  assert.equal(factsOf({ type: 'completed', payload: { reply: '' } }).needsUser, true)
})

test('a done card that only mentions a PR is handled in observe mode, one that asks stays a normal card', async () => {
  const a = setup({ judgment: GREEN_DONE, sessionContinuesOf: () => true })
  const item = a.store.add(done('Merged the change.\n\nPR #123 is open.'))
  await a.runner.idle()
  assert.equal(a.calls.length, 1)
  assert.equal(a.store.get(item.id).triage?.verdict, 'handle')
  const b = setup({ judgment: GREEN_DONE, sessionContinuesOf: () => true })
  b.store.add(done('PR #123 is open. Should I merge it?'))
  await b.runner.idle()
  assert.equal(b.calls.length, 0)
})

test('the no-judgment record carries raw: the model reply on one line, clipped to 2000 characters', async () => {
  const raw = 'first line\n\n   second\tline ' + 'x '.repeat(2500)
  const { store, runner, entries } = setup({ judge: { judge: async () => ({ note: 'bad json', raw }) } })
  store.add(perm())
  await runner.idle()
  const e = entries.at(-1)
  assert.equal(e.reasons[0], 'no-judgment')
  assert.equal(e.note, 'bad json')
  assert.equal(typeof e.raw, 'string')
  assert.ok(e.raw.length <= 2000, 'raw length ' + e.raw.length)
  assert.ok(e.raw.length > 1900, 'raw is clipped to 2000, not cut short: ' + e.raw.length)
  assert.equal(/[\r\n\t]/.test(e.raw), false)
  assert.ok(e.raw.startsWith('first line second line x'))
})

test('the no-judgment raw is redacted BEFORE it is clipped, so a secret straddling char 2000 does not leak', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createTriageLog } = await import('../triage-log.js')
  const dir = mkdtempSync(join(tmpdir(), 'triage-raw-'))
  try {
    const file = join(dir, 'triage.jsonl')
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789SECRET'
    const raw = 'x '.repeat(987) + 'Authorization: Bearer ' + token // the token starts at about char 1996 and runs past 2000
    const { store, runner } = setup({ judge: { judge: async () => ({ note: 'bad json', raw }) }, triageLog: createTriageLog(file) })
    store.add(perm())
    await runner.idle()
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.length, 1)
    const rec = JSON.parse(lines[0])
    assert.equal(rec.reasons[0], 'no-judgment')
    assert.equal(typeof rec.raw, 'string')
    assert.ok(rec.raw.length <= 2000, 'raw length ' + rec.raw.length)
    assert.equal(/[\r\n]/.test(rec.raw), false)
    // a clip before redaction leaves under 8 token chars after 'Bearer', which the log's own redact cannot recognise, so check any leading fragment
    assert.equal(rec.raw.includes('abcd'), false, 'token fragment leaked: ' + rec.raw.slice(-40))
    assert.equal(rec.raw.includes('abcdefgh'), false)
    assert.ok(rec.raw.includes('[redacted]'), 'the Bearer token is redacted, not just cut: ' + rec.raw.slice(-40))
    assert.equal(rec.raw.includes(token), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the no-judgment record has NO raw key when the reply is empty or missing, and has one when it is not', async () => {
  const cases = [
    ['empty raw', async () => ({ note: 'x', raw: '' })],
    ['undefined raw', async () => ({ note: 'x', raw: undefined })],
    ['no raw at all', async () => ({ note: 'x' })],
    ['timeout note', async () => ({ note: 'timed out after 20 s', raw: '' })],
    ['thrown error', async () => { throw new Error('boom') }],
  ]
  for (const [label, judge] of cases) {
    const { store, runner, entries } = setup({ judge: { judge } })
    store.add(perm())
    await runner.idle()
    const e = entries.at(-1)
    assert.equal(e.reasons[0], 'no-judgment', label)
    assert.equal('raw' in e, false, label + ': raw key present')
  }
  const { store, runner, entries } = setup({ judge: { judge: async () => ({ note: 'bad json', raw: 'not json at all' }) } })
  store.add(perm())
  await runner.idle()
  assert.equal(entries.at(-1).raw, 'not json at all')
})

test('the no-judgment raw of a 300000-character reply is clipped to 2000 and built fast', async () => {
  const raw = 'a-'.repeat(150000)
  const { store, runner, entries } = setup({ judge: { judge: async () => ({ note: 'bad json', raw }) } })
  const t0 = performance.now()
  store.add(perm())
  await runner.idle()
  const ms = performance.now() - t0
  const e = entries.at(-1)
  assert.equal(e.reasons[0], 'no-judgment')
  assert.equal(typeof e.raw, 'string')
  assert.ok(e.raw.length <= 2000, 'raw length ' + e.raw.length)
  assert.ok(ms < 500, 'record took ' + Math.round(ms) + ' ms')
})
