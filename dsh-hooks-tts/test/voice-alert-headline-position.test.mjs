// Slice 7 (task list by voice): headline alerts say the queue position when the item is already in the task list.
// The position is passed in (voice/alert-position.js finds it); without one the headlines are the old ones, unchanged.
import assert from 'node:assert/strict'
import test from 'node:test'
import { alertLocator, buildHookBody, createAlerts } from '../voice/alerts.js'
import { permissionHeadline, questionHeadline, stopHeadline } from '../voice/headline.js'

// Test list: stop / question / permission with a position; number words and digits; unusable positions are ignored;
// the capped wording rules still apply; headlineMaker renders later (held alerts); locator per event; buildHookBody.

test('HP1 stop: "Item three, done in <workspace>." then the last paragraph; session title when there is no workspace', () => {
  assert.equal(stopHeadline({ session: 'Voice work', workspace: 'dsh-plugins', summary: 'All merged.', position: 3 }), 'Item three, done in dsh-plugins. All merged.')
  assert.equal(stopHeadline({ session: 'Voice work', workspace: 'dsh-plugins', position: 3 }), 'Item three, done in dsh-plugins.')
  assert.equal(stopHeadline({ session: 'Voice work', workspace: '', position: 1 }), 'Item one, done in Voice work.')
  assert.equal(stopHeadline({ position: 2 }), 'Item two, done.')
})

test('HP2 question: "Item two, question: <first question>" capped at 15 words; bare "question." when none', () => {
  const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen'
  assert.equal(questionHeadline({ questions: [{ question: 'Which database?' }, { question: 'Other?' }], position: 2 }), 'Item two, question: Which database?')
  assert.equal(questionHeadline({ questions: [{ question: long }], position: 2 }), 'Item two, question: one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen...')
  assert.equal(questionHeadline({ questions: [], position: 2 }), 'Item two, question.')
})

test('HP3 permission: "Item four, approve write file?" with the same tool wording as before', () => {
  assert.equal(permissionHeadline({ toolName: 'write', position: 4 }), 'Item four, approve write file?')
  assert.equal(permissionHeadline({ toolName: 'pwsh', position: 1 }), 'Item one, approve run command?')
  assert.equal(permissionHeadline({ toolName: 'mcp_foo-bar', position: 12 }), 'Item twelve, approve mcp foo bar?')
})

test('HP4 numbers: words up to twenty, digits above', () => {
  assert.equal(permissionHeadline({ toolName: 'read', position: 20 }), 'Item twenty, approve read file?')
  assert.equal(permissionHeadline({ toolName: 'read', position: 21 }), 'Item 21, approve read file?')
})

test('HP5 a position that is not a positive whole number is ignored: the old headline', () => {
  for (const position of [undefined, null, 0, -1, 1.5, NaN, Infinity, '3', {}]) {
    assert.equal(stopHeadline({ workspace: 'w', position }), 'Done on: Workspace: w.', String(position))
    assert.equal(questionHeadline({ questions: [{ question: 'Q?' }], position }), 'Question: Q?', String(position))
    assert.equal(permissionHeadline({ toolName: 'edit', position }), 'Approve edit file?', String(position))
  }
})

test('HP6 headlineFor passes the position for all three events and leaves non-alert events alone', () => {
  const a = createAlerts()
  const cwd = 'D:\\dev\\dsh-plugins'
  assert.equal(a.headlineFor('Stop', { cwd, sessionTitle: 'T', payload: { last_assistant_message: 'Intro.\n\nShipped it.' }, position: 3 }), 'Item three, done in dsh-plugins. Shipped it.')
  assert.equal(a.headlineFor('PreToolUse', { payload: { tool_name: 'ask_user_question', tool_input: { questions: [{ question: 'Which one?' }] } }, position: 2 }), 'Item two, question: Which one?')
  assert.equal(a.headlineFor('PermissionRequest', { payload: { tool_name: 'write' }, position: 4 }), 'Item four, approve write file?')
  assert.equal(a.headlineFor('SessionStart', { payload: {}, position: 4 }), undefined)
  assert.equal(a.headlineFor('PreToolUse', { payload: { tool_name: 'read' }, position: 4 }), undefined)
  assert.equal(a.headlineFor('Stop', { cwd, sessionTitle: 'T', payload: {} }), 'Done on: Session: T; Workspace: dsh-plugins.', 'no position: unchanged')
})

test('HP7 headlineMaker renders the same line later, for any position (a held alert is re-rendered when it is replayed)', () => {
  const a = createAlerts()
  const make = a.headlineMaker('Stop', { cwd: 'D:\\x\\proj', sessionTitle: 'S', payload: { last_assistant_message: 'Done it.' } })
  assert.equal(make(5), 'Item five, done in proj. Done it.')
  assert.equal(make(undefined), 'Done on: Session: S; Workspace: proj. Done it.')
  assert.equal(make(2), 'Item two, done in proj. Done it.')
  assert.equal(a.headlineMaker('SessionStart', { payload: {} }), undefined)
  const q = a.headlineMaker('PreToolUse', { payload: { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?' }] } } })
  assert.equal(q(3), 'Item three, question: Q?')
  assert.equal(a.headlineMaker('PermissionRequest', { payload: { tool_name: 'edit' } })(1), 'Item one, approve edit file?')
})

test('HP8 headlineMaker keeps no reference to the payload (a held alert must not keep a huge tool_input alive): it renders from small parts', () => {
  const a = createAlerts()
  const payload = { tool_name: 'write', tool_input: { content: 'x'.repeat(1000) } }
  const make = a.headlineMaker('PermissionRequest', { payload })
  payload.tool_name = 'pwsh' // mutating the payload afterwards does not change what was captured
  assert.equal(make(1), 'Item one, approve write file?')
})

test('HP9 alertLocator names the item an alert is about: type, session, call id, tool', () => {
  assert.deepEqual(alertLocator('Stop', { agentId: 's1', payload: {} }), { type: 'completed', sessionId: 's1' })
  assert.deepEqual(alertLocator('PermissionRequest', { agentId: 's1', payload: { tool_name: 'pwsh' } }), { type: 'permission', sessionId: 's1', toolName: 'pwsh' })
  assert.deepEqual(alertLocator('PreToolUse', { agentId: 's1', payload: { tool_name: 'ask_user_question', tool_use_id: 'c1' } }), { type: 'question', sessionId: 's1', callId: 'c1' })
  assert.equal(alertLocator('PreToolUse', { agentId: 's1', payload: { tool_name: 'read' } }), undefined)
  assert.equal(alertLocator('SessionStart', { agentId: 's1', payload: {} }), undefined)
  assert.equal(alertLocator('Stop', { payload: {} }), undefined, 'no session: nothing to look up')
})

test('HP10 buildHookBody puts the positioned headline in the body; without a position it is the old one', () => {
  const base = { event: 'PermissionRequest', agent: { id: 's1', session: { header: { id: 'h' } } }, cwd: 'D:\\x', sessionTitle: 'T', payload: { tool_name: 'write' }, alerts: createAlerts() }
  assert.equal(buildHookBody({ ...base, position: 4 }).headline, 'Item four, approve write file?')
  assert.equal(buildHookBody(base).headline, 'Approve write file?')
  assert.equal(buildHookBody({ ...base, event: 'SessionStart', position: 4 }).headline, undefined)
})
