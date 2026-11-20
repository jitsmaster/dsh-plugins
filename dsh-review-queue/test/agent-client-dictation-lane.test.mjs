import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentClient } from '../agent/client.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { waitFor } from './hub-helpers.mjs'
import { CLEAN_TIMEOUT_MS } from '../follow-up-shared.js'

// dictation-clean (the phone's dictation cleanup: one Haiku call, up to 20 s) has a lane of its own in the agent client: ONE at a time and ONE waiting, so it never holds up the commands in drain() (answer, approve, reply, todo-confirm) and never starts after the hub's 25 s timeout behind a slow command. Fake hub (fetch), fake executor and fake timers: nothing here waits for real time.

const json = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) })
const hang = (signal) => new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) })

function fakeHub() {
  const hub = { results: [], feeds: [], waiter: undefined, snapshots: 0 }
  hub.feed = (...cmds) => { if (hub.waiter) { const w = hub.waiter; hub.waiter = undefined; w(json({ commands: cmds })) } else hub.feeds.push(...cmds) }
  hub.fetch = async (url, init) => {
    const name = new URL(url).pathname.split('/').pop()
    if (name === 'register' || name === 'sync') return json({ ok: true })
    if (name === 'ops') return json({ ok: true, ack: 0, results: [] })
    if (name === 'result') { hub.results.push(JSON.parse(init.body)); return json({ ok: true, accepted: true }) }
    if (name === 'commands') {
      if (hub.feeds.length) return json({ commands: hub.feeds.splice(0) })
      return new Promise((resolve, reject) => { hub.waiter = resolve; init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) })
    }
    if (name === 'workspaces') return json({ workspaces: [] })
    if (name === 'snapshot') return hub.snapshots++ === 0 ? json({ open: [], resolved: [], snapshotId: 's' }) : hang(init.signal)
    return json({ ok: true })
  }
  return hub
}
function fakeExecutor() {
  const ex = { started: [], open: new Map() }
  ex.execute = (cmd) => new Promise((resolve) => { ex.started.push(cmd.cid); ex.open.set(cmd.cid, resolve) })
  ex.settle = (cid, result = { ok: true, sessions: [] }) => ex.open.get(cid)(result)
  return ex
}
function fakeTimers() {
  const t = { list: new Map(), seq: 0 }
  t.setTimeout = (fn, ms) => { const id = ++t.seq; t.list.set(id, { fn, ms }); return id }
  t.clearTimeout = (id) => { t.list.delete(id) }
  t.fire = (ms) => { for (const [id, e] of [...t.list]) if (e.ms <= ms) { t.list.delete(id); e.fn() } }
  return t
}
const cmd = (n, kind) => ({ cid: 'c' + n, seq: n, kind, itemId: 'i' + n, args: {}, deadline: 1_000_000 })
const reported = (hub, cid) => hub.results.find((r) => r.cid === cid)?.result
const later = (ms) => new Promise((r) => setTimeout(r, ms))

async function setup(t, { now = () => 0 } = {}) {
  const hub = fakeHub()
  const executor = fakeExecutor()
  const timers = fakeTimers()
  const client = createAgentClient({ baseUrl: 'http://hub.test', secret: 's', instanceKey: 'k', instanceId: 'aaaa1111', adapter: createStoreAdapter({ instanceId: 'aaaa1111' }), executor, fetch: hub.fetch, backoff: { minMs: 5, maxMs: 10 }, waitMs: 50, now, timers })
  t.after(() => client.stop({ bye: false }))
  client.start()
  await waitFor(() => client.state === 'connected', 3000, 'connected')
  await waitFor(() => hub.waiter !== undefined, 3000, 'the command poll is open')
  return { hub, executor, timers }
}

test('dictation-clean does not wait behind a slow command of the one-at-a-time line, and that line does not wait for it', async (t) => {
  const { hub, executor } = await setup(t)
  hub.feed(cmd(1, 'answer'), cmd(2, 'dictation-clean'), cmd(3, 'approve'))
  await waitFor(() => executor.started.includes('c2'), 3000, 'the cleanup started while the answer is still running')
  assert.deepEqual(executor.started, ['c1', 'c2'], 'the answer runs, the cleanup runs beside it, the approve waits its turn behind the answer only')
  executor.settle('c2', { ok: true, text: 'Clean.' })
  await waitFor(() => reported(hub, 'c2'), 3000, 'the cleanup was reported')
  assert.equal(reported(hub, 'c2').text, 'Clean.')
  assert.equal(reported(hub, 'c1'), undefined, 'the slow answer is still open')
  executor.settle('c1')
  await waitFor(() => executor.started.includes('c3'), 3000, 'the approve follows the answer')
})

test('dictation-clean runs one at a time and one waits; the third is answered busy at once and never run', async (t) => {
  const { hub, executor } = await setup(t)
  hub.feed(cmd(1, 'dictation-clean'), cmd(2, 'dictation-clean'), cmd(3, 'dictation-clean'))
  await waitFor(() => reported(hub, 'c3'), 3000, 'the third was turned away')
  assert.deepEqual(reported(hub, 'c3'), { ok: false, error: 'busy' })
  assert.deepEqual(executor.started, ['c1'], 'only the first runs; one waits')
  executor.settle('c1', { ok: true, text: 'one' })
  await waitFor(() => executor.started.includes('c2'), 3000, 'the waiting one starts when the first is done')
  executor.settle('c2', { ok: true, text: 'two' })
  await waitFor(() => reported(hub, 'c2'), 3000, 'the second was reported')
  assert.equal(executor.started.includes('c3'), false)
})

test('a cleanup keeps its slot until the cleaner own deadline plus a margin (a result at the limit is not dropped), still under the hub timeout', async (t) => {
  const { hub, executor, timers } = await setup(t)
  hub.feed(cmd(1, 'dictation-clean'), cmd(2, 'dictation-clean'))
  await waitFor(() => executor.started.length === 1, 3000, 'first started')
  timers.fire(CLEAN_TIMEOUT_MS)
  await later(60)
  assert.deepEqual(executor.started, ['c1'], 'the slot is not given back at the cleaner deadline')
  executor.settle('c1', { ok: true, text: 'right at the limit' })
  await waitFor(() => reported(hub, 'c1'), 3000, 'the result at the limit was reported')
  assert.equal(reported(hub, 'c1').text, 'right at the limit')
  const t2 = await setup(t)
  t2.hub.feed(cmd(1, 'dictation-clean'), cmd(2, 'dictation-clean'))
  await waitFor(() => t2.executor.started.length === 1, 3000, 'first started')
  t2.timers.fire(CLEAN_TIMEOUT_MS + 3000)
  await waitFor(() => t2.executor.started.includes('c2'), 3000, 'a cleanup that never settles gives its slot back')
  assert.ok(CLEAN_TIMEOUT_MS + 3000 < CLEAN_TIMEOUT_MS + 5000, 'under the hub timeout of the command')
  t2.executor.settle('c1', { ok: true, text: 'late' })
  await later(60)
  assert.equal(reported(t2.hub, 'c1'), undefined, 'the late result is discarded')
})

test('the other lanes are unaffected: thread and sessions-list keep their bounds and their 20 s release beside a full dictation-clean lane', async (t) => {
  const { hub, executor, timers } = await setup(t)
  hub.feed(cmd(1, 'dictation-clean'), cmd(2, 'thread'), cmd(3, 'thread'), cmd(4, 'sessions-list'), cmd(5, 'sessions-list'))
  await waitFor(() => executor.started.includes('c4'), 3000, 'every lane has its read running')
  assert.deepEqual(executor.started, ['c1', 'c2', 'c3', 'c4'])
  timers.fire(20_000)
  await waitFor(() => executor.started.includes('c5'), 3000, 'the 20 s release of the list lane still works')
  assert.equal(executor.started.length, 5)
})

test('a cleanup with less than the cleaner timeout left of its hub window is not started (the hub answers it itself); one with enough left still runs', async (t) => {
  const { hub, executor } = await setup(t)
  hub.feed({ ...cmd(1, 'dictation-clean'), deadline: CLEAN_TIMEOUT_MS - 1 }, { ...cmd(2, 'dictation-clean'), deadline: CLEAN_TIMEOUT_MS })
  await waitFor(() => executor.started.includes('c2'), 3000, 'the one with a full cleaner window left started')
  await later(60)
  assert.deepEqual(executor.started, ['c2'], 'the short one never ran: no paid call whose answer the hub could not use')
  assert.equal(reported(hub, 'c1'), undefined, 'not answered: the hub already answers it at its own timeout')
})

test('a waiting cleanup whose window shrank below the cleaner timeout while it waited is dropped when its turn comes', async (t) => {
  let clock = 0
  const { hub, executor } = await setup(t, { now: () => clock })
  hub.feed({ ...cmd(1, 'dictation-clean'), deadline: 100_000 }, { ...cmd(2, 'dictation-clean'), deadline: 25_000 })
  await waitFor(() => executor.started.length === 1, 3000, 'the first started, the second waits')
  clock = 10_000 // 15 s of the second one's window left: less than the cleaner's 20 s
  executor.settle('c1', { ok: true, text: 'one' })
  await waitFor(() => reported(hub, 'c1'), 3000, 'the first was reported')
  await later(60)
  assert.deepEqual(executor.started, ['c1'], 'the waiting one is not started with too little time left')
})

test('other lanes keep the plain deadline rule: a thread read with a little time left still runs', async (t) => {
  const { hub, executor } = await setup(t)
  hub.feed({ ...cmd(1, 'thread'), deadline: 5_000 })
  await waitFor(() => executor.started.includes('c1'), 3000, 'the thread read started')
})
