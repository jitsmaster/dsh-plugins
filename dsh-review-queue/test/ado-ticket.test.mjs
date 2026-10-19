import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findTicket, fetchTicketTitle, ticketTitleFor, DEFAULT_ADO_BASE } from '../ado-ticket.js'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

const ENV = { AZURE_DEVOPS_EXT_PAT: 'secret-pat-value' }
const reply = (title, ok = true, status = 200) => async () => ({ ok, status, json: async () => ({ fields: { 'System.Title': title } }) })

test('findTicket: work item URLs give the id and the organisation/project of the URL', () => {
  assert.deepEqual(findTicket('please do https://dev.azure.com/acme/Proj/_workitems/edit/4711 today'), { id: '4711', base: 'https://dev.azure.com/acme/Proj' })
  assert.deepEqual(findTicket('https://ingeniuxdev.visualstudio.com/Ingeniux/_workitems/edit/12345/'), { id: '12345', base: 'https://ingeniuxdev.visualstudio.com/Ingeniux' })
  assert.deepEqual(findTicket('see https://dev.azure.com/acme/Proj/_boards/board/t/Team/Stories?workitem=99001.'), { id: '99001', base: 'https://dev.azure.com/acme/Proj' })
})

test('findTicket: AB#n and "ticket n" use the default project; plain numbers and other URLs are not tickets', () => {
  assert.deepEqual(findTicket('Fix AB#5521 now'), { id: '5521', base: DEFAULT_ADO_BASE })
  assert.deepEqual(findTicket('look at ADO ticket 70123 please'), { id: '70123', base: DEFAULT_ADO_BASE })
  assert.deepEqual(findTicket('work item #8812'), { id: '8812', base: DEFAULT_ADO_BASE })
  assert.equal(findTicket('upgrade to version 12345 of the lib'), undefined)
  assert.equal(findTicket('ticket 12'), undefined)
  assert.equal(findTicket('see https://github.com/x/y/issues/12345'), undefined)
  assert.equal(findTicket(''), undefined)
})

test('fetchTicketTitle: asks the REST API with the PAT as Basic auth', async () => {
  let seen
  const title = await fetchTicketTitle({ id: '4711', base: 'https://dev.azure.com/acme/Proj' }, { env: ENV, fetchImpl: async (url, init) => { seen = { url: String(url), init }; return reply('Login redirect loops')() } })
  assert.equal(title, 'Login redirect loops')
  assert.match(seen.url, /^https:\/\/dev\.azure\.com\/acme\/Proj\/_apis\/wit\/workitems\/4711\?fields=System\.Title/)
  assert.equal(seen.init.headers.Authorization, 'Basic ' + Buffer.from(':secret-pat-value').toString('base64'))
})

test('fetchTicketTitle: no PAT, an untrusted host, an HTTP error or a throwing fetch all give undefined and never leak the PAT', async () => {
  const logs = []
  let called = 0
  const fetchImpl = async () => { called++; return reply('x')() }
  assert.equal(await fetchTicketTitle({ id: '1', base: DEFAULT_ADO_BASE }, { env: {}, fetchImpl, log: (l) => logs.push(l) }), undefined)
  assert.equal(await fetchTicketTitle({ id: '1', base: 'https://evil.example.com/org/proj' }, { env: ENV, fetchImpl, log: (l) => logs.push(l) }), undefined)
  assert.equal(await fetchTicketTitle({ id: '1', base: 'http://dev.azure.com/org/proj' }, { env: ENV, fetchImpl, log: (l) => logs.push(l) }), undefined)
  assert.equal(called, 0, 'the PAT is never sent to an untrusted host')
  assert.equal(await fetchTicketTitle({ id: '1', base: DEFAULT_ADO_BASE }, { env: ENV, fetchImpl: reply('', false, 404), log: (l) => logs.push(l) }), undefined)
  assert.equal(await fetchTicketTitle({ id: '1', base: DEFAULT_ADO_BASE }, { env: ENV, fetchImpl: async () => { throw new Error('boom secret-pat-value') }, log: (l) => logs.push(l) }), undefined)
  assert.ok(logs.length >= 5)
  assert.ok(logs.every((l) => !l.includes('secret-pat-value')), logs.join('\n'))
})

test('ticketTitleFor: "Fix: <ticket title> - <number>", the number kept when the title cannot be read, undefined with no ticket', async () => {
  const text = 'Work on https://dev.azure.com/acme/Proj/_workitems/edit/4711 and keep it small'
  assert.equal(await ticketTitleFor(text, { env: ENV, fetchImpl: reply('Login redirect loops') }), 'Fix: Login redirect loops - 4711')
  assert.equal(await ticketTitleFor(text, { env: {} }), 'Fix: Work on and keep it small - 4711')
  assert.equal(await ticketTitleFor('https://dev.azure.com/acme/Proj/_workitems/edit/4711', { env: {} }), 'Fix: ticket 4711 - 4711')
  assert.equal(await ticketTitleFor('Fix the login redirect', { env: ENV, fetchImpl: reply('never asked') }), undefined)
})

test('a todo that mentions a ticket starts a session titled "Fix: <title> - <number>"; one that does not keeps the first-line title', async () => {
  let n = 0
  const store = createStore({ now: () => 1000 + ++n, uuid: () => 'i' + ++n })
  const calls = []
  const controller = {
    create: async () => ({ sessionId: 'S' + ++n }),
    rename: async (arg) => { calls.push(arg) },
    prompt: async () => ({}),
  }
  const asked = []
  const queue = createReviewQueue({
    store, capture: { decidePermission: () => ({ ok: false, error: 'not-pending' }) }, controllerOf: () => controller,
    registryOf: () => ({ list: () => [{ id: 'w1', title: 'Main', path: 'D:/x', sessionIds: [] }], archivedSessionIds: [] }), now: () => 5000,
    ticketTitleOf: async (text) => { asked.push(text); return /AB#77/.test(text) ? 'Fix: Broken menu - 77' : undefined },
  })
  queue.addTodo('Implement AB#77\nplease', { workspaceId: 'w1' })
  queue.addTodo('Plain task', { workspaceId: 'w1' })
  await queue.todoIdle()
  assert.deepEqual(calls.map((c) => c.title), ['Fix: Broken menu - 77', 'Plain task'])
  assert.equal(asked.length, 2)
})

test('a todo whose ticket lookup throws still starts, with the first-line title', async () => {
  let n = 0
  const store = createStore({ now: () => 1000 + ++n, uuid: () => 'i' + ++n })
  const titles = []
  const controller = { create: async () => ({ sessionId: 'S1' }), rename: async (a) => { titles.push(a.title) }, prompt: async () => ({}) }
  const queue = createReviewQueue({
    store, capture: { decidePermission: () => ({ ok: false, error: 'not-pending' }) }, controllerOf: () => controller,
    registryOf: () => ({ list: () => [{ id: 'w1', title: 'Main', path: 'D:/x', sessionIds: [] }], archivedSessionIds: [] }), now: () => 5000,
    ticketTitleOf: async () => { throw new Error('lookup exploded') },
  })
  queue.addTodo('Do AB#77', { workspaceId: 'w1' })
  await queue.todoIdle()
  assert.deepEqual(titles, ['Do AB#77'])
  assert.equal([...store.list({ status: 'resolved' })].find((i) => i.type === 'todo').state, 'started')
})
