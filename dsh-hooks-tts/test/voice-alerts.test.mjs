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

test('Stop names the project folder however the cwd is written', () => {
  const a = alerts()
  assert.equal(a.headlineFor('Stop', { agentId: 's1', cwd: 'D:\\dev\\ai\\dsh-plugins', payload: {} }), 'One, dsh-plugins, done.')
  assert.equal(a.headlineFor('Stop', { agentId: 's2', cwd: 'D:/dev/ai/dsh-plugins/', payload: {} }), 'Two, dsh-plugins, done.')
  assert.equal(a.headlineFor('Stop', { agentId: 's3', cwd: 'D:\\dev\\ai\\dsh-plugins\\', payload: {} }), 'Three, dsh-plugins, done.')
  assert.equal(a.headlineFor('Stop', { agentId: 's4', payload: {} }), 'Four, done.')
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
  assert.equal(a.headlineFor('Stop', { payload: {} }), undefined)
  assert.equal(a.headlineFor('Stop', { agentId: 'q' }), 'One, done.')
})

test('buildHookBody keeps the existing fields and adds the headline for alerts', () => {
  const a = alerts()
  const agent = { id: 'a1', session: { header: { id: 'sess-1' } } }
  const body = buildHookBody({
    event: 'Stop', agent, cwd: 'D:\\dev\\ai\\dsh-plugins', sessionTitle: 'Voice work',
    payload: { stop_hook_active: false, last_assistant_message: 'long text', headline: 'forged' }, alerts: a,
  })
  assert.equal(body.headline, 'One, dsh-plugins, done.')
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
