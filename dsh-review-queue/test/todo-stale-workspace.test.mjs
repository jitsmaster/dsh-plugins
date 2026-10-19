import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KEY, loadClient, savedDraft, formOf, okJson } from './client-todo-helpers.mjs'

// A restored todo draft names a workspace that DSH may not have any more: once the workspace list is known and lacks the id, the id is
// dropped (the select falls back to "Choose for me"); the text, SPARC and the rest of the draft stay.
const draft = (over = {}) => ({ [KEY]: JSON.stringify({ text: 'Fix it', workspaceId: 'gone', sparc: true, open: true, ...over }) })
const listing = (workspaces) => async () => okJson({ workspaces })

test('a restored workspace the loaded list does not contain is dropped, in the form and in the saved draft', async () => {
  const { T, store } = loadClient({ stored: draft(), fetchImpl: listing([{ id: 'w1', title: 'Alpha' }]) })
  assert.equal(T.state.todoForm.workspaceId, 'gone', 'restored as saved until the list is known')
  await T.loadWorkspaces()
  const f = formOf(T)
  assert.deepEqual([f.workspaceId, f.text, f.sparc, f.open], ['', 'Fix it', true, true])
  assert.equal(savedDraft(store).workspaceId, '')
  assert.equal(savedDraft(store).text, 'Fix it')
})

test('a restored workspace that the list contains is kept', async () => {
  const { T } = loadClient({ stored: draft({ workspaceId: 'w1' }), fetchImpl: listing([{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }]) })
  await T.loadWorkspaces()
  assert.equal(T.state.todoForm.workspaceId, 'w1')
})

test('nothing is dropped while the list is unknown: a failed load or an empty list (the app may not have its workspaces yet)', async () => {
  const failing = loadClient({ stored: draft(), fetchImpl: async () => { throw new Error('offline') } })
  await failing.T.loadWorkspaces()
  assert.equal(failing.T.state.todoForm.workspaceId, 'gone')
  const empty = loadClient({ stored: draft(), fetchImpl: listing([]) })
  await empty.T.loadWorkspaces()
  assert.equal(empty.T.state.todoForm.workspaceId, 'gone')
})

test('after the drop the todo is added without a workspace (Choose for me)', async () => {
  const posts = []
  const { T } = loadClient({ stored: draft(), fetchImpl: async (url, opts) => { if (url.endsWith('/v1/workspaces')) return okJson({ workspaces: [{ id: 'w1', title: 'Alpha' }] }); posts.push(JSON.parse(opts.body)); return okJson({ ok: true, id: 'n1', state: 'awaiting-confirm' }) } })
  await T.loadWorkspaces()
  assert.equal(await T.submitTodo(), true)
  assert.deepEqual(posts, [{ text: 'Fix it', sparc: true }])
})
