import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentClient } from '../agent/client.js'
import { createExecutor } from '../agent/executor.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { waitFor } from './hub-helpers.mjs'
import { SECRET, startHub } from './hub-agent-helpers.mjs'
import { act } from './hub-follow-up-helpers.mjs'

// sessions-list is a slow read like thread: the agent client runs it beside the serial command line, so listing the sessions (a controller list and a
// few log reads) never holds up an approve queued behind it, and an approve in progress never holds up the follow-up.

const FAST = { backoff: { minMs: 10, maxMs: 40 }, waitMs: 400 }
const later = (ms) => new Promise((r) => setTimeout(r, ms))
const BLOCKED = Symbol('blocked')
const within = (promise, ms) => Promise.race([promise, later(ms).then(() => BLOCKED)])
const permission = () => ({ type: 'permission', sessionId: 's1', payload: { toolName: 'shell', summary: 'ls', detail: 'ls' } })

function setup(t, port, { approveMs = 0, clock }) {
  const adapter = createStoreAdapter({ instanceId: 'aaaa1111' })
  const calls = []
  const gate = { started: 0, release: undefined, wait: undefined }
  gate.wait = new Promise((r) => { gate.release = r })
  const queue = {
    approve: async (itemId) => { if (approveMs) await later(approveMs); calls.push(['approve', itemId]); adapter.resolve(itemId, { kind: 'approved', by: 'card' }); return { ok: true } },
    followUpSessions: async () => { gate.started++; await gate.wait; return [{ sessionId: 's9', title: 'Nine', updatedAt: 9 }] },
    addTodo: (text, opts) => { calls.push(['addTodo', text, opts]); return { ok: true, id: 'aaaa-000000000001', state: 'awaiting-confirm' } },
  }
  const client = createAgentClient({ baseUrl: 'http://127.0.0.1:' + port, secret: SECRET, instanceKey: 'k1', instanceId: 'aaaa1111', label: 'DSH :1', adapter, executor: createExecutor({ queue, adapter }), now: clock.now, ...FAST })
  t.after(() => { gate.release(); return client.stop({ bye: false }) })
  return { client, adapter, calls, gate }
}
const connected = (client) => waitFor(() => client.state === 'connected', 8000, 'connected')

test('an approve queued behind a slow session list is answered while the list is still being read', async (t) => {
  const { port, clock } = await startHub(t)
  const { client, adapter, calls, gate } = setup(t, port, { clock })
  const item = adapter.add(permission())
  client.start()
  await connected(client)
  const todo = act(port, 'todo', { text: 'also null', followUp: 'the review' }, { 'x-rq-instance': 'aaaa1111' })
  await waitFor(() => gate.started === 1, 5000, 'the list was asked for')
  const approved = await within(act(port, 'approve', { id: item.id }), 2500)
  assert.notEqual(approved, BLOCKED, 'the approve was not held up by the list')
  assert.deepEqual([approved.status, approved.json], [200, { ok: true }])
  assert.deepEqual(calls, [['approve', item.id]])
  gate.release()
  const added = await todo
  assert.deepEqual([added.status, added.json.state], [200, 'awaiting-confirm'])
  assert.deepEqual(calls.at(-1), ['addTodo', 'also null', { followUp: 'the review', sessions: [{ sessionId: 's9', title: 'Nine', updatedAt: 9, owner: 'aaaa1111' }] }])
})

test('a session list that arrives while a slow approve runs does not wait for it', async (t) => {
  const { port, clock } = await startHub(t)
  const { client, adapter, gate } = setup(t, port, { approveMs: 1500, clock })
  const item = adapter.add(permission())
  client.start()
  await connected(client)
  const approved = act(port, 'approve', { id: item.id })
  const todo = act(port, 'todo', { text: 'x', followUp: 'words' }, { 'x-rq-instance': 'aaaa1111' })
  await waitFor(() => gate.started === 1, 1000, 'the list started without waiting for the approve')
  gate.release()
  assert.equal((await approved).status, 200)
  assert.equal((await todo).status, 200)
})
