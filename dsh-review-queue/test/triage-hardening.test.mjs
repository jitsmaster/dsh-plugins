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
  // [command, the exact paths resolved]: a UNC / device path resolves nothing, a lexically outside drive path resolves only the workspace root
  const bad = [['cat //attacker.example/share/x', []], ['cat \\\\attacker.example\\share\\x', []], ['cat \\\\?\\C:\\x', []], ['cat \\\\.\\pipe\\x', []], ['cat //./pipe/x', []], ['cat -f//attacker.example/s/x', []],
    ['cat Z:/definitely/outside.txt', [ws]], ['cat C:\\Windows\\win.ini', [ws]]]
  for (const [cmd, expected] of bad) {
    const seen = []
    const io = { real: async (p) => { seen.push(p); return p } }
    assert.equal(await containedInWorkspace(cmd, ws, io), false, cmd)
    assert.deepEqual(seen, expected, cmd + ' resolved ' + JSON.stringify(seen))
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
  for (const c of ['rg foo a.txt', 'grep -n foo a.txt', 'grep -in foo a.txt b.txt', 'rg -n -i foo src/a.js', 'rg -n foo src/a.js', 'grep --line-number --ignore-case foo a.txt']) assert.equal(auto(c).ok, true, c)
})

test('S2: rg/grep in auto take only no-value flags, so a flag value can never pass for the named file', () => {
  const bad = ['rg -A 3 foo', 'rg --max-count 5 foo', 'grep -m 5 foo', "rg -g '*.js' foo", 'rg -g *.js foo', 'rg -t js foo', 'rg -B 2 foo', 'rg -C 2 foo', 'grep -A 3 foo', 'rg -A3 foo a.txt', 'rg -m5 foo a.txt', 'rg --max-count=5 foo a.txt',
    'grep -e foo a.txt', 'rg --color always foo', 'rg --glob x foo', 'rg --type js foo', 'rg -j 4 foo', 'grep --max-count 5 foo', 'rg -n -A 3 foo', 'rg -nA 3 foo', 'grep -nm 5 foo', 'rg --context 3 foo']
  for (const c of bad) assert.equal(auto(c).ok, false, c)
  for (const c of ['rg -n foo src/a.js', 'grep -in foo a.txt', 'grep -c foo a.txt', 'rg -l foo a.txt b.txt', 'rg -w -F foo a.txt', 'grep -vHs foo a.txt', 'rg --word-regexp --fixed-strings foo a.txt', 'rg --no-filename --count foo a.txt']) assert.equal(auto(c).ok, true, c)
  for (const c of ['rg -A 3 foo', 'rg --max-count 5 foo', 'grep -m 5 foo', 'rg -t js foo']) assert.equal(parseReadOnlyCommand(c).ok, true, 'observe: ' + c)
})

test('S2: observe still accepts what it accepted', () => {
  for (const c of ['rg -r x foo', 'grep -rn foo', 'rg --hidden foo', 'rg foo', 'git show HEAD:README.md', 'git log -p']) assert.equal(parseReadOnlyCommand(c).ok, true, c)
})

test('S2: git in auto: no revision:path, no patch / pickaxe options', () => {
  const bad = ['git show HEAD:.env', 'git show HEAD:src/a.js', 'git show :0:a.js', 'git log -p', 'git log --patch', 'git show -p HEAD', 'git log -Gsecret', 'git log -Ssecret', 'git diff -c', 'git diff --cc', 'git log -pw']
  for (const c of bad) assert.equal(auto(c).ok, false, c)
  for (const c of ['git status', 'git log --oneline -5', 'git diff HEAD~1 --stat']) assert.equal(auto(c).ok, true, c)
})

test('S2: git in auto is status and summary-only log / diff: nothing that prints file contents', () => {
  const ok = ['git status', 'git status -s', 'git status --short -b', 'git status --porcelain', 'git log --oneline', 'git log --stat', 'git log --name-only', 'git log --name-status', 'git log --oneline -5',
    'git diff --stat', 'git diff --name-only', 'git diff --name-status', 'git diff --shortstat', 'git diff --numstat', 'git diff HEAD~1 --stat', 'git diff --stat --cached', 'git diff --name-only HEAD~1']
  const bad = ['git diff --stat -U5', 'git diff --stat --unified=3', 'git log --oneline --stat -U1', 'git diff --stat --word-diff', 'git diff --stat --color-words', 'git diff --stat -W','git show HEAD', 'git show HEAD --stat', 'git show', 'git diff', 'git diff HEAD~1', 'git log', 'git log -5', 'git log -p', 'git log --stat -p', 'git diff --stat -p', 'git diff --stat --patch', 'git diff --stat -u',
    'git blame a.js', 'git grep foo', 'git cat-file -p HEAD', 'git log --oneline -Gx', 'git diff --stat -c', 'git log --oneline HEAD:a.js', 'git diff --stat -S x']
  for (const c of ok) assert.equal(auto(c).ok, true, c)
  for (const c of bad) assert.equal(auto(c).ok, false, c)
  for (const c of ['git show HEAD', 'git diff', 'git log', 'git log -p', 'git diff --stat -p', 'git show HEAD:README.md']) assert.equal(parseReadOnlyCommand(c).ok, true, 'observe: ' + c)
  assert.equal(parseReadOnlyCommand('git blame a.js').ok, false, 'observe never allowed these')
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

// --- S7: cat/head/tail/wc/ls flags in auto -------------------------------------------------------------------------------------------
test('S7: auto allows only a small no-value flag set for cat/head/tail/wc/ls and needs a named file', () => {
  const bad = ['tail -f app.log', 'tail -F app.log', 'tail --follow app.log', 'tail -n 5 a.log', 'tail -n5 a.log', 'tail --pid=1 a.log', 'tail --retry a.log', 'cat', 'cat -n', 'cat -v a.txt', 'cat --show-all a.txt',
    'ls -R .', 'ls --recursive', 'ls -lR', 'ls -I x', 'wc --files0-from=list.txt', 'wc -l', 'wc --total=only a.txt', 'head -n 3 a.txt', 'head -c 3 a.txt', 'head', 'tail', 'head --lines=3 a.txt']
  for (const c of bad) assert.equal(auto(c).ok, false, c)
  const good = ['cat -n src/a.js', 'cat -bs src/a.js', 'cat --number src/a.js', 'head src/a.js', 'head -q src/a.js', 'tail src/a.js', 'tail --quiet src/a.js', 'wc -l src/a.js', 'wc -lw src/a.js', 'wc --lines src/a.js', 'ls', 'ls -la', 'ls -1 src', 'ls src', 'ls --all --long', 'ls -h']
  for (const c of good) assert.equal(auto(c).ok, true, c)
  for (const c of ['tail -f app.log', 'cat -v a.txt', 'ls -R .', 'head -n 3 a.txt', 'wc --files0-from=list.txt']) assert.equal(parseReadOnlyCommand(c).ok, true, 'observe: ' + c)
})

// --- S8: protected names are re-checked on the resolved real path ---------------------------------------------------------------------
test('S8: a candidate that resolves to a protected name is vetoed in containedInWorkspace', async () => {
  const resolveTo = (map) => ({ real: async (p) => (p === ws ? ws : (map[p.replace(/\\/g, '/').replace(ws.replace(/\\/g, '/') + '/', '')] ? join(ws, map[p.replace(/\\/g, '/').replace(ws.replace(/\\/g, '/') + '/', '')]) : p)) })
  assert.equal(await containedInWorkspace('cat link-to-env', ws, resolveTo({ 'link-to-env': '.env' })), false, 'symlink to .env')
  assert.equal(await containedInWorkspace('cat link-to-key', ws, resolveTo({ 'link-to-key': 'sub/server.pem' })), false, 'symlink to a .pem')
  assert.equal(await containedInWorkspace('cat link-to-git', ws, resolveTo({ 'link-to-git': '.git/config' })), false, 'symlink into .git')
  assert.equal(await containedInWorkspace('cat ENV~1', ws, { real: async (p) => p }), false, '8.3 short name')
  assert.equal(await containedInWorkspace('cat sub/PROGRA~1/x', ws, { real: async (p) => p }), false, '8.3 short name segment')
  assert.equal(await containedInWorkspace('cat .git./config', ws, { real: async (p) => p }), false, 'trailing-dot .git')
  assert.equal(await containedInWorkspace('cat link-ok', ws, resolveTo({ 'link-ok': 'src/a.js' })), true, 'a normal file resolving inside passes')
  assert.equal(await containedInWorkspace('cat top.txt', ws, { real: async (p) => p }), true)
})

// --- S10: rg / grep never search a named directory (they recurse into secret-named files the argument does not show) -------------------
test('S10: rg and grep are vetoed when a path argument is a directory; a file, ls and the observe default are not', async () => {
  const io = (isDir) => ({ real: async (p) => p, stat: async () => ({ isDirectory: () => isDir }) })
  for (const c of ['rg password src', 'grep x src']) {
    assert.equal(await containedInWorkspace(c, ws, io(true)), false, c + ' on a directory')
    assert.equal(await containedInWorkspace(c, ws, io(false)), true, c + ' on a file')
  }
  assert.equal(await containedInWorkspace('rg password src', ws, io(true), 'rg'), false, 'explicit command name')
  assert.equal(await containedInWorkspace('ls src', ws, io(true)), true, 'ls may list a directory')
  assert.equal(await containedInWorkspace('cat src', ws, io(true)), true, 'other commands are unchanged')
})

test('S10: a stat error fails closed for rg and grep', async () => {
  const io = { real: async (p) => p, stat: async () => { throw new Error('EACCES') } }
  assert.equal(await containedInWorkspace('rg password src', ws, io), false)
  assert.equal(await containedInWorkspace('grep x src', ws, io), false)
  assert.equal(await containedInWorkspace('ls src', ws, io), true, 'ls never stats')
})

test('S8: .git. and .git<space> variants and 8.3 names are protected in auto only', () => {
  for (const c of ['cat .git./config', 'cat .git /config', 'cat ENV~1', 'cat a/PROGRA~2/b']) assert.equal(auto(c).ok, false, c)
  assert.equal(parseReadOnlyCommand('cat ENV~1').ok, true, 'observe unchanged')
})

// --- S9: a detached question is never answered by the Auto actor ----------------------------------------------------------------------
test('S9: the question actor refuses a stored card that is detached', async () => {
  const item = { id: 'i1', type: 'question', status: 'open', sessionId: 's1', workspace: 'D:/w', payload: { callId: 'c1', questions: [{ id: 'q1', question: 'Go?', options: [{ label: REC }, { label: NO }] }] } }
  let answered = 0
  const answer = () => { answered++; return true }
  const judgment = { ...GOOD }
  const ok = await createQuestionActor({ store: { get: () => item }, answer })({ item, judgment, resolutionBase: {} })
  assert.equal(ok.ok, true, 'control: an attached card is answered')
  answered = 0
  const res = await createQuestionActor({ store: { get: () => ({ ...item, detached: true }) }, answer })({ item, judgment, resolutionBase: {} })
  assert.deepEqual(res, { ok: false, reason: 'refused' })
  assert.equal(answered, 0)
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
