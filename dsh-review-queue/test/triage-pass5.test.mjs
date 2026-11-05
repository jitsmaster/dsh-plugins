// Auto triage pass 5: PowerShell provider drives, planted binaries, comma arrays, ls needs a path, wider risk scan, device names, more protected names,
// a re-check right before approving, and log redaction. Observe is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReadOnlyCommand, isRiskyOption, recommendedOptionRefusal } from '../triage.js'
import { plantedBinary, PROTECTED_AUTO } from '../triage-paths.js'
import { createStore } from '../store.js'
import { createPermissionActor } from '../triage-act-permission.js'
import { createTriageRunner, DEFAULT_RULES } from '../triage-runner.js'

const auto = (c) => parseReadOnlyCommand(c, { auto: true })

test('P5-1: provider drives and alternate data streams are refused in Auto; a drive-qualified path passes', () => {
  for (const c of ['cat Env:OPENAI_API_KEY', 'ls Env:', 'ls Variable:', 'cat Function:prompt', 'ls HKCU:', 'ls Cert:', 'ls WSMan:', 'cat Alias:cat', 'cat file.txt:stream', 'cat C:/ws/a.txt:s', 'head --lines=Env:X a.txt']) {
    assert.equal(auto(c).ok, false, c)
  }
  assert.equal(auto('cat C:/ws/a.txt').ok, true)
  assert.equal(auto('cat c:/ws/a.txt').ok, true)
  assert.equal(auto('ls C:/ws').ok, true)
})

test('P5-1: observe is unchanged for colons', () => {
  assert.equal(parseReadOnlyCommand('cat Env:FOO').ok, true)
})

test('P5-2: plantedBinary vetoes a workspace file named like the binary (any listed extension, any case)', async () => {
  const io = (names) => ({ readdir: async () => names })
  for (const n of ['rg', 'RG.BAT', 'rg.cmd', 'Rg.exe', 'rg.com', 'rg.ps1', 'rg.js', 'rg.vbs']) assert.equal(await plantedBinary('/ws', 'rg', io([n])), true, n)
  for (const n of ['rg.txt', 'rgx.exe', 'a.bat', 'git.cmd']) assert.equal(await plantedBinary('/ws', 'rg', io([n])), false, n)
  assert.equal(await plantedBinary('/ws', 'cat', io([])), false)
  assert.equal(await plantedBinary('/ws', 'git', io(['git.cmd'])), true)
  assert.equal(await plantedBinary('/ws', 'rg', { readdir: async () => { throw new Error('x') } }), true, 'an unreadable root fails closed')
})

const GOOD = { needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null, matched_rule: 'ro-permission', attention: 10, reversible: true, touches_outside_workspace: false, read_only: true }
const fakeStore = () => { let n = 0; return createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n }) }
const rbase = { kind: 'ai-resolved', by: 'ai', ruleId: 'ro-permission' }
const permItem = (store, detail, workspace) => store.add({ type: 'permission', sessionId: 's1', workspace, payload: { toolName: 'shell', detail, summary: detail, callId: 'c1' } })

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('P5-2: the actor refuses (and never decides) when the workspace holds a planted binary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-p5-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'a')
    for (const [planted, ok] of [[undefined, true], ['cat.bat', false], ['CAT.EXE', false]]) {
      if (planted) writeFileSync(join(dir, planted), 'x')
      const store = fakeStore()
      const item = permItem(store, 'cat a.txt', dir)
      let decided = 0
      const res = await createPermissionActor({ store, decide: () => { decided++; return true } })({ item, resolutionBase: rbase, stillAllowed: () => true })
      assert.equal(res.ok, ok, String(planted))
      assert.equal(decided, ok ? 1 : 0)
      if (!ok) assert.equal(res.reason, 'not-read-only')
      if (planted) rmSync(join(dir, planted))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P5-2: the runner verdict path vetoes a planted binary (no approval)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-p5-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'cat.cmd'), 'x')
    const store = fakeStore()
    const decided = []
    const entries = []
    const runner = createTriageRunner({ store, judge: { judge: async () => ({ judgment: GOOD, raw: '' }) }, triageLog: { append: (e) => entries.push(e) }, rules: DEFAULT_RULES.map((r) => ({ ...r, mode: 'auto' })), actors: { permission: createPermissionActor({ store, decide: (id) => { decided.push(id); return true } }) } })
    runner.start()
    const item = permItem(store, 'cat a.txt', dir)
    await runner.idle()
    assert.equal(decided.length, 0)
    assert.equal(store.get(item.id).status, 'open')
    assert.ok(entries.some((e) => e.stage === 'judge' && e.reasons.includes('outside-workspace-real')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P5-3: commas and plus are shell syntax in Auto (PowerShell arrays hide a second file)', () => {
  for (const c of ['cat README.md,.env', 'cat package.json,.npmrc', 'head a.txt,b.txt', 'cat +x']) assert.deepEqual(auto(c), { ok: false, reason: 'shell syntax' }, c)
  assert.equal(parseReadOnlyCommand('cat a.txt,b.txt').ok, true, 'observe unchanged')
})

test('P5-4: ls needs an explicit path in Auto', () => {
  for (const c of ['ls', 'ls -la', 'ls -1', 'ls --all']) assert.equal(auto(c).ok, false, c)
  for (const c of ['ls src', 'ls -la src', 'ls .']) assert.equal(auto(c).ok, true, c)
  assert.equal(parseReadOnlyCommand('ls').ok, true, 'observe unchanged')
})

test('P5-5: non-ASCII letters (homoglyphs) are risky; symbols and combining marks are not', () => {
  for (const t of ['Мerge it', 'dеlete it', 'Εxecute', 'ｄelete']) assert.equal(isRiskyOption(t), true, t)
  for (const t of ['Use the Paused tab — Resume all (Recommended)', 'Yes, “continue” (Recommended)', 'Café menu is fine (Recommended)']) assert.equal(isRiskyOption(t), false, t)
})

test('P5-5: prefixes and more stems are risky; generic words are not', () => {
  for (const t of ['Redeploy', 'Reinstall it', 'Republish', 'Undelete', 'Unpublish', 'Nuke it', 'Obliterate', 'Format the disk', 'Clear all records', 'Empty the bin', 'Prune branches', 'Flush logs', 'Withdraw', 'Transfer funds',
    'Purchase', 'Sync to remote', 'Ship it', 'Go live', 'Submit the form', 'Write the file', 'Move it', 'Pull the branch', 'Checkout main', 'Scrub data', 'Trash it', 'Unlink it', 'Evict']) assert.equal(isRiskyOption(t), true, t)
  for (const t of ['Use the Paused tab Resume all (Recommended)', 'Yes, continue (Recommended)', 'Keep the current behaviour (Recommended)', 'Add the check in the UI, then you verify (Recommended)', 'Proceed with the plan (Recommended)']) assert.equal(isRiskyOption(t), false, t)
})

test('P5-5: the recommended-option veto uses it (Cyrillic option)', () => {
  const q = { question: 'Go on?', options: [{ label: 'Мerge (Recommended)' }, { label: 'No' }] }
  assert.equal(recommendedOptionRefusal({ answer: 'Мerge (Recommended)', needs_decision: false, reversible: true, touches_outside_workspace: false }, q), 'risky-option')
})

test('P5-6: Windows device names are refused in Auto', () => {
  for (const c of ['cat CON', 'tail NUL', 'cat COM1', 'wc -l AUX', 'head PRN', 'cat lpt9', 'cat con.txt', 'cat src/nul']) assert.equal(auto(c).ok, false, c)
  assert.equal(auto('cat concat.txt').ok, true)
  assert.equal(parseReadOnlyCommand('cat CON').ok, true, 'observe unchanged')
})

test('P5-7: more protected names, and trailing dot / space tolerance on dotted directories', () => {
  for (const c of ['cat .htpasswd', 'cat .pgpass', 'cat .vault-token', 'cat terraform.tfstate', 'cat x.tfstate', 'cat .my.cnf', 'cat local.settings.json', 'cat a.sqlite', 'cat a.sqlite3', 'cat sub/.pgpass',
    'cat .ssh./id', 'cat .aws./credentials', 'cat .kube./config', 'cat .docker./config.json', 'cat .git./config', 'cat .ssh.']) assert.equal(auto(c).reason, 'protected path', c)
  assert.equal(auto('cat notes.txt').ok, true)
  assert.ok(Array.isArray(PROTECTED_AUTO))
})

test('P5-8: the actor re-checks the live switch right before deciding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-p5-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'a')
    for (const [stillAllowed, ok] of [[() => true, true], [() => false, false], [undefined, false], [() => 'yes', false], [() => { throw new Error('x') }, false]]) {
      const store = fakeStore()
      const item = permItem(store, 'cat a.txt', dir)
      let decided = 0
      const res = await createPermissionActor({ store, decide: () => { decided++; return true } })({ item, resolutionBase: rbase, stillAllowed })
      assert.equal(res.ok, ok)
      assert.equal(decided, ok ? 1 : 0)
      if (!ok && res.reason !== 'error') assert.equal(res.reason, 'changed')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P5-8: flipping the switch or the mode during the actor await prevents approval', async () => {
  for (const flip of ['switch', 'mode', 'hold']) {
    const dir = mkdtempSync(join(tmpdir(), 'rq-p5-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'a')
      const store = fakeStore()
      let on = true
      let mode = 'auto'
      let held = false
      const decided = []
      const entries = []
      const real = createPermissionActor({ store, decide: (id) => { decided.push(id); return true } })
      const flipper = async (arg) => { if (flip === 'switch') on = false; else if (flip === 'mode') mode = 'observe'; else held = true; return real(arg) }
      const runner = createTriageRunner({ store, judge: { judge: async () => ({ judgment: GOOD, raw: '' }) }, triageLog: { append: (e) => entries.push(e) },
        rules: () => DEFAULT_RULES.map((r) => ({ ...r, mode })), enabled: () => on, marksOf: () => ({ onHold: held }), actors: { permission: flipper } })
      runner.start()
      permItem(store, 'cat a.txt', dir)
      await runner.idle()
      assert.equal(decided.length, 0, flip)
      assert.ok(entries.some((e) => e.stage === 'act' && e.reason === 'changed'), flip)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('P5-9: the act log redacts the question, the answer and the summary head', async () => {
  const secret = 'Bearer hunter2hunter2hunter2' // not a risky-scan stem, so the card still reaches the act log
  const entries = []
  const rule = { id: 'q', name: 'q', class: 'question', enabled: true, mode: 'auto' }
  const store2 = fakeStore()
  const runner2 = createTriageRunner({ store: store2, judge: { judge: async () => ({ judgment: { needs_decision: false, answer_basis: 'recommended-option', answer: 'A (Recommended)', matched_rule: 'q', attention: 5, reversible: true, touches_outside_workspace: false }, raw: '' }) },
    triageLog: { append: (e) => entries.push(e) }, rules: [rule], actors: { question: async () => ({ ok: true, action: 'answered', answer: 'ans ' + secret }) } })
  runner2.start()
  store2.add({ type: 'question', sessionId: 's1', payload: { summary: 'S ' + secret, callId: 'c1', questions: [{ question: 'Q ' + secret, options: [{ label: 'A (Recommended)' }, { label: 'B' }] }] } })
  await runner2.idle()
  const done = entries.find((e) => e.stage === 'act' && e.result === 'done')
  assert.ok(done, JSON.stringify(entries.map((e) => [e.stage, e.reasons])))
  const text = JSON.stringify(done.preState)
  assert.ok(!text.includes('hunter2'), text)
  assert.ok(text.includes('[redacted]'), text)
})
