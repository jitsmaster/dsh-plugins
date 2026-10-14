// F6: the pending-tool-call summaries are keyed by session + tool + call id (never the call id alone), carry a hash of the arguments,
// and are dropped when the call settles.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolSummaries } from '../voice/tool-summaries.js'

const exec = (agentId, name, callId, args) => ({ agent: { id: agentId }, name, callId, arguments: args })
const req = (agentId, toolName, callId, reason) => ({ agent: { id: agentId }, toolName, callId, ...(reason ? { reason } : {}) })

test('F6 the same call id in two sessions never reads one approval back with the other call\'s summary', () => {
  const s = createToolSummaries()
  s.note(exec('s1', 'pwsh', 'call_0', { command: 'ls' }))
  s.note(exec('s2', 'pwsh', 'call_0', { command: 'rm -rf build' }))
  assert.equal(s.lookup(req('s1', 'pwsh', 'call_0')).text, 'ls')
  assert.equal(s.lookup(req('s2', 'pwsh', 'call_0')).text, 'rm -rf build')
  assert.equal(s.size(), 2)
})

test('F6 a request whose session, tool or call id differs finds nothing ("details not available")', () => {
  const s = createToolSummaries()
  s.note(exec('s1', 'pwsh', 'c1', { command: 'ls' }))
  assert.equal(s.lookup(req('s2', 'pwsh', 'c1')), undefined)
  assert.equal(s.lookup(req('s1', 'write', 'c1')), undefined)
  assert.equal(s.lookup(req('s1', 'pwsh', 'c2')), undefined)
  assert.equal(s.lookup(req('s1', 'pwsh', undefined)), undefined)
  assert.equal(s.lookup({ toolName: 'pwsh', callId: 'c1' }), undefined)
})

test('F6 the same key noted again with different arguments is a conflict: nothing is read back', () => {
  const s = createToolSummaries()
  s.note(exec('s1', 'pwsh', 'c1', { command: 'ls' }))
  s.note(exec('s1', 'pwsh', 'c1', { command: 'rm -rf x' }))
  assert.equal(s.lookup(req('s1', 'pwsh', 'c1')), undefined)
})

test('F6 the argument hash ignores key order, so a harmless re-note is not a conflict', () => {
  const s = createToolSummaries()
  s.note(exec('s1', 'pwsh', 'c1', { command: 'ls', workdir: 'D:\\x' }))
  s.note(exec('s1', 'pwsh', 'c1', { workdir: 'D:\\x', command: 'ls' }))
  assert.equal(s.lookup(req('s1', 'pwsh', 'c1')).text, 'ls, in directory D: backslash x')
})

test('F6 an entry is dropped when the call settles (by exec or by request), and the map stays bounded', () => {
  const s = createToolSummaries({ max: 3 })
  s.note(exec('s1', 'pwsh', 'c1', { command: 'ls' }))
  s.drop(exec('s1', 'pwsh', 'c1'))
  assert.equal(s.size(), 0)
  s.note(exec('s1', 'pwsh', 'c2', { command: 'ls' }))
  s.drop(req('s1', 'pwsh', 'c2'))
  assert.equal(s.size(), 0)
  for (let i = 0; i < 10; i++) s.note(exec('s1', 'pwsh', 'k' + i, { command: 'ls' }))
  assert.equal(s.size(), 3)
  assert.equal(s.lookup(req('s1', 'pwsh', 'k0')), undefined)
  assert.ok(s.lookup(req('s1', 'pwsh', 'k9')))
})

test('F2b the approval request\'s reason is read after the summary, and a missing call id or throwing summary never throws', () => {
  const s = createToolSummaries()
  s.note(exec('s1', 'pwsh', 'c1', { command: 'npm test', sandbox_permissions: 'danger-full-access' }))
  const info = s.lookup(req('s1', 'pwsh', 'c1', 'needs network access'))
  assert.equal(info.text, 'npm test, outside the sandbox, reason: needs network access')
  assert.equal(info.complete, true)
  s.note(exec('s1', 'pwsh', undefined, { command: 'ls' }))
  assert.equal(s.size(), 1)
  const bad = createToolSummaries({ summarise: () => { throw new Error('boom') } })
  assert.doesNotThrow(() => bad.note(exec('s1', 'pwsh', 'c1', {})))
  assert.equal(bad.lookup(req('s1', 'pwsh', 'c1')), undefined)
})


test('O1 with voice off (enabled() false) nothing is summarised, hashed or stored', () => {
  let summarised = 0
  let on = false
  const s = createToolSummaries({ enabled: () => on, summarise: () => { summarised++; return { text: 'x', complete: true } } })
  s.note(exec('s1', 'pwsh', 'c1', { command: 'ls' }))
  assert.equal(summarised, 0)
  assert.equal(s.size(), 0)
  assert.equal(s.lookup(req('s1', 'pwsh', 'c1')), undefined)
  on = true
  s.note(exec('s1', 'pwsh', 'c2', { command: 'ls' }))
  assert.equal(summarised, 1)
  assert.equal(s.size(), 1)
})

test('O1 a throwing enabled() never throws out of note()', () => {
  const s = createToolSummaries({ enabled: () => { throw new Error('boom') } })
  assert.doesNotThrow(() => s.note(exec('s1', 'pwsh', 'c1', { command: 'ls' })))
  assert.equal(s.size(), 0)
})
