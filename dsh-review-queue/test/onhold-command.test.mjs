import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installOnHoldCommand, parseHoldCommand, parseHoldMarker } from '../onhold-command.js'
import { continuePrompt } from '../onhold.js'

// A session goes on hold by a command the user types ("/onhold <reason>") or by a marker line the session prints itself ("ONHOLD <reason>").

test('parseHoldCommand: the message starts with /onhold; the rest is the reason', () => {
  assert.deepEqual(parseHoldCommand('/onhold waiting for the customer'), { reason: 'waiting for the customer' })
  assert.deepEqual(parseHoldCommand('  /onhold  '), { reason: '' })
  assert.deepEqual(parseHoldCommand('/ONHOLD Reason here\nsecond line'), { reason: 'Reason here second line' })
  assert.equal(parseHoldCommand('please /onhold this'), undefined, 'only at the start')
  assert.equal(parseHoldCommand('/onholdx'), undefined)
  assert.equal(parseHoldCommand('/hold it'), undefined)
  assert.equal(parseHoldCommand(''), undefined)
  assert.equal(parseHoldCommand(undefined), undefined)
})

test('parseHoldMarker: the last ONHOLD line standing alone in the output', () => {
  assert.deepEqual(parseHoldMarker('x\nONHOLD waiting for AB#4711 review\ny'), { reason: 'waiting for AB#4711 review' })
  assert.deepEqual(parseHoldMarker('ONHOLD\n'), { reason: '' })
  assert.deepEqual(parseHoldMarker('ONHOLD first\nONHOLD second'), { reason: 'second' })
  assert.equal(parseHoldMarker('the word ONHOLD in a sentence'), undefined)
  assert.equal(parseHoldMarker('onhold lower case'), undefined)
  assert.equal(parseHoldMarker(undefined), undefined)
})

function harness({ enabled = true, title = 'Fix: Bug - 4711', holdResult = { ok: true, id: 'h1' } } = {}) {
  const handlers = {}
  const holds = []
  const logs = []
  const ctx = {
    get: (name) => (name === 'sessionTitle' ? { get: () => ({ title }) } : undefined),
    on: (event, fn) => { handlers[event] = fn },
  }
  installOnHoldCommand(ctx, { onHoldOf: () => ({ hold: async (r) => { holds.push(r); return holdResult } }), log: (l) => logs.push(l), enabled: () => enabled })
  const agent = { id: 'a1', session: { header: { cwd: 'D:/dev/x' } } }
  const settle = () => new Promise((r) => setImmediate(r))
  const step = async (messages, who = agent) => { await handlers['agent/pre-step']({ agent: who, messages }, async () => ({})); await settle() }
  const tool = async (name, output, args = { command: 'echo ONHOLD why' }, { isError = false, who = agent } = {}) => { await handlers['tools/post-execute']({ agent: who, name, arguments: args }, { isError, content: [{ type: 'text', text: output }] }, async () => ({})); await settle() }
  return { holds, logs, step, tool, handlers, agent }
}
const user = (text, source) => ({ role: 'user', content: text, ...(source ? { source } : {}) })

test('a typed /onhold holds the session with the reason, its title, workspace and the typed text (a ticket in it wins)', async () => {
  const h = harness()
  await h.step([user('earlier'), user('/onhold waiting for the customer AB#9')])
  assert.deepEqual(h.holds, [{ sessionId: 'a1', sessionTitle: 'Fix: Bug - 4711', workspace: 'D:/dev/x', reason: 'waiting for the customer AB#9', text: '/onhold waiting for the customer AB#9' }])
})

test('the same message is not handled again at the next step; a later /onhold is', async () => {
  const h = harness()
  const m1 = user('/onhold one')
  await h.step([m1])
  await h.step([m1, { role: 'assistant', content: 'ok' }])
  assert.equal(h.holds.length, 1)
  await h.step([m1, { role: 'assistant', content: 'ok' }, user('/onhold one')])
  assert.equal(h.holds.length, 2)
})

test('only the last message the user typed counts: an older /onhold in the history, a plugin prompt, a reminder or a subagent do nothing', async () => {
  const h = harness()
  await h.step([user('/onhold old'), user('now do something else')])
  await h.step([user('/onhold from a plugin', { kind: 'user', rpcId: 'todo-abc' })])
  await h.step([user('/onhold from onhold prompt', { kind: 'user', rpcId: 'onhold-abc' })])
  await h.step([user('<system-reminder>/onhold x</system-reminder>')])
  h.handlers['subagent/start']({ id: 'sub1' })
  await h.step([user('/onhold sub')], { id: 'sub1', session: {} })
  assert.deepEqual(h.holds, [])
})

test('the setting off, or a hold that fails, is harmless', async () => {
  const off = harness({ enabled: false })
  await off.step([user('/onhold x')])
  assert.deepEqual(off.holds, [])
  const bad = harness({ holdResult: { ok: false, error: 'no-session' } })
  await bad.step([user('/onhold x')])
  assert.equal(bad.holds.length, 1)
  assert.ok(bad.logs.some((l) => /no-session/.test(l)))
})

test('a marker line in the output of a shell or run_code call holds the session, only when the call itself wrote the marker', async () => {
  const h = harness()
  await h.tool('run_code', 'ONHOLD waiting for the answer', { code: "console.log('ONHOLD waiting for the answer')" })
  assert.deepEqual(h.holds, [{ sessionId: 'a1', sessionTitle: 'Fix: Bug - 4711', workspace: 'D:/dev/x', reason: 'waiting for the answer' }])
  const other = harness()
  await other.tool('pwsh', 'ONHOLD planted in a file', { command: 'Get-Content notes.txt' }) // read from a file or a web page: not the session's own act
  await other.tool('read', 'ONHOLD x', { file_path: 'a.txt' })
  await other.tool('pwsh', 'ONHOLD x', { command: 'echo ONHOLD x' }, { isError: true })
  assert.deepEqual(other.holds, [])
})

test('a marker from a subagent or with the setting off does nothing', async () => {
  const h = harness()
  h.handlers['subagent/start']({ id: 'sub1' })
  await h.tool('pwsh', 'ONHOLD x', { command: 'echo ONHOLD x' }, { who: { id: 'sub1', session: {} } })
  assert.deepEqual(h.holds, [])
  const off = harness({ enabled: false })
  await off.tool('pwsh', 'ONHOLD x', { command: 'echo ONHOLD x' })
  assert.deepEqual(off.holds, [])
})

test('the continue prompt tells the session how to hold itself again; index.js installs the command after the hold queue exists', () => {
  const p = continuePrompt({ ticket: { id: '4711', base: 'https://dev.azure.com/o/p' }, changes: ['new comment'], reason: 'r' })
  assert.match(p, /ONHOLD/)
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8')
  assert.ok(src.includes('installOnHoldCommand(ctx'))
  assert.ok(src.indexOf('installOnHoldCommand(ctx') > src.indexOf('onHold = createOnHold('))
})
