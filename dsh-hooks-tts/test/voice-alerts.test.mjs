import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAlerts } from '../voice/alerts.js'
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
