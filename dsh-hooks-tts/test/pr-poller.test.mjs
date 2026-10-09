import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPrPoller, parsePrCreated, parsePollMarker, detectNewThreads, isPrSession, ciReviewCleanAt, ciReviewStands } from '../pr.js'
import { createSettings } from '../settings.js'

const PAT = 'sup3r-secret-pat'
const thread = (id, lastId, extra = {}) => ({
  id, status: 'active',
  comments: [{ id: 1, commentType: 'text', content: 'first' }, { id: lastId, commentType: 'text', content: 'last' }],
  ...extra,
})

function harness({ intervalMs = 600_000, env = { AZURE_DEVOPS_EXT_PAT: PAT }, withCreated = false, ...settingsExtra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'))
  const settings = createSettings(dir, settingsExtra)
  const state = { title: 'work', threads: [], prStatus: 'active', urls: [], headers: [], fetchError: false, gate: undefined }
  const handlers = {}
  const calls = { rename: [], prompt: [] }
  const controller = {
    rename: async (r) => { calls.rename.push(r); state.title = r.title },
    prompt: async (r) => { calls.prompt.push(r) },
  }
  const ctx = {
    logger: { warn() {}, info() {} },
    get: (name) => {
      if (name === 'sessionTitle') return { get: () => (state.title === undefined ? undefined : { title: state.title }) }
      if (name === 'sessionController') return controller
      if (name === 'workspaceRegistry' && state.known) return { list: () => [{ sessionIds: Object.keys(state.known) }] }
      if (name === 'sessionQuery' && state.known) {
        return { readTitleSnapshots: async (ids) => ids.map((id) => (state.known[id] === 'REJECT'
          ? { status: 'rejected', reason: new Error('x') }
          : { status: 'fulfilled', value: state.known[id] === undefined ? {} : { title: { title: state.known[id] } } })) }
      }
      return undefined
    },
    on: (event, fn) => { (handlers[event] ??= []).push(fn) },
  }
  const fetchImpl = async (url, init) => {
    state.urls.push(url)
    state.headers.push(init?.headers)
    if (state.gate) await state.gate
    if (state.fetchError) throw new Error(`boom with ${init?.headers?.Authorization}`)
    if (url.includes('/build/builds')) {
      if (state.buildFail) throw new Error('build lookup failed')
      return { ok: true, status: 200, json: async () => ({ value: state.builds ?? [] }) }
    }
    if (url.includes('/commits/')) {
      if (state.commitFail) throw new Error('commit lookup failed')
      return { ok: true, status: 200, json: async () => ({ committer: { date: state.commitDate } }) }
    }
    const body = url.includes('/threads') ? { value: state.threads } : { pullRequestId: 5, status: state.prStatus, createdBy: state.createdBy ? { id: state.createdBy } : undefined, lastMergeSourceCommit: { commitId: state.headCommit ?? 'c1' }, mergeStatus: state.mergeStatus, targetRefName: 'refs/heads/develop' }
    return { ok: true, status: 200, json: async () => { if (state.badJson) throw new SyntaxError('Unexpected token < in JSON'); return body } }
  }
  const created = []
  const poller = installPrPoller(ctx, {}, { settings, fetchImpl, intervalMs, env, ...(withCreated ? { onPrCreated: async (a, id) => { created.push([a.id, id]) } } : {}) })
  const agent = { id: 'a1', session: { header: { cwd: 'C:/proj' } } }
  const fire = async (event, ...args) => {
    let out
    for (const fn of handlers[event] ?? []) out = await fn(...args, async () => ({ kind: 'continue' }))
    return out
  }
  const shell = (command, output, name = 'pwsh') => fire('tools/post-execute', { name, agent, arguments: { command } }, { content: [{ type: 'text', text: output }] })
  const log = () => { const p = join(dir, 'spawn.log'); return existsSync(p) ? readFileSync(p, 'utf8') : '' }
  return { poller, agent, state, calls, settings, shell, fire, log, ctx, created, dir, fetchImpl }
}

// ---- parsing ----

test('parsePrCreated reads pullRequestId from az repos pr create output', () => {
  assert.equal(parsePrCreated('az repos pr create --title x', '{"pullRequestId": 4321, "status":"active"}'), '4321')
})

test('parsePrCreated ignores pullRequestId from other commands', () => {
  assert.equal(parsePrCreated('az repos pr show --id 5', '{"pullRequestId": 5}'), undefined)
})

test('parsePrCreated accepts an explicit PR-CREATED marker', () => {
  assert.equal(parsePrCreated('echo', 'done\nPR-CREATED: 777\n'), '777')
})

test('parsePollMarker parses id and seen entries (bare ids and id:comment)', () => {
  const m = parsePollMarker('x\nPR-POLL: 42 seen=5:9,7\ny')
  assert.equal(m.id, '42')
  assert.deepEqual(m.seen, [['5', '9'], ['7', null]])
  assert.equal(parsePollMarker('no marker here'), undefined)
  assert.deepEqual(parsePollMarker('PR-POLL: 8').seen, [])
})

// ---- thread detection ----

test('detectNewThreads: unseen thread is new', () => {
  const out = detectNewThreads([thread(1, 3)], new Map())
  assert.deepEqual(out.map((t) => [t.threadId, t.lastCommentId, t.notify]), [['1', '3', true]])
})

test('detectNewThreads: seen thread with same last comment is not new; changed last comment is', () => {
  const seen = new Map([['1', '3']])
  assert.equal(detectNewThreads([thread(1, 3)], seen).length, 0)
  assert.equal(detectNewThreads([thread(1, 4)], seen).length, 1)
})

test('detectNewThreads ignores resolved, closed, deleted and system threads', () => {
  const threads = [
    thread(1, 3, { status: 'fixed' }),
    thread(2, 3, { status: 'closed' }),
    thread(3, 3, { status: 'wontFix' }),
    thread(4, 3, { isDeleted: true }),
    { id: 5, status: 'active', comments: [{ id: 1, commentType: 'system' }] },
    { id: 6, status: 'active', comments: [{ id: 1, commentType: 'text', isDeleted: true }] },
  ]
  assert.deepEqual(detectNewThreads(threads, new Map()), [])
})

test('detectNewThreads: a system comment after a human one does not count as the last comment', () => {
  const t = { id: 1, status: 'active', comments: [{ id: 1, commentType: 'text' }, { id: 2, commentType: 'system' }] }
  assert.equal(detectNewThreads([t], new Map())[0].lastCommentId, '1')
})

test('detectNewThreads: a bare resumed id is adopted silently, not notified', () => {
  const out = detectNewThreads([thread(1, 3)], new Map([['1', null]]))
  assert.deepEqual(out.map((t) => t.notify), [false])
})

const byAuthor = (id, lastId, authorId) => ({
  id, status: 'active',
  comments: [{ id: 1, commentType: 'text', author: { id: 'rev' } }, { id: lastId, commentType: 'text', author: { id: authorId } }],
})

test('detectNewThreads: the PR author\'s own last comment is adopted silently, not notified', () => {
  const out = detectNewThreads([byAuthor(1, 3, 'me'), byAuthor(2, 3, 'rev')], new Map(), 'me')
  assert.deepEqual(out.map((t) => [t.threadId, t.notify]), [['1', false], ['2', true]])
})

test('detectNewThreads: without a known author id every comment still counts', () => {
  assert.deepEqual(detectNewThreads([byAuthor(1, 3, 'me')], new Map()).map((t) => t.notify), [true])
})

test('poll: the author\'s own reply queues nothing; a later reviewer reply does', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.createdBy = 'me'
  h.state.threads = [byAuthor(1, 2, 'rev')]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  h.state.threads = [byAuthor(1, 3, 'me')]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  h.state.threads = [byAuthor(1, 4, 'rev')]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 2)
  h.poller.stopAll()
})

// ---- restore after a server restart ----

test('restore: re-registers every session titled "PR <n>" (and only those), once', async () => {
  const h = harness()
  h.state.known = { s1: 'PR 5', s2: 'work', s3: 'PR 7 - 2', s4: 'REJECT', s5: undefined }
  assert.equal(await h.poller.restore(), 2)
  assert.equal(h.poller.has('s1'), true)
  assert.equal(h.poller.has('s3'), true)
  assert.equal(h.poller.has('s2'), false)
  assert.equal(await h.poller.restore(), 0) // already registered
  h.poller.stopAll()
})

test('restore: polls straight away and queues the open review comments into the restored session', async () => {
  const h = harness()
  h.state.known = { s1: 'PR 5' }
  h.state.threads = [thread(11, 2)]
  await h.poller.restore()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.calls.prompt.length, 1)
  assert.equal(h.calls.prompt[0].sessionId, 's1')
  h.poller.stopAll()
})

test('restore: a restored session whose PR is already merged stops silently (no resume suggestion)', async () => {
  const h = harness()
  h.state.known = { s1: 'PR 5' }
  h.state.prStatus = 'completed'
  await h.poller.restore()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.poller.has('s1'), false)
  assert.equal(h.calls.prompt.length, 0)
})

test('restore: a session that already finished (merged) is not re-registered or re-polled by a later restore', async () => {
  const h = harness()
  h.state.known = { s1: 'PR 5' }
  h.state.prStatus = 'completed'
  await h.poller.restore()
  await new Promise((r) => setTimeout(r, 20))
  const fetches = h.state.urls.length
  assert.equal(await h.poller.restore(), 0)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.state.urls.length, fetches)
})

test('restore: without the registry or query services it does nothing and does not throw', async () => {
  const h = harness()
  assert.equal(await h.poller.restore(), 0)
})

// ---- CI "no issues found" stop rule ----

const ciThread = (id, date, text = 'AI review complete â€” no issues found across all 10 passes (AI pitfall review, ...)') => ({
  id, status: 'closed', comments: [{ id: 1, commentType: 'text', content: text, publishedDate: date, author: { displayName: 'Project Collection Build Service (ingeniuxdev)' } }],
})

test('ciReviewCleanAt: date of the latest "no issues found" CI comment, else undefined', () => {
  assert.equal(ciReviewCleanAt([thread(1, 2)]), undefined)
  assert.equal(ciReviewCleanAt([ciThread(5, '2026-10-05T10:00:00Z', 'AI review complete â€” 3 issues found')]), undefined)
  assert.equal(ciReviewCleanAt([ciThread(5, '2026-10-05T10:00:00Z'), ciThread(6, '2026-10-05T12:00:00Z')]), Date.parse('2026-10-05T12:00:00Z'))
  assert.equal(ciReviewCleanAt([{ ...ciThread(7, '2026-10-05T10:00:00Z'), isDeleted: true }]), undefined)
})

test('poll keeps going after a quiet poll and traces every poll', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  await h.poller.poll('a1')
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), true)
  assert.equal((h.log().match(/polled PR 5/g) ?? []).length, 2)
  h.poller.stopAll()
})

test('poll stops once CI reports no issues found after the last commit', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.commitDate = '2026-10-05T11:00:00Z'
  h.state.threads = [ciThread(9, '2026-10-05T12:00:00Z')]
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), false)
  assert.match(h.log(), /no issues found/)
})

test('poll keeps going when the CI "no issues" result is older than the last commit (a new review is pending)', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.commitDate = '2026-10-05T13:00:00Z'
  h.state.threads = [ciThread(9, '2026-10-05T12:00:00Z')]
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), true)
  h.poller.stopAll()
})

test('poll keeps going when the commit lookup fails, and when new comments were just queued', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.commitFail = true
  h.state.threads = [ciThread(9, '2026-10-05T12:00:00Z')]
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), true)
  h.state.commitFail = false
  h.state.commitDate = '2026-10-05T11:00:00Z'
  h.state.threads = [ciThread(9, '2026-10-05T12:00:00Z'), thread(11, 2)]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  assert.equal(h.poller.has('a1'), true) // its thread is still active, so it keeps going
  h.state.threads = [ciThread(9, '2026-10-05T12:00:00Z'), humanThread(11, '2026-10-05T10:00:00Z')] // once resolved, nothing is pending
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), false)
})

// Auto-stop: CI all-clear + nothing newer or still open + not older than the head commit.
const CLEAN_AT = '2026-10-05T12:00:00Z'
const humanThread = (id, date, status = 'closed', commentType = 'text') => ({
  id, status, comments: [{ id: 1, commentType, content: 'please look', publishedDate: date, author: { id: 'rev', displayName: 'Reviewer' } }],
})

async function cleanHarness(threads, commitDate = '2026-10-05T11:00:00Z') {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.commitDate = commitDate
  h.state.threads = threads
  await h.poller.poll('a1')
  return h
}

test('auto-stop: a clean CI comment alone stops the poll and queues one final message', async () => {
  const h = await cleanHarness([ciThread(9, CLEAN_AT)])
  assert.equal(h.poller.has('a1'), false)
  assert.equal(h.calls.prompt.length, 1)
  assert.match(h.calls.prompt[0].content[0].text, /PR 5 review poller stopped: the CI review found no issues/)
  await h.poller.poll('a1') // the poll is gone: nothing more is fetched or sent
  assert.equal(h.calls.prompt.length, 1)
})

test('auto-stop: system threads do not keep the poller running', async () => {
  const sys = { id: 20, status: 'active', comments: [{ id: 1, commentType: 'system', content: 'Policy status', publishedDate: '2026-10-05T13:00:00Z' }] }
  const h = await cleanHarness([ciThread(9, CLEAN_AT), sys])
  assert.equal(h.poller.has('a1'), false)
})

test('auto-stop: a clean CI comment plus an active human thread does not stop', async () => {
  const h = await cleanHarness([ciThread(9, CLEAN_AT), humanThread(10, '2026-10-05T10:00:00Z', 'active')])
  assert.equal(h.poller.has('a1'), true)
  assert.equal(h.calls.prompt.filter((c) => /poller stopped/.test(c.content[0].text)).length, 0)
  h.poller.stopAll()
})

test('auto-stop: a human comment after the clean one does not stop, even in a resolved thread', async () => {
  const h = await cleanHarness([ciThread(9, CLEAN_AT), humanThread(10, '2026-10-05T12:30:00Z')])
  assert.equal(h.poller.has('a1'), true)
  assert.equal(h.calls.prompt.length, 0)
  h.poller.stopAll()
})

test('auto-stop: a later non-clean CI comment does not stop', async () => {
  const later = ciThread(10, '2026-10-05T13:00:00Z', 'AI review complete — 2 issues found')
  const h = await cleanHarness([ciThread(9, CLEAN_AT), later])
  assert.equal(h.poller.has('a1'), true)
  h.poller.stopAll()
})

test('auto-stop: a stale clean comment (older than the head commit) does not stop', async () => {
  const h = await cleanHarness([ciThread(9, CLEAN_AT)], '2026-10-05T13:00:00Z')
  assert.equal(h.poller.has('a1'), true)
  assert.equal(h.calls.prompt.length, 0)
  h.poller.stopAll()
})

test('auto-stop: a "no issues" comment from another author does not count', async () => {
  const fake = ciThread(9, CLEAN_AT)
  fake.comments[0].author = { displayName: 'Some Human' }
  assert.equal(ciReviewCleanAt([fake]), undefined)
  const h = await cleanHarness([fake])
  assert.equal(h.poller.has('a1'), true)
  h.poller.stopAll()
})

test('auto-stop: a fetch error keeps the poller running and logs the original message', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.fetchError = true
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), true)
  assert.match(h.log(), /poll of PR 5 failed: boom with /)
  assert.doesNotMatch(h.log(), new RegExp(PAT))
  h.poller.stopAll()
})

test('auto-stop: a parse error in the response keeps the poller running and is logged', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.badJson = true
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), true)
  assert.match(h.log(), /poll of PR 5 failed: Unexpected token < in JSON/)
  h.poller.stopAll()
})

test('auto-stop: a failed final message keeps the poll alive so it is retried', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.commitDate = '2026-10-05T11:00:00Z'
  h.state.threads = [ciThread(9, CLEAN_AT)]
  const sc = h.ctx.get('sessionController')
  const prompt = sc.prompt
  sc.prompt = async () => { throw new Error('queue refused') }
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), true)
  assert.match(h.log(), /queue refused/)
  sc.prompt = prompt
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), false)
})

test('ciReviewStands: unreadable comment dates count as newer (fail safe)', () => {
  assert.equal(ciReviewStands([humanThread(1, 'garbage')], Date.parse(CLEAN_AT)), false)
  assert.equal(ciReviewStands([humanThread(1, '2026-10-05T10:00:00Z')], Date.parse(CLEAN_AT)), true)
})

// ---- creation -> rename + register ----

test('az repos pr create output renames the session to "PR <id>" and registers the poll', async () => {
  const h = harness()
  await h.shell('az repos pr create --title t', '{"pullRequestId": 4321}')
  assert.deepEqual(h.calls.rename, [{ sessionId: 'a1', title: 'PR 4321' }])
  assert.equal(h.poller.has('a1'), true)
  h.poller.stopAll()
})

test('with onPrCreated: creation hands over to it; this session is neither renamed nor polled', async () => {
  const h = harness({ withCreated: true })
  await h.shell('az repos pr create --title t', '{"pullRequestId": 4321}')
  assert.deepEqual(h.created, [['a1', '4321']])
  assert.equal(h.calls.rename.length, 0)
  assert.equal(h.poller.has('a1'), false)
  const h2 = harness({ withCreated: true })
  h2.state.title = 'PR 9'
  await h2.shell('az repos pr create', '{"pullRequestId": 10}')
  assert.equal(h2.created.length, 0)
})

test('PR-CREATED marker also renames', async () => {
  const h = harness()
  await h.shell('echo hi', 'PR-CREATED: 55')
  assert.deepEqual(h.calls.rename, [{ sessionId: 'a1', title: 'PR 55' }])
  h.poller.stopAll()
})

test('creation is idempotent and never renames a session already titled PR <n>', async () => {
  const h = harness()
  await h.shell('az repos pr create', '{"pullRequestId": 4321}')
  await h.shell('az repos pr create', '{"pullRequestId": 4321}')
  assert.equal(h.calls.rename.length, 1)
  const h2 = harness()
  h2.state.title = 'PR 8 something'
  await h2.shell('az repos pr create', '{"pullRequestId": 9}')
  assert.equal(h2.calls.rename.length, 0)
  h.poller.stopAll(); h2.poller.stopAll()
})

test('non-shell tools are not scanned for PR creation', async () => {
  const h = harness()
  await h.shell('az repos pr create', '{"pullRequestId": 4321}', 'read')
  assert.equal(h.calls.rename.length, 0)
})

test('isPrSession reads the live title', () => {
  const h = harness()
  assert.equal(isPrSession(h.ctx, h.agent), false)
  h.state.title = 'PR 3'
  assert.equal(isPrSession(h.ctx, h.agent), true)
})

// ---- polling ----

test('poll: new thread queues one message into the SAME session, with the approval-gate wording', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.threads = [thread(11, 2)]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  const req = h.calls.prompt[0]
  assert.equal(req.sessionId, 'a1')
  assert.equal(req.mode, 'queue')
  const text = req.content[0].text
  assert.match(text, /ado-pr-implement/)
  assert.match(text, /PR 5/)
  assert.match(text, /NOT (commit|push)/i)
  assert.match(text, /approval/i)
  // Same data again: nothing new.
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  // Last comment changed: new again.
  h.state.threads = [thread(11, 3)]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 2)
  h.poller.stopAll()
})

test('poll: resolved and system threads produce no message', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.threads = [thread(1, 2, { status: 'fixed' }), { id: 2, status: 'active', comments: [{ id: 1, commentType: 'system' }] }]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 0)
  h.poller.stopAll()
})

test('poll: uses Basic auth with ":" + PAT, hits the PR and threads URLs', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  await h.poller.poll('a1')
  assert.ok(h.state.urls.some((u) => u === 'https://dev.azure.com/ingeniuxdev/Ingeniux/_apis/git/repositories/6dc5d0bc-703d-4add-8785-e9fd2c55f4fc/pullRequests/5/threads?api-version=7.1'))
  assert.ok(h.state.urls.some((u) => u.includes('/pullRequests/5?api-version=7.1')))
  assert.equal(h.state.headers[0].Authorization, `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`)
  h.poller.stopAll()
})

test('poll: no overlapping polls', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  let release
  h.state.gate = new Promise((r) => { release = r })
  const first = h.poller.poll('a1')
  const second = h.poller.poll('a1')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(h.state.urls.length, 1) // only the first poll's PR fetch is in flight
  release()
  await Promise.all([first, second])
  h.state.gate = undefined
  h.poller.stopAll()
})

test('poll stops when the PR is completed or abandoned; abandoned queues nothing', async () => {
  for (const status of ['completed', 'abandoned']) {
    const h = harness()
    h.poller.register(h.agent, '5')
    h.state.prStatus = status
    h.state.threads = [thread(1, 2)]
    await h.poller.poll('a1')
    assert.equal(h.poller.has('a1'), false)
    assert.equal(h.calls.prompt.length, 0) // no merged-PR question any more: the remaining-work session handles that
  }
})

test('poll stops when the session is disposed', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  await h.fire('agent/disposed', { agent: h.agent })
  assert.equal(h.poller.has('a1'), false)
})

test('the interval timer polls and is cleared on stop', async () => {
  const h = harness({ intervalMs: 10 })
  h.state.threads = [thread(1, 2)]
  h.poller.register(h.agent, '5')
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(h.calls.prompt.length >= 1)
  h.poller.stopAll()
  const n = h.state.urls.length
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(h.state.urls.length, n)
})

test('pollPrComments off: the poller does nothing', async () => {
  const h = harness({ pollPrComments: false })
  h.poller.register(h.agent, '5')
  h.state.threads = [thread(1, 2)]
  await h.poller.poll('a1')
  assert.equal(h.state.urls.length, 0)
  assert.equal(h.calls.prompt.length, 0)
  h.settings.set({ pollPrComments: true })
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  h.poller.stopAll()
})

test('pollPrComments defaults on and is validated as boolean', () => {
  const h = harness()
  assert.equal(h.settings.get().pollPrComments, true)
  assert.throws(() => h.settings.set({ pollPrComments: 'yes' }))
})

test('no PAT: nothing is fetched', async () => {
  const h = harness({ env: {} })
  h.poller.register(h.agent, '5')
  await h.poller.poll('a1')
  assert.equal(h.state.urls.length, 0)
  h.poller.stopAll()
})

test('the PAT never appears in the trace log, even when fetch fails with it in the message', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.fetchError = true
  await h.poller.poll('a1')
  h.state.fetchError = false
  h.state.threads = [thread(1, 2)]
  await h.poller.poll('a1')
  const log = h.log()
  assert.ok(log.length > 0)
  assert.ok(!log.includes(PAT))
  assert.ok(!log.includes(Buffer.from(`:${PAT}`).toString('base64')))
  h.poller.stopAll()
})

// ---- state across handoffs ----

test('handoffLines carry the PR id and seen thread ids', async () => {
  const h = harness()
  assert.deepEqual(h.poller.handoffLines('a1'), [])
  h.poller.register(h.agent, '5')
  h.state.threads = [thread(11, 2), thread(12, 7)]
  await h.poller.poll('a1')
  assert.deepEqual(h.poller.handoffLines('a1'), ['PR: 5', 'PR-POLL: 5 seen=11:2,12:7'])
  h.poller.stopAll()
})

test('a PR-POLL marker in an incoming message re-registers the poll (seen is respected) and renames', async () => {
  const h = harness()
  await h.fire('agent/pre-step', { agent: h.agent, messages: [{ content: [{ type: 'text', text: 'Resume.\nPR-POLL: 5 seen=11:2' }] }] })
  assert.equal(h.poller.has('a1'), true)
  assert.deepEqual(h.calls.rename, [{ sessionId: 'a1', title: 'PR 5' }])
  h.state.threads = [thread(11, 2), thread(12, 1)]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  assert.match(h.calls.prompt[0].content[0].text, /12/)
  assert.doesNotMatch(h.calls.prompt[0].content[0].text, /thread(s)? 11\b/)
  h.poller.stopAll()
})

test('a session already titled PR <n> is picked up on its next step without a rename', async () => {
  const h = harness()
  h.state.title = 'PR 9 fixes'
  await h.fire('agent/pre-step', { agent: h.agent, messages: [] })
  assert.equal(h.poller.has('a1'), true)
  assert.equal(h.calls.rename.length, 0)
  h.poller.stopAll()
})


// ---- waiting for the PR to finish (the remaining-work session) ----

const waitMarker = (id) => `PR-WAIT: ${id}\r\n`

test('PR-WAIT from a "... - after PR n" session registers a wait; a merged PR queues ONE re-ask into it', async () => {
  const h = harness()
  h.state.title = 'feature - after PR 5'
  await h.shell('echo PR-WAIT: 5', waitMarker(5))
  assert.deepEqual(h.poller.waits(), [['a1', '5']])
  await h.poller.checkWaits() // PR still active
  assert.equal(h.calls.prompt.length, 0)
  h.state.prStatus = 'completed'
  await h.poller.checkWaits()
  assert.equal(h.calls.prompt.length, 1)
  assert.equal(h.calls.prompt[0].sessionId, 'a1')
  const text = h.calls.prompt[0].content[0].text
  assert.match(text, /PR 5 (is|was) merged/)
  assert.doesNotMatch(text, /ask_user_question/) // merged: the follow-up starts without asking
  assert.match(text, /Start the remaining work now/)
  assert.match(text, /origin\/develop/)
  assert.deepEqual(h.poller.waits(), [])
  await h.poller.checkWaits()
  assert.equal(h.calls.prompt.length, 1)
  h.poller.stopAll()
})

test('an abandoned PR re-asks with abandon wording', async () => {
  const h = harness()
  h.state.title = 'feature - after PR 5'
  await h.shell('echo', waitMarker(5))
  h.state.prStatus = 'abandoned'
  await h.poller.checkWaits()
  assert.match(h.calls.prompt[0].content[0].text, /abandoned/)
  assert.match(h.calls.prompt[0].content[0].text, /continue anyway/i)
  h.poller.stopAll()
})

test('PR-WAIT is ignored for a different id, a non-after-PR title, non-shell tools, or text that merely quotes it', async () => {
  const wrongId = harness()
  wrongId.state.title = 'feature - after PR 6'
  await wrongId.shell('echo', waitMarker(5))
  assert.deepEqual(wrongId.poller.waits(), [])
  const plain = harness()
  plain.state.title = 'PR 5'
  await plain.shell('echo', waitMarker(5))
  assert.deepEqual(plain.poller.waits(), [])
  const tool = harness()
  tool.state.title = 'feature - after PR 5'
  await tool.shell('echo', waitMarker(5), 'read')
  assert.deepEqual(tool.poller.waits(), [])
  const quoted = harness()
  quoted.state.title = 'feature - after PR 5'
  await quoted.shell('cat', 'to wait run PR-WAIT: 5 later')
  assert.deepEqual(quoted.poller.waits(), [])
})

test('waits are persisted and re-armed by a new poller (server restart); a failed hand-over is retried', async () => {
  const h = harness()
  h.state.title = 'feature - after PR 5'
  await h.shell('echo', waitMarker(5))
  h.poller.stopAll()
  const again = installPrPoller(h.ctx, {}, { settings: h.settings, fetchImpl: h.fetchImpl, env: { AZURE_DEVOPS_EXT_PAT: PAT } })
  assert.deepEqual(again.waits(), [['a1', '5']])
  h.state.prStatus = 'completed'
  const sc = h.ctx.get('sessionController')
  const original = sc.prompt
  sc.prompt = async () => { throw new Error('queue down') }
  await again.checkWaits()
  assert.deepEqual(again.waits(), [['a1', '5']]) // kept for the next check
  sc.prompt = original
  await again.checkWaits()
  assert.equal(h.calls.prompt.length, 1)
  assert.deepEqual(again.waits(), [])
  again.stopAll()
})

// ---- active CI review pipeline ----

test('CI pipeline: an active build is reported once, per build id', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.builds = [{ id: 900, buildNumber: '20261007.1', status: 'inProgress' }]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  assert.match(h.calls.prompt[0].content[0].text, /CI review pipeline is running on PR 5 \(build 20261007.1, inProgress\)/)
  assert.match(h.state.urls.find((u) => u.includes('/build/builds')), /definitions=80&branchName=refs%2Fpull%2F5%2Fmerge&statusFilter=inProgress,notStarted/)
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1) // same build: not repeated
  h.state.builds = [{ id: 901, buildNumber: '20261007.2', status: 'notStarted' }]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 2) // a new run (e.g. after a push)
  h.poller.stopAll()
})

test('CI pipeline: new threads and a running pipeline share one message', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.builds = [{ id: 900, status: 'inProgress' }]
  h.state.threads = [thread(7, 2)]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  assert.match(h.calls.prompt[0].content[0].text, /CI review pipeline is running[\s\S]*New review comments on PR 5/)
  h.poller.stopAll()
})

test('CI pipeline: a running pipeline blocks the clean auto-stop; a failed lookup does too', async () => {
  const h = await cleanHarnessWith([ciThread(9, CLEAN_AT)], { builds: [{ id: 900, status: 'inProgress' }] })
  assert.equal(h.poller.has('a1'), true)
  assert.equal(h.calls.prompt.filter((c) => /poller stopped/.test(c.content[0].text)).length, 0)
  h.poller.stopAll()
  const f = await cleanHarnessWith([ciThread(9, CLEAN_AT)], { buildFail: true })
  assert.equal(f.poller.has('a1'), true)
  f.poller.stopAll()
})

test('CI pipeline: once it has finished the clean auto-stop applies', async () => {
  const h = await cleanHarnessWith([ciThread(9, CLEAN_AT)], { builds: [] })
  assert.equal(h.poller.has('a1'), false)
})

// ---- merge conflicts ----

test('merge conflicts: reported once per head commit, again after a new conflicting push, and after a resolve-then-reconflict', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.mergeStatus = 'conflicts'
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  const text = h.calls.prompt[0].content[0].text
  assert.match(text, /PR 5 has MERGE CONFLICTS with develop/)
  assert.match(text, /origin\/develop/)
  assert.match(text, /Do NOT push/)
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1) // same head: not repeated
  h.state.headCommit = 'c2'
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 2) // pushed, still conflicting
  h.state.mergeStatus = 'succeeded'
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 2)
  h.state.mergeStatus = 'conflicts'
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 3) // a new conflict after a clean state
  h.poller.stopAll()
})

test('merge conflicts: no conflict, no message; a failed hand-over is retried', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.mergeStatus = 'succeeded'
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 0)
  h.state.mergeStatus = 'conflicts'
  const sc = h.ctx.get('sessionController')
  const original = sc.prompt
  sc.prompt = async () => { throw new Error('queue down') }
  await h.poller.poll('a1')
  sc.prompt = original
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  h.poller.stopAll()
})

test('merge conflicts: share one message with new threads and a running build, and block the clean auto-stop', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.mergeStatus = 'conflicts'
  h.state.builds = [{ id: 900, status: 'inProgress' }]
  h.state.threads = [thread(7, 2)]
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  assert.match(h.calls.prompt[0].content[0].text, /MERGE CONFLICTS[\s\S]*CI review pipeline is running[\s\S]*New review comments on PR 5/)
  h.poller.stopAll()
  const c = await cleanHarnessWith([ciThread(9, CLEAN_AT)], { builds: [], mergeStatus: 'conflicts' })
  assert.equal(c.poller.has('a1'), true)
  assert.equal(c.calls.prompt.filter((p) => /poller stopped/.test(p.content[0].text)).length, 0)
  assert.equal(c.calls.prompt.filter((p) => /MERGE CONFLICTS/.test(p.content[0].text)).length, 1)
  c.poller.stopAll()
})

async function cleanHarnessWith(threads, extra) {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.commitDate = '2026-10-05T11:00:00Z'
  h.state.threads = threads
  Object.assign(h.state, extra)
  await h.poller.poll('a1')
  return h
}

// ---- a finished PR stays stopped; its follow-up session starts by itself ----

test('a PR session whose PR was merged is not re-registered on its next step', async () => {
  const h = harness()
  h.state.title = 'PR 5'
  await h.fire('agent/pre-step', { agent: h.agent, messages: [] })
  assert.equal(h.poller.has('a1'), true)
  h.state.prStatus = 'completed'
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), false)
  await h.fire('agent/pre-step', { agent: h.agent, messages: [] })
  assert.equal(h.poller.has('a1'), false)
  h.poller.register(h.agent, '5') // e.g. restore() or a resumed PR-POLL marker
  assert.equal(h.poller.has('a1'), false)
})

test('a finished PR stays finished across a server restart', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.prStatus = 'abandoned'
  await h.poller.poll('a1')
  const again = installPrPoller(h.ctx, {}, { settings: h.settings, fetchImpl: h.fetchImpl, env: { AZURE_DEVOPS_EXT_PAT: PAT } })
  again.register(h.agent, '5')
  assert.equal(again.has('a1'), false)
})

test('a PR that the CI review cleared stays stopped too', async () => {
  const h = harness()
  h.state.title = 'PR 5'
  h.state.headCommit = 'c1'
  h.state.commitDate = '2026-10-08T10:00:00Z'
  h.state.threads = [{ id: 9, status: 'closed', comments: [{ id: 1, commentType: 'text', content: 'AI review complete — no issues found across all 10 passes', publishedDate: '2026-10-08T11:00:00Z', author: { displayName: 'Project Collection Build Service (ingeniuxdev)' } }] }]
  h.poller.register(h.agent, '5')
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), false)
  await h.fire('agent/pre-step', { agent: h.agent, messages: [] })
  assert.equal(h.poller.has('a1'), false)
})

test('when a PR is merged its waiting follow-up session is started at once, by the poll that sees the merge', async () => {
  const h = harness()
  const follow = { id: 'f1', session: {} }
  h.poller.addWait(follow.id, '5')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.calls.prompt.length, 0) // PR still active
  h.poller.register(h.agent, '5')
  h.state.prStatus = 'completed'
  await h.poller.poll('a1')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.calls.prompt.length, 1)
  assert.equal(h.calls.prompt[0].sessionId, 'f1')
  assert.deepEqual(h.poller.waits(), [])
})

test('a wait added after the PR was already merged is delivered immediately', async () => {
  const h = harness()
  h.state.prStatus = 'completed'
  h.poller.addWait('f1', '5')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.calls.prompt.length, 1)
  assert.equal(h.calls.prompt[0].sessionId, 'f1')
})

test('checkWaits seeing a merge also stops the PR session poll of that PR', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.poller.addWait('f1', '5')
  h.state.prStatus = 'completed'
  await h.poller.checkWaits()
  assert.equal(h.poller.has('a1'), false)
})
