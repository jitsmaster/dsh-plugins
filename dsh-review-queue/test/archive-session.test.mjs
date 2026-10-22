import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'

// The Archive button of the phone's session history: archives the session of any item that has one, open or resolved.
function setup({ archive } = {}) {
  const calls = []
  const store = createStore()
  const registry = { archivedSessionIds: [], archiveSession: archive ?? (async (id, options) => { calls.push([id, options]) }) }
  const queue = createReviewQueue({ store, capture: {}, log: () => {}, registryOf: () => registry })
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
