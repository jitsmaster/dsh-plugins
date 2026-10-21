import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchTicketState, diffTicket } from '../ado-ticket.js'

const ref = { id: '25751', base: 'https://dev.azure.com/ingeniuxdev/Ingeniux' }
const okFetch = (fields, seen = []) => async (url, init) => { seen.push({ url: String(url), init }); return { ok: true, status: 200, json: async () => ({ fields }) } }
const FIELDS = { 'System.State': 'Active', 'System.AssignedTo': { displayName: 'Arnold Wang', uniqueName: 'a@x.com' }, 'System.Description': '<p>Do it</p>', 'System.CommentCount': 2 }

test('fetchTicketState reads state, assignee, a description fingerprint and the comment count with one call', async () => {
  const seen = []
  const r = await fetchTicketState(ref, { env: { AZURE_DEVOPS_EXT_PAT: 'pat' }, fetchImpl: okFetch(FIELDS, seen) })
  assert.equal(r.ok, true)
  assert.deepEqual([r.state.state, r.state.assignee, r.state.commentCount], ['Active', 'Arnold Wang', 2])
  assert.match(r.state.descriptionHash, /^[0-9a-f]{16,}$/)
  assert.equal(seen.length, 1)
  assert.match(seen[0].url, /\/_apis\/wit\/workitems\/25751\?fields=.*System\.CommentCount.*api-version=/)
  assert.equal(seen[0].init.headers.Authorization, 'Basic ' + Buffer.from(':pat').toString('base64'))
})

test('the same description gives the same fingerprint, a changed one a different one; a ticket without description or assignee still reads', async () => {
  const a = await fetchTicketState(ref, { env: { AZURE_DEVOPS_EXT_PAT: 'p' }, fetchImpl: okFetch(FIELDS) })
  const b = await fetchTicketState(ref, { env: { AZURE_DEVOPS_EXT_PAT: 'p' }, fetchImpl: okFetch({ ...FIELDS, 'System.Description': '<p>Do more</p>' }) })
  const c = await fetchTicketState(ref, { env: { AZURE_DEVOPS_EXT_PAT: 'p' }, fetchImpl: okFetch({ 'System.State': 'New' }) })
  assert.notEqual(a.state.descriptionHash, b.state.descriptionHash)
  assert.deepEqual([c.ok, c.state.assignee, c.state.commentCount], [true, '', 0])
})

test('failures are codes, never throws, and never carry the PAT', async () => {
  assert.deepEqual(await fetchTicketState(ref, { env: {}, fetchImpl: okFetch(FIELDS) }), { ok: false, error: 'no-pat' })
  assert.deepEqual(await fetchTicketState(ref, { env: { AZURE_DEVOPS_EXT_PAT: 'p' }, fetchImpl: async () => ({ ok: false, status: 401 }) }), { ok: false, error: 'http-401' })
  const boom = await fetchTicketState(ref, { env: { AZURE_DEVOPS_EXT_PAT: 'secret-pat' }, fetchImpl: async () => { throw new Error('down secret-pat') } })
  assert.deepEqual(boom, { ok: false, error: 'unreachable' })
  assert.deepEqual(await fetchTicketState({ id: '1', base: 'https://evil.example/x' }, { env: { AZURE_DEVOPS_EXT_PAT: 'p' }, fetchImpl: okFetch(FIELDS) }), { ok: false, error: 'untrusted-host' })
})

test('diffTicket names new comments, a state change, an assignee change and a description change; nothing else counts', () => {
  const base = { state: 'Active', assignee: 'Arnold Wang', descriptionHash: 'aaaa', commentCount: 2, title: 'T' }
  assert.deepEqual(diffTicket(base, { ...base }), [])
  assert.deepEqual(diffTicket(base, { ...base, title: 'Renamed', rev: 9 }), [])
  assert.deepEqual(diffTicket(base, { ...base, commentCount: 3 }), ['1 new comment'])
  assert.deepEqual(diffTicket(base, { ...base, commentCount: 5 }), ['3 new comments'])
  assert.deepEqual(diffTicket(base, { ...base, commentCount: 1 }), [])
  assert.deepEqual(diffTicket(base, { ...base, state: 'Resolved' }), ['state Active -> Resolved'])
  assert.deepEqual(diffTicket(base, { ...base, assignee: '' }), ['assignee Arnold Wang -> nobody'])
  assert.deepEqual(diffTicket(base, { ...base, assignee: 'Sam Lee' }), ['assignee Arnold Wang -> Sam Lee'])
  assert.deepEqual(diffTicket(base, { ...base, descriptionHash: 'bbbb' }), ['description changed'])
  assert.deepEqual(diffTicket(base, { ...base, commentCount: 3, state: 'Done' }), ['1 new comment', 'state Active -> Done'])
  assert.deepEqual(diffTicket(undefined, base), [])
})
