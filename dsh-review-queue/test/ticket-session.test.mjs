import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTicketSessions, keepsTitle } from '../ticket-session.js'

function harness({ title, ticketTitle = 'Fix: Login redirect loops - 4711', enabled = true, renameError } = {}) {
  const state = { title }
  const renames = []
  const handlers = {}
  const asked = []
  const ctx = {
    get: (name) => (name === 'sessionTitle' ? { get: () => (state.title === undefined ? undefined : { title: state.title }) } : undefined),
    on: (event, fn) => { handlers[event] = fn },
  }
  const controller = { rename: async (r) => { if (renameError) throw new Error(renameError); renames.push(r); state.title = r.title } }
  const logs = []
  installTicketSessions(ctx, { controllerOf: () => controller, log: (l) => logs.push(l), enabled: () => enabled, ticketTitleOf: async (text) => { asked.push(text); return ticketTitle } })
  const agent = { id: 'a1', session: {} }
  const step = async (text, { source, agent: who = agent } = {}) => { await handlers['agent/pre-step']({ agent: who, messages: [{ role: 'user', content: text, ...(source ? { source } : {}) }] }, async () => ({})); await new Promise((r) => setImmediate(r)) }
  return { state, renames, handlers, asked, logs, step, agent }
}

test('a prompt that mentions a ticket renames the session, whatever it was called', async () => {
  const h = harness({ title: 'Some old chat' })
  await h.step('please look at AB#4711')
  assert.deepEqual(h.renames, [{ sessionId: 'a1', title: 'Fix: Login redirect loops - 4711' }])
})

test('the step is not delayed by the lookup and the rename is attempted once per ticket', async () => {
  const h = harness({ title: 'x', renameError: 'nope' })
  await h.step('AB#4711 first')
  await h.step('AB#4711 again')
  assert.equal(h.asked.length, 1)
  assert.ok(h.logs.some((l) => /rename of a1 failed: nope/.test(l)))
})

test('a prompt without a ticket changes nothing', async () => {
  const h = harness({ title: 'x' })
  await h.step('fix the build, version 12345 of the lib')
  assert.deepEqual(h.renames, [])
  assert.equal(h.asked.length, 0)
})

test('a session that already refers to a ticket, or is a PR session, keeps its title', async () => {
  for (const title of ['Fix: Menu - 777', 'Fix: Menu - 777 - 2', 'Fix: Menu - 777 - after PR 5', 'PR 42', 'PR 42 - Fix: Menu - 777', 'Continue PR 42 - Fix: Menu - 777']) {
    const h = harness({ title })
    await h.step('also see AB#4711')
    assert.deepEqual(h.renames, [], title)
  }
})

test('a session on hold stays on hold', async () => {
  const h = harness({ title: '\u23f8\ufe0f old chat' })
  await h.step('AB#4711')
  assert.equal(h.renames[0].title, '\u23f8\ufe0f Fix: Login redirect loops - 4711')
})

test('only what the user typed counts: plugin prompts, reminders and subagents are ignored', async () => {
  const h = harness({ title: 'x' })
  await h.step('Work on AB#4711', { source: { kind: 'user', rpcId: 'todo-abc' } })
  await h.step('<system-reminder>AB#4711</system-reminder>')
  await h.step('Work on AB#4711', { source: { kind: 'goal-round' } })
  h.handlers['subagent/start']({ id: 'sub1' })
  await h.step('Work on AB#4711', { agent: { id: 'sub1', session: {} } })
  assert.deepEqual(h.renames, [])
  await h.step('Work on AB#4711', { source: { kind: 'user', rpcId: 'review-1' } })
  assert.equal(h.renames.length, 1)
})

test('a title that cannot be found, or the setting off, renames nothing', async () => {
  const none = harness({ title: 'x', ticketTitle: null })
  await none.step('AB#4711')
  assert.deepEqual(none.renames, [])
  const off = harness({ title: 'x', enabled: false })
  await off.step('AB#4711')
  assert.deepEqual(off.renames, [])
})

test('keepsTitle', () => {
  assert.ok(keepsTitle('PR 9'))
  assert.ok(keepsTitle('Fix: a - b - 12345'))
  assert.ok(!keepsTitle('Fix the menu'))
  assert.ok(!keepsTitle(undefined))
})
