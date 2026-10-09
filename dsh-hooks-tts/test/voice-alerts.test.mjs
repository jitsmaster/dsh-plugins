import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHookBody, createAlerts } from '../voice/alerts.js'
import { createNumbers } from '../voice/numbers.js'

const alerts = () => createAlerts({
  numbers: createNumbers(mkdtempSync(join(tmpdir(), 'alerts-')), () => new Date('2026-10-09T10:00:00')),
})

test('Stop names session and workspace however the cwd is written, then reads the last paragraph', () => {
  const a = alerts()
  const payload = { last_assistant_message: 'Early part.\n\nThe last paragraph.' }
  const want = 'Done on: Session: Voice work; Workspace: dsh-plugins. The last paragraph.'
  for (const cwd of ['D:\\dev\\ai\\dsh-plugins', 'D:/dev/ai/dsh-plugins/', 'D:\\dev\\ai\\dsh-plugins\\']) {
    assert.equal(a.headlineFor('Stop', { agentId: 's1', cwd, sessionTitle: 'Voice work', payload }), want)
  }
  assert.equal(a.headlineFor('Stop', { agentId: 's4', payload: {} }), 'Done.')
})

test('a worktree is announced by the repository it belongs to', () => {
  const a = alerts()
  const say = (cwd) => a.headlineFor('Stop', { agentId: 'w', cwd, sessionTitle: 'T', payload: {} })
  assert.equal(say('D:\\dev\\ai\\dsh-plugins\\.worktrees\\voice-control'), 'Done on: Session: T; Workspace: dsh-plugins.')
  assert.equal(say('D:\\dev\\CTnP-Final\\.claude\\worktrees\\sonar-zero-issues'), 'Done on: Session: T; Workspace: CTnP-Final.')
  assert.equal(say('D:/dev/ai/STT'), 'Done on: Session: T; Workspace: STT.')
})

test('a session keeps its number across alert kinds', () => {
  const a = alerts()
  a.headlineFor('Stop', { agentId: 'x', cwd: 'C:\\p', payload: {} })
  assert.equal(a.headlineFor('PermissionRequest', { agentId: 'y', payload: { tool_name: 'write' } }), 'Two, approve write file?')
  assert.equal(a.headlineFor('PermissionRequest', { agentId: 'x', payload: { tool_name: 'edit' } }), 'One, approve edit file?')
})

test('ask_user_question becomes a question headline under either tool name', () => {
  const a = alerts()
  const tool_input = { questions: [{ question: 'Which one?' }] }
  assert.equal(a.headlineFor('PreToolUse', { agentId: 'q', payload: { tool_name: 'ask_user_question', tool_input } }), 'One, question: Which one?')
  assert.equal(a.headlineFor('PreToolUse', { agentId: 'q', payload: { tool_name: 'AskUserQuestion', tool_input } }), 'One, question: Which one?')
})

test('other tools, other events and calls without an agent give no headline', () => {
  const a = alerts()
  assert.equal(a.headlineFor('PreToolUse', { agentId: 'q', payload: { tool_name: 'read' } }), undefined)
  assert.equal(a.headlineFor('SessionStart', { agentId: 'q', payload: {} }), undefined)
  assert.equal(a.headlineFor('Stop', { payload: {} }), 'Done.') // Stop does not need an agent: nothing numbered is spoken
  assert.equal(a.headlineFor('PermissionRequest', { payload: {} }), undefined)
})

test('buildHookBody keeps the existing fields and adds the headline for alerts', () => {
  const a = alerts()
  const agent = { id: 'a1', session: { header: { id: 'sess-1' } } }
  const body = buildHookBody({
    event: 'Stop', agent, cwd: 'D:\\dev\\ai\\dsh-plugins', sessionTitle: 'Voice work',
    payload: { stop_hook_active: false, last_assistant_message: 'long text', headline: 'forged' }, alerts: a,
  })
  assert.equal(body.headline, 'Done on: Session: Voice work; Workspace: dsh-plugins. long text')
  assert.equal(body.session_id, 'sess-1')
  assert.equal(body.session_title, 'Voice work')
  assert.equal(body.hook_event_name, 'Stop')
  assert.equal(body.cwd, 'D:\\dev\\ai\\dsh-plugins')
  assert.equal(body.last_assistant_message, 'long text')
})

test('buildHookBody adds no headline key for non-alert events and fills defaults', () => {
  const body = buildHookBody({ event: 'SessionStart', agent: undefined, cwd: undefined, sessionTitle: undefined, payload: { source: 'startup' }, alerts: alerts() })
  assert.equal('headline' in body, false)
  assert.equal(body.session_id, '')
  assert.equal(body.session_title, '')
  assert.equal(body.source, 'startup')
  assert.equal(body.cwd, process.cwd())
})

test('a drive root or a dot is not a project name', () => {
  const al = alerts()
  assert.equal(al.headlineFor('Stop', { agentId: 'r1', cwd: 'D:\\', payload: {} }), 'Done.')
  assert.equal(al.headlineFor('Stop', { agentId: 'r2', cwd: '.', payload: {} }), 'Done.')
})
