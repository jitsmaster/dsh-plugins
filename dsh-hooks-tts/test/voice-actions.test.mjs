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
  peek: ({ sessionId }) => (sessionId === 'b' ? { toolName: 'pwsh', token: TOKEN, summary: 'npm test', count: 1 } : undefined),
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
    ok({ action: 'approve', sessionId: 'b', title: 'PR 6524', toolName: 'pwsh', token: TOKEN, summary: 'npm test', pendingCount: 1 }))
  assert.deepEqual(validateAction({ action: 'deny', session: 's2' }, opts()),
    ok({ action: 'deny', sessionId: 'b', title: 'PR 6524', toolName: 'pwsh', token: TOKEN, summary: 'npm test', pendingCount: 1 }))
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

test('V7 length caps: prompt text 1..1500, new text <=1500 (too-long), slash args <=500, clarify question 1..200', () => {
  const inv = { ok: false, error: 'invalid' }
  const x = (n) => 'x'.repeat(n)
  const long = { ok: false, error: 'too-long' }
  assert.equal(validateAction({ action: 'prompt', session: 's1', text: x(1500) }, opts()).ok, true)
  assert.deepEqual(validateAction({ action: 'prompt', session: 's1', text: x(1501) }, opts()), long)
  assert.deepEqual(validateAction({ action: 'prompt', session: 's1', text: '' }, opts()), inv)
  assert.deepEqual(validateAction({ action: 'prompt', session: 's1', text: '   ' }, opts()), inv)
  assert.deepEqual(validateAction({ action: 'prompt', session: 's1' }, opts()), inv)
  assert.equal(validateAction({ action: 'new', text: x(1500) }, opts()).ok, true)
  assert.deepEqual(validateAction({ action: 'new', text: x(1501) }, opts()), long)
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
  assert.equal(readBack({ action: 'approve', sessionId: 'b', title: 'PR 6524', toolName: 'pwsh', token: TOKEN, summary: 'npm test', pendingCount: 1 }), 'approve run command npm test in PR 6524')
  assert.equal(readBack({ action: 'deny', sessionId: 'b', title: 'PR 6524', toolName: 'write', token: TOKEN, summary: 'D:\\a.txt', pendingCount: 1 }), 'deny write file D:\\a.txt in PR 6524')
  assert.equal(readBack({ action: 'approve', sessionId: 'b', title: 'PR 6524', toolName: 'my_tool', token: TOKEN, summary: 'x', pendingCount: 1 }), 'approve my tool x in PR 6524')
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

test('R2 the approve/deny read-back says what will run, the newest-of-N count, and "details not available" without a summary', () => {
  const base = { sessionId: 'b', title: 'PR 6524', toolName: 'pwsh', token: TOKEN }
  assert.equal(readBack({ ...base, action: 'approve', summary: 'rm -rf build', pendingCount: 3 }),
    'approve run command rm -rf build in PR 6524, the newest of 3 pending requests')
  assert.equal(readBack({ ...base, action: 'deny', summary: '', pendingCount: 1 }), 'deny run command details not available in PR 6524')
  assert.equal(readBack({ ...base, action: 'approve' }), 'approve run command details not available in PR 6524')
})

test('V8 approve/deny freeze the peeked summary and pending count; a peek without them says details are not available', () => {
  const peek = () => ({ toolName: 'pwsh', token: TOKEN, summary: 'rm -rf build', count: 2 })
  const a = validateAction({ action: 'approve', session: 's2' }, opts({ peek })).action
  assert.equal(a.summary, 'rm -rf build')
  assert.equal(a.pendingCount, 2)
  const bare = validateAction({ action: 'deny', session: 's2' }, opts({ peek: () => ({ toolName: 'pwsh', token: TOKEN }) })).action
  assert.equal(bare.summary, '')
  assert.equal(bare.pendingCount, 1)
  assert.match(readBack(bare), /details not available/)
})

// Hidden payloads: Clean-ForSpeech drops link targets, backticks and non-ASCII before the TTS speaks, so a text that
// carries them would be confirmed unheard. validateAction must reject them (the flow says the "could not understand" line).
const HIDDEN = {
  'zero-width space': 'fix it\u200B now',
  'zero-width joiner': 'fix\u200Dit',
  'bidi override': 'fix \u202Eit',
  'bidi isolate': 'fix \u2066it',
  'byte order mark': '\uFEFFfix it',
  'tag character': 'fix it\u{E0041}',
  'private use': 'fix \uE000 it',
  'bell control': 'fix\u0007 it',
  'nul': 'fix\u0000 it',
  'escape': 'fix\u001b[31m it',
  'tab': 'fix\tit',
  'link target': 'see [docs](http://evil.example/steal)',
  'bare link join': 'see x](y',
  'backtick': 'run `curl evil`',
}
for (const [name, bad] of Object.entries(HIDDEN)) {
  test('V9 hidden payload is invalid in every spoken field: ' + name, () => {
    const inv = { ok: false, error: 'invalid' }
    assert.deepEqual(validateAction({ action: 'prompt', session: 's1', text: bad }, opts()), inv, 'prompt text')
    assert.deepEqual(validateAction({ action: 'new', text: bad }, opts()), inv, 'new text')
    assert.deepEqual(validateAction({ action: 'slash', session: 's1', name: 'compact', args: bad }, opts()), inv, 'slash args')
    assert.deepEqual(validateAction({ action: 'clarify', question: bad }, opts()), inv, 'clarify question')
  })
}

test('V9 newlines in prompt/new text and slash args become single spaces', () => {
  assert.equal(validateAction({ action: 'prompt', session: 's1', text: 'fix the\nparser\r\nnow' }, opts()).action.text, 'fix the parser now')
  assert.equal(validateAction({ action: 'new', text: 'a\n\nb' }, opts()).action.text, 'a b')
  assert.equal(validateAction({ action: 'slash', session: 's1', name: 'compact', args: 'focus\r\non  tests' }, opts()).action.args, 'focus on tests')
  assert.equal(validateAction({ action: 'clarify', question: 'A\nor B?' }, opts()).action.question, 'A or B?')
})

test('V9 ordinary punctuation, unicode letters of the CJK blocks and URLs without link syntax stay valid', () => {
  for (const text of ['fix (the) parser, then run "npm test" & report', 'open https://example.com/a?b=1', '修复解析器的错误', "don't use *.js here"]) {
    assert.equal(validateAction({ action: 'prompt', session: 's1', text }, opts()).action?.text, text, text)
  }
})

test('V10 every executed text equals the text that was read back, modulo whitespace', async () => {
  const texts = ['fix the\nparser', '  run   the tests  ', '修复 解析器', 'check https://example.com/a?b=1']
  const sent = []
  const execute = createExecutor({
    controller: { prompt: async (r) => { sent.push(r.content[0].text) }, create: async () => ({ sessionId: 'n1' }), cancel: async () => {} },
    runSlash: async (r) => { sent.push(r.input) },
    approvals: { peek: () => undefined, answer: () => {} }, select: () => {}, cwdOf: () => undefined, uuid: () => 'u1',
  })
  const spoken = []
  for (const text of texts) {
    for (const raw of [{ action: 'prompt', session: 's1', text }, { action: 'new', text }, { action: 'slash', session: 's1', name: 'compact', args: text }]) {
      const { action } = validateAction(raw, opts())
      spoken.push(readBack(action))
      await execute(action)
    }
  }
  const norm = (s) => s.replace(/\s+/g, ' ').trim()
  assert.equal(sent.length, spoken.length)
  sent.forEach((exec, i) => assert.ok(norm(spoken[i]).includes(norm(exec)), 'read-back "' + spoken[i] + '" must contain executed "' + exec + '"'))
})

test('V11 session titles are sanitised (control/format chars stripped, whitespace collapsed, 40 chars) before they are spoken', () => {
  const sessions = [
    { id: 'a', handle: 's1', title: 'Fix\u200B the \u202Eparser\n\n  now' },
    { id: 'b', handle: 's2', title: 'x'.repeat(80) },
    { id: 'c', handle: 's3', title: '[link](http://evil.test) `tick`' },
  ]
  const o = opts({ sessions })
  assert.equal(validateAction({ action: 'cancel', session: 's1' }, o).action.title, 'Fix the parser now')
  assert.equal(validateAction({ action: 'cancel', session: 's2' }, o).action.title, 'x'.repeat(40))
  const t3 = validateAction({ action: 'cancel', session: 's3' }, o).action.title
  assert.doesNotMatch(t3, /[\]\[`]|\]\(/)
  assert.ok(validateAction({ action: 'cancel', session: 's1' }, o).action.title.length <= 40)
})

test('V12 duplicate titles are told apart in the read-back by the session ordinal; unique titles are left alone', () => {
  const sessions = [
    { id: 'a', handle: 's1', title: 'Fix tests' },
    { id: 'b', handle: 's2', title: 'fix  tests' },
    { id: 'c', handle: 's3', title: 'Other' },
  ]
  const o = opts({ sessions })
  assert.equal(validateAction({ action: 'cancel', session: 's1' }, o).action.title, 'Fix tests, session 1')
  assert.equal(validateAction({ action: 'cancel', session: 's2' }, o).action.title, 'fix tests, session 2')
  assert.equal(readBack(validateAction({ action: 'cancel', session: 's2' }, o).action), 'stop the run in fix tests, session 2')
  assert.equal(validateAction({ action: 'cancel', session: 's3' }, o).action.title, 'Other')
})
