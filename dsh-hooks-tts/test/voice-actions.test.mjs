// Spec: docs/voice-two-stage-flow.md §2 (voice/actions.js) and §3 (action schema, read-back, execution mapping).
// Shapes chosen where the spec is open (implementer: follow these):
// - validateAction(raw, { sessions, target, peek, slashNames }):
//     sessions   = [{ id, handle: 's1'.., title? }] in stable order (live agents only); title fallback = 'session N' (N from sN).
//     target     = { selected?, lastAlerted?, lastActive? } (agent ids); default = selected ?? lastAlerted ?? lastActive.
//     peek       = approvals.peek, called as peek({ sessionId }) -> { toolName, token } | undefined.
//     slashNames = (sessionId) -> string[] (command names without '/').
// - Validated action shapes (raw handle replaced by sessionId + title; unknown keys dropped; strings trimmed):
//     switch  { action, sessionId, title }            prompt { action, sessionId, title, text }
//     new     { action, sessionId?, text? }  (sessionId = default target, only used for cwdOf; valid with no target, R8)
//     approve / deny { action, sessionId, title, toolName, token }   cancel { action, sessionId, title }
//     slash   { action, sessionId, title, name, args }  (args '' when absent)   clarify { action, question }
// - switch without an explicit session -> 'invalid'.
// - Tool phrase = headline.js TOOL_SPEECH wording (pwsh -> 'run command', write -> 'write file', else '_'/'-' -> space).
// - createExecutor also takes uuid() (requestId = 'voice-' + uuid()).
// - Stale approval: execute() resolves { stale: true } without answering; resultText(action, { stale: true }) ->
//   'That request changed. Nothing done.' Other execution failures reject with the collaborator's Error unchanged.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createExecutor, readBack, resultText, validateAction } from '../voice/actions.js'
import * as actionsModule from '../voice/actions.js'

test('toolPhrase is exported for the service: headline wording without its Approve ...? frame', () => {
  assert.equal(typeof actionsModule.toolPhrase, 'function')
  assert.equal(actionsModule.toolPhrase('pwsh'), 'run command')
  assert.equal(actionsModule.toolPhrase('my_tool'), 'my tool')
})

const SESSIONS = [
  { id: 'a', handle: 's1', title: 'Voice Work' },
  { id: 'b', handle: 's2', title: 'PR 6524' },
  { id: 'c', handle: 's3' },
]
const TOKEN = { token: 'pending-b' }
const opts = (over = {}) => ({
  sessions: SESSIONS,
  target: { selected: 'a' },
  peek: ({ sessionId }) => (sessionId === 'b' ? { toolName: 'pwsh', token: TOKEN } : undefined),
  slashNames: () => ['compact', 'export'],
  ...over,
})
const ok = (action) => ({ ok: true, action })

test('V1 every schema action validates to its resolved shape and unknown keys are dropped', () => {
  assert.deepEqual(validateAction({ action: 'switch', session: 's2' }, opts()), ok({ action: 'switch', sessionId: 'b', title: 'PR 6524' }))
  assert.deepEqual(validateAction({ action: 'prompt', session: 's1', text: '  fix the parser  ', extra: 1 }, opts()),
    ok({ action: 'prompt', sessionId: 'a', title: 'Voice Work', text: 'fix the parser' }))
  assert.deepEqual(validateAction({ action: 'new', text: ' write tests ' }, opts()), ok({ action: 'new', sessionId: 'a', text: 'write tests' }))
  assert.deepEqual(validateAction({ action: 'new' }, opts()), ok({ action: 'new', sessionId: 'a' }))
  assert.deepEqual(validateAction({ action: 'approve', session: 's2' }, opts()),
    ok({ action: 'approve', sessionId: 'b', title: 'PR 6524', toolName: 'pwsh', token: TOKEN }))
  assert.deepEqual(validateAction({ action: 'deny', session: 's2' }, opts()),
    ok({ action: 'deny', sessionId: 'b', title: 'PR 6524', toolName: 'pwsh', token: TOKEN }))
  assert.deepEqual(validateAction({ action: 'cancel', session: 's1', why: 'x' }, opts()), ok({ action: 'cancel', sessionId: 'a', title: 'Voice Work' }))
  assert.deepEqual(validateAction({ action: 'slash', session: 's1', name: 'compact', args: ' focus on tests ' }, opts()),
    ok({ action: 'slash', sessionId: 'a', title: 'Voice Work', name: 'compact', args: 'focus on tests' }))
  assert.deepEqual(validateAction({ action: 'slash', session: 's1', name: 'export' }, opts()),
    ok({ action: 'slash', sessionId: 'a', title: 'Voice Work', name: 'export', args: '' }))
  assert.deepEqual(validateAction({ action: 'clarify', question: ' PR 5 or PR 6? ', session: 's1' }, opts()),
    ok({ action: 'clarify', question: 'PR 5 or PR 6?' }))
})

test('V1 unknown actions and non-object replies are invalid', () => {
  for (const raw of [{ action: 'rm-rf', session: 's1' }, { session: 's1' }, null, undefined, 'cancel', 42, []]) {
    assert.deepEqual(validateAction(raw, opts()), { ok: false, error: 'invalid' }, JSON.stringify(raw))
  }
})

test('V2 a missing session falls back to selected, then lastAlerted, then lastActive', () => {
  const raw = { action: 'cancel' }
  assert.deepEqual(validateAction(raw, opts({ target: { selected: 'a', lastAlerted: 'b', lastActive: 'c' } })),
    ok({ action: 'cancel', sessionId: 'a', title: 'Voice Work' }))
  assert.deepEqual(validateAction(raw, opts({ target: { lastAlerted: 'b', lastActive: 'c' } })),
    ok({ action: 'cancel', sessionId: 'b', title: 'PR 6524' }))
  assert.deepEqual(validateAction(raw, opts({ target: { lastActive: 'c' } })),
    ok({ action: 'cancel', sessionId: 'c', title: 'session 3' }))
  assert.deepEqual(validateAction({ action: 'prompt', text: 'run the tests' }, opts({ target: { lastAlerted: 'b', lastActive: 'a' } })),
    ok({ action: 'prompt', sessionId: 'b', title: 'PR 6524', text: 'run the tests' }))
})

test('V3 an unknown session handle (or a raw id) is invalid', () => {
  assert.deepEqual(validateAction({ action: 'cancel', session: 's9' }, opts()), { ok: false, error: 'invalid' })
  assert.deepEqual(validateAction({ action: 'prompt', session: 'a', text: 'hi' }, opts()), { ok: false, error: 'invalid' })
  assert.deepEqual(validateAction({ action: 'switch', session: 's4' }, opts()), { ok: false, error: 'invalid' })
})

test('V4 with no default target a session-less action is no-session; switch needs an explicit session; new needs no target', () => {
  const none = opts({ target: {} })
  assert.deepEqual(validateAction({ action: 'cancel' }, none), { ok: false, error: 'no-session' })
  assert.deepEqual(validateAction({ action: 'prompt', text: 'run the tests' }, none), { ok: false, error: 'no-session' })
  assert.deepEqual(validateAction({ action: 'approve' }, none), { ok: false, error: 'no-session' })
  assert.deepEqual(validateAction({ action: 'cancel' }, opts({ sessions: [], target: {} })), { ok: false, error: 'no-session' })
  assert.deepEqual(validateAction({ action: 'switch' }, opts()), { ok: false, error: 'invalid' })
  assert.deepEqual(validateAction({ action: 'new' }, opts({ sessions: [], target: {} })), ok({ action: 'new' }))
  assert.deepEqual(validateAction({ action: 'new', text: 'hello' }, opts({ sessions: [], target: {} })), ok({ action: 'new', text: 'hello' }))
})

test('V5 approve/deny without a pending request is no-approval with the title; the peeked token is frozen into the action', () => {
  const peeks = []
  const peek = (q) => { peeks.push(q); return q.sessionId === 'b' ? { toolName: 'pwsh', token: TOKEN } : undefined }
  assert.deepEqual(validateAction({ action: 'approve', session: 's1' }, opts({ peek })), { ok: false, error: 'no-approval', title: 'Voice Work' })
  assert.deepEqual(validateAction({ action: 'deny' }, opts({ peek, target: { lastActive: 'c' } })), { ok: false, error: 'no-approval', title: 'session 3' })
  const v = validateAction({ action: 'approve', session: 's2' }, opts({ peek }))
  assert.equal(v.action.token, TOKEN)
  assert.deepEqual(peeks, [{ sessionId: 'a' }, { sessionId: 'c' }, { sessionId: 'b' }])
})

test('V6 slash names are checked against that session\'s command list after stripping a leading slash', () => {
  const asked = []
  const slashNames = (id) => { asked.push(id); return id === 'b' ? ['review'] : ['compact'] }
  assert.deepEqual(validateAction({ action: 'slash', session: 's1', name: '/compact' }, opts({ slashNames })),
    ok({ action: 'slash', sessionId: 'a', title: 'Voice Work', name: 'compact', args: '' }))
  assert.deepEqual(validateAction({ action: 'slash', session: 's1', name: 'review' }, opts({ slashNames })), { ok: false, error: 'invalid' })
  assert.deepEqual(validateAction({ action: 'slash', session: 's2', name: '/review' }, opts({ slashNames })),
    ok({ action: 'slash', sessionId: 'b', title: 'PR 6524', name: 'review', args: '' }))
  assert.deepEqual(validateAction({ action: 'slash', session: 's1' }, opts({ slashNames })), { ok: false, error: 'invalid' })
  assert.deepEqual(asked.slice(0, 3), ['a', 'a', 'b'])
})

test('V7 length caps: prompt text 1..4000, new text <=4000, slash args <=500, clarify question 1..200', () => {
  const inv = { ok: false, error: 'invalid' }
  const x = (n) => 'x'.repeat(n)
  assert.equal(validateAction({ action: 'prompt', session: 's1', text: x(4000) }, opts()).ok, true)
  assert.deepEqual(validateAction({ action: 'prompt', session: 's1', text: x(4001) }, opts()), inv)
  assert.deepEqual(validateAction({ action: 'prompt', session: 's1', text: '' }, opts()), inv)
  assert.deepEqual(validateAction({ action: 'prompt', session: 's1', text: '   ' }, opts()), inv)
  assert.deepEqual(validateAction({ action: 'prompt', session: 's1' }, opts()), inv)
  assert.equal(validateAction({ action: 'new', text: x(4000) }, opts()).ok, true)
  assert.deepEqual(validateAction({ action: 'new', text: x(4001) }, opts()), inv)
  assert.equal(validateAction({ action: 'slash', session: 's1', name: 'compact', args: x(500) }, opts()).ok, true)
  assert.deepEqual(validateAction({ action: 'slash', session: 's1', name: 'compact', args: x(501) }, opts()), inv)
  assert.equal(validateAction({ action: 'clarify', question: x(200) }, opts()).ok, true)
  assert.deepEqual(validateAction({ action: 'clarify', question: x(201) }, opts()), inv)
  assert.deepEqual(validateAction({ action: 'clarify', question: '  ' }, opts()), inv)
  assert.deepEqual(validateAction({ action: 'clarify' }, opts()), inv)
})

test('R1 read-back text per action is exact', () => {
  assert.equal(readBack({ action: 'switch', sessionId: 'b', title: 'PR 6524' }), 'talk to PR 6524')
  assert.equal(readBack({ action: 'prompt', sessionId: 'a', title: 'Voice Work', text: 'fix the parser' }), 'send to Voice Work: fix the parser')
  assert.equal(readBack({ action: 'new', sessionId: 'a' }), 'start a new session')
  assert.equal(readBack({ action: 'new', sessionId: 'a', text: 'write tests' }), 'start a new session and send: write tests')
  assert.equal(readBack({ action: 'approve', sessionId: 'b', title: 'PR 6524', toolName: 'pwsh', token: TOKEN }), 'approve run command in PR 6524')
  assert.equal(readBack({ action: 'deny', sessionId: 'b', title: 'PR 6524', toolName: 'write', token: TOKEN }), 'deny write file in PR 6524')
  assert.equal(readBack({ action: 'approve', sessionId: 'b', title: 'PR 6524', toolName: 'my_tool', token: TOKEN }), 'approve my tool in PR 6524')
  assert.equal(readBack({ action: 'cancel', sessionId: 'a', title: 'Voice Work' }), 'stop the run in Voice Work')
  assert.equal(readBack({ action: 'slash', sessionId: 'a', title: 'Voice Work', name: 'compact', args: 'focus on tests' }), 'run slash compact focus on tests in Voice Work')
  assert.equal(readBack({ action: 'slash', sessionId: 'a', title: 'Voice Work', name: 'compact', args: '' }), 'run slash compact in Voice Work')
  assert.equal(readBack(validateAction({ action: 'cancel', session: 's3' }, opts()).action), 'stop the run in session 3')
})

function harness(opts = {}) {
  // 'peeked' in opts keeps an explicit undefined (vanished approval) instead of the default token.
  const peeked = 'peeked' in opts ? opts.peeked : { toolName: 'pwsh', token: TOKEN }
  const calls = []
  const execute = createExecutor({
    controller: {
      prompt: async (r) => { calls.push(['prompt', r]) },
      create: async (r) => { calls.push(['create', r]); return { sessionId: 'n1' } },
      cancel: async (r) => { calls.push(['cancel', r]) },
    },
    runSlash: async (r) => { calls.push(['runSlash', r]) },
    approvals: {
      peek: () => peeked,
      answer: (r) => { calls.push(['answer', r]); return { answered: true } },
    },
    select: (id) => { calls.push(['select', id]) },
    cwdOf: (id) => ({ a: 'D:\\proj\\a', b: 'D:\\proj\\b' })[id],
    uuid: () => 'u1',
  })
  return { calls, execute }
}
const A = {
  switch: { action: 'switch', sessionId: 'b', title: 'PR 6524' },
  prompt: { action: 'prompt', sessionId: 'a', title: 'Voice Work', text: 'fix the parser' },
  new: { action: 'new', sessionId: 'a' },
  newText: { action: 'new', sessionId: 'a', text: 'write tests' },
  approve: { action: 'approve', sessionId: 'b', title: 'PR 6524', toolName: 'pwsh', token: TOKEN },
  deny: { action: 'deny', sessionId: 'b', title: 'PR 6524', toolName: 'pwsh', token: TOKEN },
  cancel: { action: 'cancel', sessionId: 'a', title: 'Voice Work' },
  slash: { action: 'slash', sessionId: 'a', title: 'Voice Work', name: 'compact', args: 'focus on tests' },
  slashBare: { action: 'slash', sessionId: 'a', title: 'Voice Work', name: 'compact', args: '' },
}
const run = async (action, h = harness()) => { await h.execute(action); return h.calls }

test('X1 the executor maps each action to exactly one collaborator call with exact arguments', async () => {
  assert.deepEqual(await run(A.switch), [['select', 'b']])
  assert.deepEqual(await run(A.prompt), [['prompt', { requestId: 'voice-u1', sessionId: 'a', mode: 'queue', content: [{ type: 'text', text: 'fix the parser' }] }]])
  assert.deepEqual(await run(A.new), [['create', { cwd: 'D:\\proj\\a' }], ['select', 'n1']])
  assert.deepEqual(await run(A.approve), [['answer', { sessionId: 'b', decision: 'approve' }]])
  assert.deepEqual(await run(A.deny), [['answer', { sessionId: 'b', decision: 'deny' }]])
  assert.deepEqual(await run(A.cancel), [['cancel', { sessionId: 'a' }]])
  assert.deepEqual(await run(A.slash), [['runSlash', { sessionId: 'a', name: 'compact', input: ' focus on tests' }]])
  assert.deepEqual(await run(A.slashBare), [['runSlash', { sessionId: 'a', name: 'compact', input: '' }]])
})

test('X1 a collaborator failure rejects execute() with that error', async () => {
  const execute = createExecutor({
    controller: { cancel: async () => { throw new Error('session is not available') } },
    runSlash: async () => {}, approvals: { peek: () => undefined, answer: () => {} }, select: () => {}, cwdOf: () => undefined, uuid: () => 'u1',
  })
  await assert.rejects(execute(A.cancel), { message: 'session is not available' })
})

test('X2 new with text creates in the target cwd, selects the new session, then prompts it', async () => {
  assert.deepEqual(await run(A.newText), [
    ['create', { cwd: 'D:\\proj\\a' }],
    ['select', 'n1'],
    ['prompt', { requestId: 'voice-u1', sessionId: 'n1', mode: 'queue', content: [{ type: 'text', text: 'write tests' }] }],
  ])
})

test('X3 a changed or vanished approval token answers nothing and reports the request changed', async () => {
  for (const peeked of [{ toolName: 'pwsh', token: { token: 'newer' } }, undefined]) {
    const h = harness({ peeked })
    const result = await h.execute(A.approve)
    assert.deepEqual(h.calls, [])
    assert.equal(resultText(A.approve, result), 'That request changed. Nothing done.')
  }
})

test('X4 spoken result text per action is exact', async () => {
  const said = async (action) => resultText(action, await harness().execute(action))
  assert.equal(await said(A.switch), 'Now talking to PR 6524.')
  assert.equal(await said(A.prompt), 'Sent to Voice Work.')
  assert.equal(await said(A.new), 'New session started.')
  assert.equal(await said(A.newText), 'New session started. Prompt sent.')
  assert.equal(await said(A.approve), 'Approved.')
  assert.equal(await said(A.deny), 'Denied.')
  assert.equal(await said(A.cancel), 'Stopped Voice Work.')
  assert.equal(await said(A.slash), 'Done.')
})
