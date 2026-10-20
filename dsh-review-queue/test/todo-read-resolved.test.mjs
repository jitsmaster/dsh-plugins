import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createHubQueue } from '../agent/hub-queue.js'

// A resolved todo (started or cancelled) can still be read aloud by id, and reading it is not cut off because it is no longer open.
function standalone() {
  let t = 1000
  const store = createStore({ now: () => ++t })
  const spoken = []
  const ends = []
  const speaker = { speak: (chunks, opts) => { spoken.push(chunks); ends.push(opts?.onEnd); return { ok: true } }, stop() {} }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => undefined, registryOf: () => ({ list: () => [{ id: 'w1', title: 'dsh-plugins' }] }), speaker, now: () => 5000 })
  return { store, queue, spoken, ends }
}

test('standalone: reading a cancelled todo speaks its text and keeps reading', async () => {
  const { queue, spoken } = standalone()
  const added = await queue.addTodo('Fix the login redirect in dsh-plugins')
  assert.equal(queue.cancelTodo(added.id).ok, true)
  assert.equal(queue.snapshot().resolved.some((i) => i.id === added.id), true)
  assert.deepEqual(queue.read(added.id), { ok: true })
  assert.match(spoken[0].join(' '), /Fix the login redirect/)
  assert.equal(queue.snapshot().reading, added.id)
})

test('hub mode: a resolved todo of the mirror is read like any item', () => {
  const spoken = []
  const listeners = new Set()
  const client = { state: 'connected', mirror: { ready: true, snap: undefined, snapshot: () => client.mirror.snap, workspaces: () => [], onChange: (l) => { listeners.add(l); return () => listeners.delete(l) } }, onState: () => () => {}, call: async () => ({ ok: true }) }
  const local = { onChange: () => () => {}, stopTip() {}, uiState: () => undefined }
  const speaker = { speak: (chunks) => { spoken.push(chunks); return { ok: true } }, stop() {} }
  const queue = createHubQueue({ local, client, speaker, controllerOf: () => ({}), now: () => 5000 })
  const todo = { id: 't1', seq: 1, type: 'todo', status: 'resolved', createdAt: 100, resolvedAt: 200, text: 'Fix the login redirect', sparc: false, state: 'started', workspaceTitle: 'dsh-plugins', sessionId: 's1', resolution: { kind: 'started' } }
  client.mirror.snap = { snapshotId: 'e:1', open: [], resolved: [todo] }
  assert.deepEqual(queue.read('t1'), { ok: true })
  assert.match(spoken[0].join(' '), /Todo: Fix the login redirect, started in dsh-plugins\./)
  assert.equal(queue.snapshot().reading, 't1')
})
