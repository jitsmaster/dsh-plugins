import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentClient } from '../agent/client.js'
import { createExecutor } from '../agent/executor.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { postJson, waitFor } from './hub-helpers.mjs'
import { P, SECRET, startHub } from './hub-agent-helpers.mjs'

// The agent client runs hub commands one at a time (the drain loop), but a thread command is a slow read: it must neither block the commands
// behind it nor wait behind them. Thread commands run beside the drain, at most 2 at once; the others wait their turn among thread commands only.

const item = (over = {}) => ({ type: 'permission', sessionId: 's1', payload: { toolName: 'shell', summary: 'ls', detail: 'ls' }, ...over })
const FAST = { backoff: { minMs: 10, maxMs: 40 }, waitMs: 400 }
const act = (port, kind, body) => postJson(port, P + '/v1/' + kind, body)
const later = (ms) => new Promise((r) => setTimeout(r, ms))
const BLOCKED = Symbol('blocked')
const within = (promise, ms) => Promise.race([promise, later(ms).then(() => BLOCKED)])

/** A real client and adapter; the executor's thread handler is a fake the test holds open, every other kind runs in the real executor. */
function setup(t, port, { approveMs = 0, clock } = {}) {
  const adapter = createStoreAdapter({ instanceId: 'aaaa1111' })
  const calls = []
  const queue = {
    approve: async (itemId) => { if (approveMs) await later(approveMs); calls.push(['approve', itemId]); adapter.resolve(itemId, { kind: 'approved', by: 'card' }); return { ok: true } },
    reply: async (itemId, text) => { calls.push(['reply', itemId, text]); return { ok: true } },
  }
  const real = createExecutor({ queue, adapter })
  const gate = { open: false, started: [], running: 0, peak: 0, release: undefined, wait: undefined }
  gate.wait = new Promise((r) => { gate.release = () => { gate.open = true; r() } })
  const executor = {
    async execute(cmd) {
      if (cmd.kind !== 'thread') return real.execute(cmd)
      gate.started.push(cmd.itemId + ':' + (cmd.args.limit ?? ''))
      gate.running++
      gate.peak = Math.max(gate.peak, gate.running)
      try { await gate.wait } finally { gate.running-- }
      return { ok: true, sessionId: 's1', title: 'T', messages: [], hasMore: false }
    },
  }
  const client = createAgentClient({ baseUrl: 'http://127.0.0.1:' + port, secret: SECRET, instanceKey: 'k1', instanceId: 'aaaa1111', label: 'DSH :1', adapter, executor, now: clock.now, ...FAST }) // the hub's fake clock sets the deadline of a command
  t.after(() => { gate.release(); return client.stop({ bye: false }) })
  return { client, adapter, calls, gate }
}
const connected = (client) => waitFor(() => client.state === 'connected', 8000, 'connected')

test('an approve queued behind a slow thread read is answered while the read is still running', async (t) => {
  const { port, clock } = await startHub(t)
  const { client, adapter, calls, gate } = setup(t, port, { clock })
  const permission = adapter.add(item())
  const done = adapter.add(item({ type: 'completed', payload: { reply: 'r' }, sessionId: 's2' }))
  client.start()
  await connected(client)
  const thread = act(port, 'thread', { id: done.id })
  await waitFor(() => gate.started.length === 1, 5000, 'the thread read started')
  const approved = await within(act(port, 'approve', { id: permission.id }), 2500)
  assert.notEqual(approved, BLOCKED, 'the approve was not held up by the thread read')
  assert.deepEqual([approved.status, approved.json], [200, { ok: true }])
  assert.deepEqual(calls, [['approve', permission.id]])
  assert.equal(gate.running, 1, 'the read is still running')
  gate.release()
  const answer = await thread
  assert.deepEqual([answer.status, answer.json.ok, answer.json.sessionId], [200, true, 's1'], 'its result is reported to the hub like any other')
})

test('a thread command that arrives while a slow approve runs does not wait for it', async (t) => {
  const { port, clock } = await startHub(t)
  const { client, adapter, gate } = setup(t, port, { approveMs: 1500, clock })
  const permission = adapter.add(item())
  const done = adapter.add(item({ type: 'completed', payload: { reply: 'r' }, sessionId: 's2' }))
  client.start()
  await connected(client)
  const approved = act(port, 'approve', { id: permission.id })
  const thread = act(port, 'thread', { id: done.id })
  await waitFor(() => gate.started.length === 1, 1000, 'the thread read started without waiting for the drain')
  gate.release()
  assert.equal((await approved).status, 200)
  assert.equal((await thread).status, 200)
})

test('at most 2 thread reads are in flight; the third waits for a free slot and an approve is not queued behind them', async (t) => {
  const { port, clock } = await startHub(t)
  const { client, adapter, calls, gate } = setup(t, port, { clock })
  const permission = adapter.add(item())
  const done = adapter.add(item({ type: 'completed', payload: { reply: 'r' }, sessionId: 's2' }))
  client.start()
  await connected(client)
  const reads = [1, 2, 3].map((limit) => act(port, 'thread', { id: done.id, limit }))
  await waitFor(() => gate.started.length === 2, 5000, 'two reads started')
  await later(300)
  assert.deepEqual([gate.started.length, gate.running, gate.peak], [2, 2, 2], 'the third read waits')
  const approved = await within(act(port, 'approve', { id: permission.id }), 2500)
  assert.notEqual(approved, BLOCKED, 'the approve does not wait behind the queued reads')
  assert.equal(approved.status, 200)
  assert.deepEqual(calls, [['approve', permission.id]])
  gate.release()
  const answers = await Promise.all(reads)
  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200])
  assert.equal(gate.started.length, 3)
  assert.equal(gate.peak, 2, 'never more than 2 at once')
})

test('the other commands keep their order and are acknowledged one at a time while a thread read is open', async (t) => {
  const { port, clock } = await startHub(t)
  const { client, adapter, calls, gate } = setup(t, port, { clock })
  const a = adapter.add(item())
  const b = adapter.add(item({ sessionId: 's3' }))
  const done = adapter.add(item({ type: 'completed', payload: { reply: 'r' }, sessionId: 's2' }))
  client.start()
  await connected(client)
  const thread = act(port, 'thread', { id: done.id })
  await waitFor(() => gate.started.length === 1, 5000, 'the thread read started')
  const first = act(port, 'approve', { id: a.id })
  const second = act(port, 'approve', { id: b.id })
  const reply = act(port, 'reply', { id: done.id, text: 'hi' })
  assert.deepEqual((await Promise.all([first, second, reply])).map((r) => r.status), [200, 200, 200])
  assert.deepEqual(calls.map((c) => c[0] + ':' + (c[2] ?? '')), ['approve:', 'approve:', 'reply:hi'])
  assert.deepEqual(calls.slice(0, 2).map((c) => c[1]), [a.id, b.id])
  assert.equal(adapter.get(a.id).status, 'resolved')
  gate.release()
  await thread
})
