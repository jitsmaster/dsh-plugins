import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// The Archive button of the phone's session history: archives the session of any item that has one, open or resolved.
function setup({ archive, prGuard } = {}) {
  const calls = []
  const store = createStore()
  const registry = { archivedSessionIds: [], archiveSession: archive ?? (async (id, options) => { calls.push([id, options]) }) }
  const queue = createReviewQueue({ store, capture: {}, log: () => {}, registryOf: () => registry, prGuardOf: prGuard ? () => prGuard : undefined })
  return { store, queue, calls }
}

test('archiveSession archives the session of a resolved item and closes the open done items of that session', async () => {
  const { store, queue, calls } = setup()
  const old = store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'Work' })
  store.resolve(old.id, { kind: 'reviewed', by: 'card' })
  const open = store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'Work' })
  const other = store.add({ type: 'completed', sessionId: 's2', sessionTitle: 'Other' })
  assert.deepEqual(await queue.archiveSession(old.id), { ok: true })
  assert.deepEqual(calls, [['s1', { stopActivity: true }]])
  assert.deepEqual(store.get(open.id).resolution, { kind: 'archived', by: 'card' })
  assert.equal(store.get(other.id).status, 'open')
  assert.equal(store.get(old.id).resolution.kind, 'reviewed')
})

test('archiveSession refuses a missing item, a todo and a missing registry; failures keep the items open', async () => {
  const { store, queue } = setup()
  assert.deepEqual(await queue.archiveSession('nope'), { ok: false, error: 'not-found' })
  const todo = store.add({ type: 'todo', text: 'x' })
  assert.deepEqual(await queue.archiveSession(todo.id), { ok: false, error: 'not-a-session' })
  const failing = setup({ archive: async () => { throw new Error('storage fault') } })
  const item = failing.store.add({ type: 'completed', sessionId: 's1' })
  assert.deepEqual(await failing.queue.archiveSession(item.id), { ok: false, error: 'storage fault' })
  assert.equal(failing.store.get(item.id).status, 'open')
  const gone = setup({ archive: async () => { throw Object.assign(new Error('unknown'), { name: 'WorkspaceUnknownSessionError' }) } })
  const g = gone.store.add({ type: 'completed', sessionId: 's1' })
  assert.deepEqual(await gone.queue.archiveSession(g.id), { ok: false, error: 'no-session' })
  assert.equal(gone.store.get(g.id).resolution.kind, 'session-ended')
})

test('the phone view has the Archive button on the conversation and posts /v1/archive-session', async () => {
  const { readFileSync } = await import('node:fs')
  const views = readFileSync(new URL('../lib/mobile/views.js', import.meta.url), 'utf8')
  assert.match(views, /function ArchiveSessionButton/)
  assert.match(views, /act\('\/v1\/archive-session'/)
  assert.match(views, /<\$\{ArchiveSessionButton\} item=\$\{item\} onDone=/)
})

test('the Resolved list rows carry the same Archive button, outside the link', async () => {
  const { readFileSync } = await import('node:fs')
  const views = readFileSync(new URL('../lib/mobile/views.js', import.meta.url), 'utf8')
  const list = views.slice(views.indexOf('function ResolvedList'), views.indexOf('function NewTodoView'))
  assert.match(list, /class="resolved-row"[\s\S]*<\/a>[\s\S]*<\$\{ArchiveSessionButton\} item=\$\{i\} \/>/)
})

// A session that polls a still-open PR keeps its poll: the plugin's own Archive buttons answer pr-open instead of archiving it.
const openPr = { check: async (id) => (id === 'pr-session' ? { protected: true, prId: '5', status: 'active' } : { protected: false }) }

test('archiveSession and archive refuse the poll session of an open PR and leave every item open', async () => {
  const { store, queue, calls } = setup({ prGuard: openPr })
  const done = store.add({ type: 'completed', sessionId: 'pr-session', sessionTitle: 'PR 5' })
  const offer = store.add({ type: 'archive', sessionId: 'pr-session', sessionTitle: 'PR 5' })
  const viaSession = await queue.archiveSession(done.id)
  assert.equal(viaSession.ok, false)
  assert.equal(viaSession.error, 'pr-open')
  assert.match(viaSession.message, /PR 5 is still open/)
  const viaCard = await queue.archive(offer.id)
  assert.equal(viaCard.error, 'pr-open')
  assert.deepEqual(calls, [])
  assert.equal(store.get(done.id).status, 'open')
  assert.equal(store.get(offer.id).status, 'open')
})

test('archiveSession and archive still archive a session the guard does not protect, and tolerate a missing or throwing guard', async () => {
  const free = setup({ prGuard: openPr })
  const item = free.store.add({ type: 'completed', sessionId: 's1' })
  assert.deepEqual(await free.queue.archiveSession(item.id), { ok: true })
  assert.deepEqual(free.calls, [['s1', { stopActivity: true }]])
  const throwing = setup({ prGuard: { check: async () => { throw new Error('guard broke') } } })
  const t = throwing.store.add({ type: 'archive', sessionId: 's2' })
  assert.deepEqual(await throwing.queue.archive(t.id), { ok: true })
})

test('the card and the phone word the pr-open refusal', async () => {
  const { readFileSync } = await import('node:fs')
  assert.match(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), /"pr-open": "[^"]*pull request[^"]*"/)
})
