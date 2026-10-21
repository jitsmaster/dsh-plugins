import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as shared from '../follow-up-shared.js'
import { MAX_TODO } from '../todo.js'
import { MAX_CANDIDATES, MAX_QUERY, isSentFollowUp } from '../todo-follow-up.js'
import { FOLLOW_UP_LIMIT } from '../follow-up.js'
import { SESSIONS_LIMIT, cleanSessions } from '../hub/follow-up.js'
import { isSessionId } from '../thread.js'

// Layering: the constants and the cleaner that the hub half (hub/follow-up.js) and the executor (agent/executor.js) share live in a leaf module of their own,
// so neither needs the todo service, the speech text or the summariser; the old homes re-export them.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (file) => readFileSync(join(root, file), 'utf8')
const importsOf = (file) => [...source(file).matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])

test('the old homes re-export the very same values', () => {
  assert.equal(MAX_TODO, shared.MAX_TODO)
  assert.equal(MAX_QUERY, shared.MAX_QUERY)
  assert.equal(SESSIONS_LIMIT, shared.SESSIONS_LIMIT)
  assert.equal(cleanSessions, shared.cleanSessions)
  assert.deepEqual([shared.MAX_TODO, shared.MAX_QUERY, shared.SESSIONS_LIMIT, shared.PROMPT_TIMEOUT_MS], [4000, 300, 60, 30_000])
  assert.equal(isSentFollowUp, shared.isSentFollowUp)
  assert.equal(MAX_CANDIDATES, shared.MAX_CANDIDATES)
  assert.equal(FOLLOW_UP_LIMIT, shared.FOLLOW_UP_LIMIT)
})

test('the session limits of the three layers are one number: derived from SESSIONS_LIMIT, not written again', () => {
  assert.equal(shared.FOLLOW_UP_LIMIT, shared.SESSIONS_LIMIT, 'what an app lists')
  assert.equal(shared.MAX_CANDIDATES, shared.SESSIONS_LIMIT, 'what the model reads')
  assert.match(source('follow-up-shared.js'), /FOLLOW_UP_LIMIT = SESSIONS_LIMIT\b/)
  assert.match(source('follow-up-shared.js'), /MAX_CANDIDATES = SESSIONS_LIMIT\b/)
  for (const file of ['follow-up.js', 'todo-follow-up.js']) assert.doesNotMatch(source(file), /(?:FOLLOW_UP_LIMIT|MAX_CANDIDATES) = \d/, file)
})

test('isSentFollowUp: only a follow-up todo whose message was sent, with a session id, has a session of its own', () => {
  const sent = { type: 'todo', kind: 'followup', state: 'started', sessionId: 's1' }
  assert.equal(isSentFollowUp(sent), true)
  for (const over of [{ type: 'question' }, { kind: 'workspace' }, { kind: undefined }, { state: 'starting' }, { state: 'failed' }, { sessionId: '' }, { sessionId: undefined }, { sessionId: 7 }]) {
    assert.equal(isSentFollowUp({ ...sent, ...over }), false, JSON.stringify(over))
  }
  assert.deepEqual([isSentFollowUp(undefined), isSentFollowUp(null)], [false, false])
})

test('isAwaitingConfirm: an open todo that waits for the user', () => {
  assert.equal(shared.isAwaitingConfirm({ status: 'open', state: 'awaiting-confirm' }), true)
  for (const item of [undefined, { status: 'resolved', state: 'awaiting-confirm' }, { status: 'open', state: 'starting' }, { status: 'open', state: 'failed' }]) assert.equal(shared.isAwaitingConfirm(item), false)
})

test('the todo service and the follow-up half share the model helper and the note texts of summary.js, each written once', () => {
  for (const file of ['todo.js', 'todo-follow-up.js']) {
    const text = source(file)
    assert.doesNotMatch(text, /no model available|model found no clear fit|answered something unusable/, file + ' writes a note text again')
    assert.doesNotMatch(text, /\bpickModel\b/, file + ' picks the model itself')
    assert.doesNotMatch(text, /new AbortController\(\)/, file)
    assert.match(text, /createModelRun/, file)
  }
  const summary = source('summary.js')
  for (const name of ['NOTE_NO_MODEL', 'NOTE_NO_FIT', 'NOTE_UNUSABLE', 'createModelRun', 'noteOf']) assert.match(summary, new RegExp('export (?:const|function|async function) ' + name + '\\b'), name)
})

test('follow-up-shared.js imports nothing', () => {
  assert.deepEqual(importsOf('follow-up-shared.js'), [])
})

test('the hub half and the executor take the shared things from it, not from the todo service', () => {
  assert.ok(importsOf('hub/follow-up.js').includes('../follow-up-shared.js'))
  assert.ok(importsOf('agent/executor.js').includes('../follow-up-shared.js'))
  for (const file of ['hub/follow-up.js', 'agent/executor.js']) {
    for (const from of importsOf(file)) assert.doesNotMatch(from, /todo|speech|summary|hub\/follow-up/, file + ' imports ' + from)
  }
})

test('the prompt time limit has one name: no AbortSignal.timeout(30_000) literal left in the three callers', () => {
  for (const file of ['service.js', 'todo.js', 'todo-follow-up.js']) {
    assert.doesNotMatch(source(file), /AbortSignal\.timeout\(\s*30_?000/, file)
    assert.match(source(file), /PROMPT_TIMEOUT_MS/, file)
  }
})

// ---- cleanSessions applies the session id rule of thread.js (an id reaches the controller, the log reader and a path) -----------------------------------------

const IDS = ['s1', 'A', '0abc', 'a-b_c', 'a'.repeat(128), 'a'.repeat(129), '', '-lead', '_lead', 'has space', 'a/b', 'a\\b', '..', '../x', 'a.b', 'sess\nid', 'ünï', 'a:b', 'ok\u0000', '\u202eevil']

test('cleanSessions keeps exactly the session ids that thread.js isSessionId accepts, whatever else the entry says', () => {
  const kept = cleanSessions(IDS.map((sessionId) => ({ sessionId, title: 't' }))).map((s) => s.sessionId)
  assert.deepEqual(kept, IDS.filter((id) => isSessionId(id)))
  assert.ok(kept.includes('s1') && kept.includes('a'.repeat(128)), 'the sample has valid ids too')
  assert.ok(!kept.includes('a'.repeat(129)) && !kept.includes('../x') && !kept.includes('a/b'))
})

test('the hub bundle does not import thread.js for it: the rule is a commented copy that a test keeps in step', () => {
  assert.doesNotMatch(importsOf('follow-up-shared.js').join(' '), /thread/)
  assert.match(source('follow-up-shared.js'), /isSessionId/, 'the copy names its source of truth')
})

test('package.json lists the new module in files and this test in the test script', () => {
  const pkg = JSON.parse(source('package.json'))
  assert.ok(pkg.files.includes('follow-up-shared.js'))
  assert.match(pkg.scripts.test, /test\/follow-up-shared\.test\.mjs/)
})

// ---- the docs say what the code does ------------------------------------------------------------------------------------------------

// A heading written twice is the mark of a paste gone wrong (docs/hub.md once held a second copy of sections 1 to 6.4 inside 6.4a).
test('no heading of docs/hub.md appears twice, and the sections run in order', () => {
  let fenced = false
  const headings = []
  for (const line of source('docs/hub.md').split(/\r?\n/)) {
    if (/^```/.test(line)) fenced = !fenced
    else if (!fenced && /^#{2,4} /.test(line)) headings.push(line.trim())
  }
  assert.ok(headings.length > 40, 'the document has its sections')
  assert.deepEqual(headings.filter((h, i) => headings.indexOf(h) !== i), [])
  const at = (prefix) => headings.findIndex((h) => h.startsWith(prefix))
  assert.equal(at('### 6.4a ') , at('### 6.4 ') + 1, '6.4a follows 6.4 directly')
  assert.equal(at('### 6.5 '), at('### 6.4a ') + 1, '6.5 follows 6.4a directly')
})

const section = (md, from, to) => md.slice(md.indexOf(from), md.indexOf(to, md.indexOf(from)))

test('hub.md 6.4a documents the deadline, skipped apps, the unknown outcome, the audit lines and the version skew, and no longer a session list route', () => {
  const s = section(source('docs/hub.md'), '### 6.4a ', '### 6.5 ')
  assert.match(s, /4\.5 s/)
  assert.match(s, /skippedApps/)
  assert.match(s, /follow-up: app <id> skipped/)
  assert.match(s, /May have been sent/)
  assert.match(s, /todo-<item id>-<sessionId>/)
  assert.doesNotMatch(s, /sendKey/)
  assert.match(s, /too-many-follow-ups/)
  assert.match(s, /5 s/)
  assert.match(s, /Model says/)
  assert.match(s, /Could not send the message/)
  assert.match(s, /followup-add: device/)
  assert.match(s, /followup-confirm: device/)
  assert.match(s, /Version skew/)
  assert.match(s, /older[^.]*ordinary todo|ordinary todo[^.]*older/i)
  assert.doesNotMatch(s, /^GET\s+\/review-queue\/v1\/followup-sessions/m)
  assert.match(source('docs/hub.md'), /\| sessions-list \| 6 s \|/)
})

test('the README endpoint rows document the follow-up body fields and the new error codes, and the item has no sendKey', () => {
  const rows = source('README.md').split('\n')
  const todo = rows.find((r) => r.startsWith('| `/v1/todo` |'))
  const confirm = rows.find((r) => r.startsWith('| `/v1/todo-confirm` |'))
  assert.match(todo, /\{text, workspaceId\?, sparc\?, (effort\?, )?followUp\?(, images\?)?\}/)
  for (const code of ['empty-query', 'too-many-follow-ups']) assert.match(todo, new RegExp(code))
  assert.match(confirm, /\{id, workspaceId\?, sessionId\?\}/)
  for (const code of ['unknown-session', 'no-session', 'unknown-outcome', 'warning']) assert.match(confirm, new RegExp(code))
  assert.match(confirm, /400[^;]*no-session/)
  assert.match(confirm, /504 unknown-outcome/)
  assert.doesNotMatch(source('README.md'), /sendKey/)
  assert.match(source('README.md'), /at most 20 are stored/)
  assert.match(section(source('docs/hub.md'), '### 6.4a ', '### 6.5 '), /One confirm of an item at a time/)
})

test('the README documents the follow-up options and item shape of the service', () => {
  const readme = source('README.md')
  const s = readme.slice(readme.indexOf('Service for other plugins'), readme.indexOf('## Install'))
  for (const part of [/addTodo\(text, \{[^}]*followUp\?, sessions\?/, /confirmTodo\(id, \{[^}]*sessionId\?/, /kind 'followup'/, /query/, /candidates/, /suggested\?/, /targetSessionId/, /sessionTitle/]) assert.match(s, part)
  assert.doesNotMatch(readme, /followup-sessions/)
})

// ---- the deterministic number match: a digit run glued to another digit by - . / : is part of a date, a version, a time or a decimal, not a ticket ----------------

const cand = (sessionId, title) => ({ sessionId, title })

test('suggestSessionByRef: a number inside a date, a version, a time or a decimal of a title is not a match', () => {
  const titles = ['Backup 2026-10-20', 'Release 2026/10/20', 'Upgrade to v1.10.3', 'Standup at 10:30', 'Budget 2.10 and 10.5 left', 'Run 2026-10-20 10:20:30']
  for (const query of ['#10 something', 'ticket 20', 'PR 2026', 'AB#30', '#3 please', 'work item 10']) {
    for (const title of titles) {
      assert.equal(shared.suggestSessionByRef(query, [cand('s1', title), cand('s2', 'Unrelated')]), undefined, query + ' vs ' + title)
    }
  }
})

test('suggestSessionByRef: a ticket or PR number in the usual title forms still matches, even next to dates and other numbers', () => {
  const forms = [
    ['AB#25757', 'Fix: hosting hang - 25757'], ['#25757', 'CTnP-Final AB#25757 PR 6556'], ['PR 6556', 'PR 6556 review'], ['pull request 6556', '(PR 6556)'],
    ['#12', 'Fix #12: login'], ['ticket 12', 'Ticket 12.'], ['#12', 'bug-12 redirect'], ['AB#25757', 'AB#25757-hosting'], ['PR 6556', 'PR 6556/review'], ['#20', 'Backup 2026-10-20 for #20'],
  ]
  for (const [query, title] of forms) {
    const hit = shared.suggestSessionByRef(query, [cand('s1', title), cand('s2', 'Unrelated')])
    assert.deepEqual(hit && [hit.sessionId, hit.reason], ['s1', shared.REF_REASON], query + ' vs ' + title)
  }
})

// ---- the caps of the follow-up todo and the log sanitiser each live once --------------------------------------------------------------------------------------------

test('codeOf is the one log sanitiser of the follow-up code: the code, else the name, else the string given; safe characters only, 40 at most', () => {
  assert.equal(typeof shared.codeOf, 'function')
  assert.equal(shared.codeOf(Object.assign(new Error('secret D:/x'), { code: 'ECONNRESET' })), 'ECONNRESET')
  assert.equal(shared.codeOf(new TypeError('secret D:/x')), 'TypeError')
  assert.equal(shared.codeOf('owner-timeout'), 'owner-timeout')
  assert.equal(shared.codeOf(Object.assign(new Error('x'), { code: 'session/not-found' })), 'session/not-found')
  assert.equal(shared.codeOf(undefined), 'error')
  assert.equal(shared.codeOf({}), 'error')
  assert.equal(shared.codeOf(Object.assign(new Error('x'), { code: 'a\nb<c>' })), 'a?b?c?')
  assert.equal(shared.codeOf('x'.repeat(100)).length, 40)
})

test('the four callers import codeOf from follow-up-shared.js and none of them writes the sanitiser again', () => {
  for (const file of ['service.js', 'follow-up.js', 'todo-follow-up.js', 'hub/follow-up.js']) {
    const text = source(file)
    assert.doesNotMatch(text, /const codeOf\b/, file + ' defines codeOf again')
    assert.doesNotMatch(text, /replace\(\/\[\^A-Za-z0-9_:\./, file + ' sanitises a code itself')
    assert.ok(/import \{[^}]*\bcodeOf\b[^}]*\} from '(?:\.\.?\/)follow-up-shared\.js'/.test(text), file + ' imports codeOf from follow-up-shared.js')
  }
})

test('hub/http.js: the post audit line cuts the item id with safeId, the one copy of the safe-character rule', () => {
  const text = source('hub/http.js')
  assert.equal(text.match(/replace\(\/\[\^A-Za-z0-9_-\]\/g/g)?.length, 1, 'only safeId holds the rule')
  assert.match(text, /const postAudit = .*safeId\(body\.id, 40\)/)
})

test('service.js takes isSentFollowUp from follow-up-shared.js, like hub/routing.js', () => {
  for (const file of ['service.js', 'hub/routing.js']) assert.ok(importsOf(file).includes(file === 'service.js' ? './follow-up-shared.js' : '../follow-up-shared.js'), file)
  assert.ok(!importsOf('service.js').includes('./todo-follow-up.js'), 'service.js no longer goes through the re-export')
})

test('the cap of waiting follow-ups is one number in follow-up-shared.js, still exported by hub/follow-up.js', async () => {
  const hub = await import('../hub/follow-up.js')
  assert.equal(shared.MAX_WAITING_FOLLOW_UPS, 10)
  assert.equal(hub.MAX_WAITING_FOLLOW_UPS, shared.MAX_WAITING_FOLLOW_UPS)
  assert.doesNotMatch(source('hub/follow-up.js'), /MAX_WAITING_FOLLOW_UPS = \d/)
})

test('docs/hub.md sessions-list bullet: the session id rule clause has its subject (ids that break the rule of isSessionId are dropped), no dangling fragment', () => {
  const md = source('docs/hub.md')
  const bullet = md.split(/\r?\n/).find((l) => l.startsWith('- **sessions-list**'))
  assert.ok(bullet)
  assert.doesNotMatch(bullet, /\),\s+\(the rule/)
  assert.doesNotMatch(bullet, /; others are dropped/)
  assert.match(bullet, /[Ss]ession ids that break the rule of `isSessionId` in \[thread\.js\]\(\.\.\/thread\.js\).{0,200}are dropped\./)
})
