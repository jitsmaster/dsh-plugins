import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPrPoller, parsePrCreated, parsePollMarker, detectNewThreads, isPrSession } from '../pr.js'
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
      return undefined
    },
    on: (event, fn) => { (handlers[event] ??= []).push(fn) },
  }
  const fetchImpl = async (url, init) => {
    state.urls.push(url)
    state.headers.push(init?.headers)
    if (state.gate) await state.gate
    if (state.fetchError) throw new Error(`boom with ${init?.headers?.Authorization}`)
    const body = url.includes('/threads') ? { value: state.threads } : { pullRequestId: 5, status: state.prStatus, createdBy: state.createdBy ? { id: state.createdBy } : undefined }
    return { ok: true, status: 200, json: async () => body }
  }
  const resumes = []
  const created = []
  const poller = installPrPoller(ctx, {}, { settings, fetchImpl, intervalMs, env, onResumeApproved: async (a, id) => { resumes.push([a.id, id]) }, ...(withCreated ? { onPrCreated: async (a, id) => { created.push([a.id, id]) } } : {}) })
  const agent = { id: 'a1', session: { header: { cwd: 'C:/proj' } } }
  const fire = async (event, ...args) => {
    let out
    for (const fn of handlers[event] ?? []) out = await fn(...args, async () => ({ kind: 'continue' }))
    return out
  }
  const shell = (command, output, name = 'pwsh') => fire('tools/post-execute', { name, agent, arguments: { command } }, { content: [{ type: 'text', text: output }] })
  const log = () => { const p = join(dir, 'spawn.log'); return existsSync(p) ? readFileSync(p, 'utf8') : '' }
  return { poller, agent, state, calls, settings, shell, fire, log, ctx, resumes, created }
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
    assert.equal(h.calls.prompt.length, status === 'completed' ? 1 : 0)
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

// ---- merged PR: suggest a resume, then act only on the approved marker ----

const approved = (id) => `PR-RESUME-APPROVED: ${id}\r\n`
const completedHarness = async (opts) => {
  const h = harness(opts)
  h.state.title = 'PR 5'
  h.poller.register(h.agent, '5')
  h.state.prStatus = 'completed'
  await h.poller.poll('a1')
  return h
}

test('completed PR queues ONE ask_user_question suggestion into the same session, once per PR', async () => {
  const h = await completedHarness()
  assert.equal(h.calls.prompt.length, 1)
  const req = h.calls.prompt[0]
  assert.equal(req.sessionId, 'a1')
  assert.equal(req.mode, 'queue')
  const text = req.content[0].text
  assert.match(text, /ask_user_question/)
  assert.match(text, /PR 5 is merged\. Spawn a new session to continue from the last handoff\?/)
  assert.match(text, /Yes/)
  assert.match(text, /No/)
  assert.match(text, /echo PR-RESUME-APPROVED: 5/)
  // Polled again (e.g. re-registered on the next step): never re-sent.
  await h.fire('agent/pre-step', { agent: h.agent, messages: [] })
  h.state.prStatus = 'completed'
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  assert.equal(h.resumes.length, 0) // a suggestion alone never spawns
  h.poller.stopAll()
})

test('a failed suggestion hand-over is retried on the next poll', async () => {
  const h = harness()
  h.poller.register(h.agent, '5')
  h.state.prStatus = 'completed'
  const sc = h.ctx.get('sessionController')
  const original = sc.prompt
  sc.prompt = async () => { throw new Error('queue down') }
  await h.poller.poll('a1')
  assert.equal(h.poller.has('a1'), true)
  sc.prompt = original
  await h.poller.poll('a1')
  assert.equal(h.calls.prompt.length, 1)
  assert.equal(h.poller.has('a1'), false)
})

test('valid approved marker calls the resume hook exactly once', async () => {
  const h = await completedHarness()
  await h.shell('echo PR-RESUME-APPROVED: 5', approved(5))
  await h.shell('echo PR-RESUME-APPROVED: 5', approved(5))
  assert.deepEqual(h.resumes, [['a1', '5']])
  assert.match(h.log(), /resume approved/)
})

test('approved marker is ignored for a different id, a non-PR session, an uncompleted PR, non-shell tools', async () => {
  const wrongId = await completedHarness()
  await wrongId.shell('echo', approved(6))
  assert.equal(wrongId.resumes.length, 0)

  const nonPr = await completedHarness()
  nonPr.state.title = 'work' // renamed away from PR state
  await nonPr.shell('echo', approved(5))
  assert.equal(nonPr.resumes.length, 0)

  const active = harness()
  active.state.title = 'PR 5'
  active.poller.register(active.agent, '5') // PR still active: never completed
  await active.poller.poll('a1')
  await active.shell('echo', approved(5))
  assert.equal(active.resumes.length, 0)
  active.poller.stopAll()

  const wrongTool = await completedHarness()
  await wrongTool.shell('echo', approved(5), 'read')
  assert.equal(wrongTool.resumes.length, 0)

  const noSuggestion = harness() // completed was never observed
  noSuggestion.state.title = 'PR 5'
  await noSuggestion.shell('echo', approved(5))
  assert.equal(noSuggestion.resumes.length, 0)
})

test('the marker must stand on its own line (text merely quoting it is ignored)', async () => {
  const h = await completedHarness()
  await h.shell('cat notes', 'to approve run PR-RESUME-APPROVED: 5 later')
  assert.equal(h.resumes.length, 0)
})

test('handoffLines keep the suggested state after the poll stopped, and the marker restores it', async () => {
  const h = await completedHarness()
  assert.deepEqual(h.poller.handoffLines('a1'), ['PR: 5', 'PR-POLL: 5 seen= resume=suggested'])
  assert.deepEqual(parsePollMarker('PR-POLL: 5 seen=1:2 resume=suggested'), { id: '5', seen: [['1', '2']], resume: 'suggested' })
  const h2 = harness()
  await h2.fire('agent/pre-step', { agent: h2.agent, messages: [{ content: 'PR-POLL: 5 seen= resume=suggested' }] })
  h2.state.prStatus = 'completed'
  await h2.poller.poll('a1')
  assert.equal(h2.calls.prompt.length, 0) // already suggested before the handoff
  h2.poller.stopAll()
})

test('resume hook failure is traced without the PAT and is not retried', async () => {
  const h = harness()
  const failing = installPrPoller(h.ctx, {}, { settings: h.settings, env: { AZURE_DEVOPS_EXT_PAT: PAT }, fetchImpl: async (u) => ({ ok: true, json: async () => (u.includes('/threads') ? { value: [] } : { status: 'completed' }) }), onResumeApproved: async () => { throw new Error(`spawn failed ${PAT}`) } })
  h.state.title = 'PR 5'
  failing.register(h.agent, '5')
  await failing.poll('a1')
  await h.shell('echo', approved(5))
  assert.ok(!h.log().includes(PAT))
  assert.match(h.log(), /resume failed/)
})
