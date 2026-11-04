// Security hardening of Auto triage (UNC paths, recursive search, git revisions, quote strength, tool arguments, log privacy). Observe is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseReadOnlyCommand, quoteSource, triageOutcome, AUTO_MIN_QUOTE_CHARS } from '../triage.js'
import { containedInWorkspace } from '../triage-paths.js'
import { createStore } from '../store.js'
import { installCapture } from '../capture.js'
import { createTriageRunner, factsOf, DEFAULT_RULES } from '../triage-runner.js'
import { createQuestionActor } from '../triage-act-question.js'
import { createPermissionActor } from '../triage-act-permission.js'

const base = mkdtempSync(join(tmpdir(), 'rq-hard-'))
const ws = join(base, 'ws')
mkdirSync(ws)
writeFileSync(join(ws, 'top.txt'), 't')
test.after(() => rmSync(base, { recursive: true, force: true }))

const auto = (c) => parseReadOnlyCommand(c, { auto: true })

// --- S1: UNC / device paths never reach the file system; % and ^ are shell syntax ---------------------------------------------------
test('S1: UNC, device and outside drive paths are vetoed before any file-system call', async () => {
  const bad = ['cat //attacker.example/share/x', 'cat \\\\attacker.example\\share\\x', 'cat \\\\?\\C:\\x', 'cat \\\\.\\pipe\\x', 'cat //./pipe/x', 'cat -f//attacker.example/s/x', 'cat Z:/definitely/outside.txt', 'cat C:\\Windows\\win.ini']
  for (const cmd of bad) {
    let calls = 0
    const io = { real: async (p) => { calls++; return p } }
    assert.equal(await containedInWorkspace(cmd, ws, io), false, cmd)
    // the workspace itself may be resolved, but never the hostile candidate
    assert.ok(calls <= 1, cmd + ' resolved a candidate (calls=' + calls + ')')
  }
})

test('S1: a UNC candidate causes no file-system call at all, a lexically outside one resolves nothing but the root', async () => {
  const seen = []
  const io = { real: async (p) => { seen.push(p); return p } }
  assert.equal(await containedInWorkspace('cat //attacker.example/share/x', ws, io), false)
  assert.deepEqual(seen, [], 'not even the workspace root is resolved')
  assert.equal(await containedInWorkspace('cat Z:/outside/x', ws, io), false)
  assert.deepEqual(seen, [ws], 'only the workspace root is resolved')
})

test('S1: a contained path still resolves through the injected real', async () => {
  const io = { real: async (p) => p }
  assert.equal(await containedInWorkspace('cat top.txt', ws, io), true)
})

test('S1: % and ^ are shell syntax in auto, observe is unchanged', () => {
  for (const c of ['cat %USERPROFILE%/x', 'cat a^b', 'git show HEAD^']) {
    assert.equal(auto(c).ok, false, c)
    assert.equal(parseReadOnlyCommand(c).ok, true, 'observe: ' + c)
  }
})

// --- S2: recursive / hidden search, git revisions ----------------------------------------------------------------------------------
test('S2: rg/grep may only read explicit files in auto', () => {
  const bad = ['rg -r x foo a.txt', 'grep -rn foo a.txt', 'grep -R foo a.txt', 'grep -iR foo a.txt', 'grep --recursive foo a.txt', 'grep --dereference-recursive foo a.txt', 'grep -L foo a.txt',
    'rg --follow foo a.txt', 'rg --hidden foo a.txt', 'rg -u foo a.txt', 'rg -uu foo a.txt', 'rg -uuu foo a.txt', 'rg --no-ignore foo a.txt', 'rg --no-ignore-vcs foo a.txt',
    'rg --search-zip foo a.txt', 'rg -z foo a.txt', 'rg -nz foo a.txt', 'rg foo', 'grep foo', 'rg --files']
  for (const c of bad) assert.equal(auto(c).ok, false, c)
  for (const c of ['rg foo a.txt', 'grep -n foo a.txt', 'grep -in foo a.txt b.txt', 'rg -n -i foo src/a.js']) assert.equal(auto(c).ok, true, c)
})

test('S2: observe still accepts what it accepted', () => {
  for (const c of ['rg -r x foo', 'grep -rn foo', 'rg --hidden foo', 'rg foo', 'git show HEAD:README.md', 'git log -p']) assert.equal(parseReadOnlyCommand(c).ok, true, c)
})

test('S2: git in auto: no revision:path, no patch / pickaxe options', () => {
  const bad = ['git show HEAD:.env', 'git show HEAD:src/a.js', 'git show :0:a.js', 'git log -p', 'git log --patch', 'git show -p HEAD', 'git log -Gsecret', 'git log -Ssecret', 'git diff -c', 'git diff --cc', 'git log -pw']
  for (const c of bad) assert.equal(auto(c).ok, false, c)
  for (const c of ['git status', 'git diff', 'git log --oneline -5', 'git diff HEAD~1 --stat', 'git show HEAD --stat']) assert.equal(auto(c).ok, true, c)
})

test('S2: more protected paths in auto (every colon / equals segment is tested), observe unchanged', () => {
  const bad = ['cat .npmrc', 'cat .netrc', 'cat .pypirc', 'cat .kube/config', 'cat .docker/config.json', 'cat .git-credentials', 'cat appsettings.json', 'cat appsettings.Production.json', 'cat src/appsettings.Dev.json',
    'cat prod.tfvars', 'cat vault.kdbx', 'cat --file=.env', 'cat x:.env', 'git show HEAD:.npmrc']
  for (const c of bad) assert.equal(auto(c).ok, false, c)
  for (const c of ['cat .npmrc', 'cat appsettings.json', 'cat prod.tfvars', 'cat vault.kdbx']) assert.equal(parseReadOnlyCommand(c).ok, true, 'observe: ' + c)
  assert.equal(parseReadOnlyCommand('cat --file=.env').ok, true, 'observe keeps its old behaviour')
  assert.equal(parseReadOnlyCommand('cat .env').ok, false)
})

// --- S3: quote strength + recommended option ---------------------------------------------------------------------------------------
const REC = 'Yes, post and resolve (Recommended)'
const NO = 'No, let me review first'
const item = (options = [{ label: REC }, { label: NO }]) => ({ type: 'question', payload: { callId: 'c1', questions: [{ id: 'q1', question: 'Post?', options }] } })
const QUOTE = 'post both replies and resolve the threads'
const SOURCES = [{ id: 'user-9', text: 'Please ' + QUOTE + ' once the tests pass.', userAuthored: true }]
const GOOD = { needs_decision: false, answer_basis: 'quoted-source', answer: REC, evidence_quote: QUOTE, evidence_source: 'user-9', matched_rule: 'straightforward-question', attention: 5 }
const qrule = (mode) => ({ id: 'straightforward-question', class: 'question', enabled: true, mode })
const verdict = (mode, { it = item(), judgment = GOOD, sources = SOURCES } = {}) => triageOutcome({ item: it, judgment, rule: qrule(mode), facts: factsOf(it), sources })

test('S3: auto needs a recommended option and answers exactly it', () => {
  assert.deepEqual(verdict('auto').reasons, [])
  assert.deepEqual(verdict('auto', { it: item([{ label: 'Yes' }, { label: NO }]), judgment: { ...GOOD, answer: 'Yes' } }).reasons, ['no-recommended-option'])
  assert.deepEqual(verdict('auto', { judgment: { ...GOOD, answer: NO } }).reasons, ['answer-not-recommended'])
  assert.deepEqual(verdict('observe', { it: item([{ label: 'Yes' }, { label: NO }]), judgment: { ...GOOD, answer: 'Yes' } }).reasons, [])
})

test('S3: the quote must be at least 20 characters in auto, observe keeps its 8', () => {
  assert.equal(AUTO_MIN_QUOTE_CHARS, 20)
  const short = { ...GOOD, evidence_quote: 'resolve the' } // 11 chars
  const src = [{ id: 'user-9', text: 'please resolve the threads', userAuthored: true }]
  assert.deepEqual(verdict('auto', { judgment: short, sources: src }).reasons, ['inadmissible-evidence'])
  assert.deepEqual(verdict('observe', { judgment: short, sources: src }).reasons, [])
  assert.equal(quoteSource('resolve the', src), 'user-9')
  assert.equal(quoteSource('resolve the', src, AUTO_MIN_QUOTE_CHARS), undefined)
  assert.equal(quoteSource('please resolve the threads', src, AUTO_MIN_QUOTE_CHARS), 'user-9')
})

test('S3: the actor re-checks the recommended option and the quote length on its own', async () => {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const add = (options) => store.add({ type: 'question', sessionId: 's1', workspace: 'D:/w', payload: { callId: 'c1', questions: [{ id: 'q1', question: 'Post?', options }] } })
  const actor = createQuestionActor({ store, answer: () => true })
  const run = (it, judgment) => actor({ item: it, judgment, resolutionBase: {} })
  const rec = add([{ label: REC }, { label: NO }])
  assert.equal((await run(rec, GOOD)).ok, true)
  assert.deepEqual(await run(rec, { ...GOOD, answer: NO }), { ok: false, reason: 'refused' })
  assert.deepEqual(await run(rec, { ...GOOD, evidence_quote: 'resolve the' }), { ok: false, reason: 'refused' })
  const plain = add([{ label: 'Yes' }, { label: NO }])
  assert.deepEqual(await run(plain, { ...GOOD, answer: 'Yes' }), { ok: false, reason: 'refused' })
})

// --- S4: tool arguments and exact tool names ----------------------------------------------------------------------------------------
const perm = (over = {}) => ({ type: 'permission', sessionId: 's1', workspace: ws, payload: { toolName: 'shell', detail: 'git status', summary: 'shell: git status', callId: 'c1', ...over } })

test('S4: auto facts: only exact shell tool names, and no arguments beside the command', () => {
  assert.equal(factsOf(perm()).autoCommandOk, true)
  for (const toolName of ['bash', 'powershell', 'pwsh', 'cmd', 'Shell']) assert.equal(factsOf(perm({ toolName })).autoCommandOk, true, toolName)
  for (const toolName of ['exec_anything', 'command_runner', 'my-bash-wrapper']) {
    const f = factsOf(perm({ toolName }))
    assert.equal(f.autoCommandOk, false, toolName)
    assert.equal(f.readOnly, true, 'observe facts keep the broad match: ' + toolName)
  }
  assert.equal(factsOf(perm({ extraArgs: true })).autoCommandOk, false)
  assert.equal(factsOf(perm({ extraArgs: true })).safe, true, 'observe safety is unchanged')
})

test('S4: auto verdict vetoes on autoCommandOk, missing fact fails closed', () => {
  const rule = { id: 'ro-permission', class: 'permission', enabled: true, mode: 'auto' }
  const judgment = { needs_decision: false, matched_rule: 'ro-permission', attention: 5 }
  const it = perm()
  const f = factsOf(it)
  const run = (facts) => triageOutcome({ item: it, judgment, rule, facts: { ...f, commandIntact: true, pathsContained: true, ...facts } })
  assert.deepEqual(run({}).reasons, [])
  assert.deepEqual(run({ autoCommandOk: false }).reasons, ['command-not-auto-safe'])
  assert.deepEqual(run({ autoCommandOk: undefined }).reasons, ['command-not-auto-safe'])
})

test('S4: the permission actor re-checks the auto parser and the extra-arguments flag', async () => {
  let n = 0
  const store = createStore({ now: () => 1000 + n, uuid: () => 'i' + ++n })
  const actor = createPermissionActor({ store, decide: () => true })
  const ok = store.add(perm())
  assert.equal((await actor({ item: ok, resolutionBase: {} })).ok, true)
  const rec = store.add(perm({ detail: 'rg -r foo', summary: 'x' }))
  assert.equal((await actor({ item: rec, resolutionBase: {} })).ok, false)
  const extra = store.add(perm({ extraArgs: true }))
  assert.equal((await actor({ item: extra, resolutionBase: {} })).ok, false)
})

test('S4: capture notes extra tool arguments on the permission payload', async () => {
  const handlers = {}
  const ctx = { on: (name, fn) => { (handlers[name] ??= []).push(fn) }, get: () => undefined, logger: { warn() {}, info() {} } }
  let n = 0
  const store = createStore({ now: () => 1000, uuid: () => 'i' + ++n })
  installCapture(ctx, { store, summarizer: { summarize: async () => ({ text: 'x', source: 'llm' }) } })
  const agent = { id: 'a1', session: { id: 'a1', header: { cwd: 'D:/proj' }, deriveMessages: () => [] } }
  const never = () => new Promise(() => {})
  const raise = async (callId, args) => {
    await handlers['tools/pre-execute'][0]({ name: 'shell', callId, arguments: args, agent }, async () => ({ kind: 'continue' }))
    handlers['approval/request'][0]({ agent, toolName: 'shell', callId }, never)
  }
  await raise('p1', { command: 'git status' })
  await raise('p2', { command: 'git status', description: 'status', timeout: 5000 })
  await raise('p3', { command: 'git status', cwd: 'C:/elsewhere' })
  const byCall = Object.fromEntries(store.snapshot().open.map((i) => [i.payload.callId, i.payload]))
  assert.equal(byCall.p1.extraArgs, undefined)
  assert.equal(byCall.p2.extraArgs, undefined)
  assert.equal(byCall.p3.extraArgs, true)
})

// --- S5: glued short-option values ---------------------------------------------------------------------------------------------------
test('S5: a glued short-option value that is a path is checked as a candidate', async () => {
  const io = { real: async (p) => p }
  assert.equal(await containedInWorkspace('cat -fC:/outside/secret.txt', ws, io), false)
  assert.equal(await containedInWorkspace('cat -O/abs/elsewhere', ws, io), false)
  assert.equal(await containedInWorkspace('cat -f../up', ws, io), false)
  assert.equal(await containedInWorkspace('head -n5 top.txt', ws, io), true, 'a number glued to a flag is not a path')
  assert.equal(await containedInWorkspace('git log -5', ws, io), true)
  assert.equal(await containedInWorkspace('cat -ftop.txt', ws, io), true, 'a bare name is not a path character candidate')
})

// --- S6: privacy ------------------------------------------------------------------------------------------------------------------------
test('S6: the persisted quote is redacted and an actor failure message is sanitised in the log', async () => {
  const secretQuote = 'please answer yes with token=abcdef1234567890abcd for the deploy'
  const sources = [{ id: 'user-9', text: secretQuote, userAuthored: true }]
  const judgment = { ...GOOD, evidence_quote: secretQuote }
  let n = 0
  const store = createStore({ now: () => 1, uuid: () => 'i' + ++n })
  const seen = []
  const logLines = []
  const rules = DEFAULT_RULES.map((r) => ({ ...r, mode: 'auto' }))
  const runner = createTriageRunner({
    store, judge: { judge: async () => ({ judgment }) }, rules, sourcesOf: () => sources, log: (l) => logLines.push(l),
    actors: { question: async (a) => { seen.push(a); throw new Error('boom token=abcdef1234567890abcd') } },
  })
  runner.start()
  store.add({ type: 'question', sessionId: 's1', workspace: 'D:/w', payload: { callId: 'c1', questions: [{ id: 'q1', question: 'Go?', options: [{ label: REC }, { label: NO }] }] } })
  await runner.idle()
  assert.equal(seen.length, 1)
  assert.ok(!seen[0].resolutionBase.quote.includes('abcdef1234567890abcd'), seen[0].resolutionBase.quote)
  assert.ok(logLines.length > 0)
  assert.ok(!logLines.join('\n').includes('abcdef1234567890abcd'), logLines.join('\n'))
})
