import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHubQueue } from '../agent/hub-queue.js'

// The pasted images of the new-todo form: the ids go to the hub with the todo; the upload of the bytes never does.
const IDS = ['11111111-1111-4111-8111-111111111111']
function make(state = 'connected') {
  const calls = []
  const local = {
    calls, onChange: () => () => {}, uiState: () => undefined,
    addTodo: (text, opts) => { calls.push(['local-addTodo', text, opts]); return { ok: true, from: 'local' } },
    saveTodoImage: (bytes) => { calls.push(['local-save', bytes.length]); return { ok: true, id: IDS[0] } },
  }
  const hubCalls = []
  const client = {
    state, calls: hubCalls,
    mirror: { ready: true, snapshot: () => ({ snapshotId: 'e:1', open: [], resolved: [] }), workspaces: () => [], onChange: () => () => {} },
    onState: () => () => {},
    call: async (kind, body) => { hubCalls.push([kind, body]); return { ok: true, from: 'hub' } },
  }
  return { queue: createHubQueue({ local, client, controllerOf: () => ({}), now: () => 5000 }), local, hubCalls }
}

test('connected: addTodo sends the image ids to the hub with the todo', async () => {
  const { queue, hubCalls } = make()
  await queue.addTodo('look', { workspaceId: 'aaaa/w1', images: IDS })
  assert.deepEqual(hubCalls, [['todo', { text: 'look', workspaceId: 'aaaa/w1', images: IDS }]])
})

test('connected: a todo without images has no images key', async () => {
  const { queue, hubCalls } = make()
  await queue.addTodo('look', { workspaceId: 'aaaa/w1' })
  assert.equal('images' in hubCalls[0][1], false)
})

test('not connected: the local service gets the images', async () => {
  const { queue, local } = make('offline')
  await queue.addTodo('look', { images: IDS })
  assert.deepEqual(local.calls[0], ['local-addTodo', 'look', { images: IDS }])
})

test('saveTodoImage is always the local service: the bytes are never sent to the hub', () => {
  const { queue, local, hubCalls } = make()
  assert.deepEqual(queue.saveTodoImage(Buffer.from('abc')), { ok: true, id: IDS[0] })
  assert.deepEqual(local.calls, [['local-save', 3]])
  assert.deepEqual(hubCalls, [])
})
