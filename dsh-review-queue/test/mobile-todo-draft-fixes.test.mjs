import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { emptyTodoDraft, dropStaleWorkspace, TODO_DRAFT_KEY } from '../lib/mobile/todo-form.js'

// The phone's restored draft with a workspace that is not in the loaded list loses that id; clearTodoDraft writes the saved draft once.
test('dropStaleWorkspace: an id missing from a non-empty list is dropped, everything else is untouched', () => {
  const draft = { text: 'Fix it', workspaceId: 'gone', sparc: true }
  const list = [{ id: 'w1', title: 'A' }]
  assert.deepEqual(dropStaleWorkspace(draft, list), { text: 'Fix it', workspaceId: '', sparc: true })
  assert.equal(draft.workspaceId, 'gone', 'the draft is not mutated')
  const known = { text: 'x', workspaceId: 'w1', sparc: false }
  assert.equal(dropStaleWorkspace(known, list), known, 'a known id returns the same object (no needless save)')
  for (const unknown of [null, undefined, [], 'nope']) assert.equal(dropStaleWorkspace(draft, unknown), draft, String(unknown))
  const none = { text: 'x', workspaceId: '', sparc: false }
  assert.equal(dropStaleWorkspace(none, list), none)
})

globalThis.location = { pathname: '/review-queue/m/' }
const disk = new Map()
const writes = []
globalThis.localStorage = { getItem: (k) => (disk.has(k) ? disk.get(k) : null), setItem: (k, v) => { writes.push([k, String(v)]); disk.set(k, String(v)) }, removeItem: (k) => { disk.delete(k) } }
const api = await import('../lib/mobile/api.js')
let replies
beforeEach(() => {
  disk.clear(); writes.length = 0
  replies = []
  globalThis.fetch = async () => { const r = replies.shift() ?? { status: 200, body: { workspaces: [] } }; return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.body } }
})
const onDisk = () => JSON.parse(disk.get(TODO_DRAFT_KEY))

test('loadWorkspaces drops a restored workspace id the list lacks, in state and on disk', async () => {
  api.set({ todoDraft: { text: 'Fix it', workspaceId: 'gone', sparc: true } })
  replies.push({ status: 200, body: { workspaces: [{ id: 'w1', title: 'A' }] } })
  await api.loadWorkspaces()
  assert.deepEqual({ ...api.state.todoDraft }, { text: 'Fix it', workspaceId: '', sparc: true })
  assert.deepEqual(onDisk(), { text: 'Fix it', workspaceId: '', sparc: true })
  assert.equal(api.state.workspaces.length, 1)
})

test('loadWorkspaces keeps a known id, and keeps the id when the list is empty or the load failed', async () => {
  api.set({ todoDraft: { text: 'x', workspaceId: 'w1', sparc: false } })
  replies.push({ status: 200, body: { workspaces: [{ id: 'w1', title: 'A' }] } })
  await api.loadWorkspaces()
  assert.equal(api.state.todoDraft.workspaceId, 'w1')
  replies.push({ status: 200, body: { workspaces: [] } })
  await api.loadWorkspaces()
  assert.equal(api.state.todoDraft.workspaceId, 'w1')
  replies.push({ status: 500, body: {} })
  await api.loadWorkspaces()
  assert.equal(api.state.todoDraft.workspaceId, 'w1')
})

test('clearTodoDraft saves the empty draft once, and the result on disk is the empty draft', () => {
  api.set({ todoDraft: { text: 'Start this', workspaceId: 'w1', sparc: true } })
  writes.length = 0
  api.clearTodoDraft()
  assert.equal(writes.filter(([k]) => k === TODO_DRAFT_KEY).length, 1, 'one write, not two')
  assert.deepEqual(onDisk(), emptyTodoDraft())
  assert.deepEqual({ ...api.state.todoDraft }, emptyTodoDraft())
})
