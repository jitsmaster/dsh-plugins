import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentClient } from '../agent/client.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { waitFor } from './hub-helpers.mjs'

// The thread commands of the agent client are bounded: at most 8 wait for a slot (the next one is answered busy at once), a waiting one whose
// deadline has passed is dropped (the hub answered it itself at its timeout), and a read that never settles gives its slot back after 20 s
// (its late result is discarded). A fake hub (fetch), a fake executor and fake timers: nothing here waits for real time.

const json = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) })
const hang = (signal) => new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) })

/** A hub that accepts the register, hands out the commands given to feed(), records the reported results, and holds every other long poll. */
function fakeHub() {
  const hub = { results: [], feeds: [], waiter: undefined, snapshots: 0 }
  hub.feed = (...cmds) => { if (hub.waiter) { const w = hub.waiter; hub.waiter = undefined; w(json({ commands: cmds })) } else hub.feeds.push(...cmds) }
  hub.fetch = async (url, init) => {
    const path = new URL(url).pathname
    const name = path.split('/').pop()
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

/** An executor whose thread reads stay open until the test settles them by cid. */
function fakeExecutor() {
  const ex = { started: [], open: new Map() }
  ex.execute = (cmd) => new Promise((resolve) => { ex.started.push(cmd.cid); ex.open.set(cmd.cid, resolve) })
  ex.settle = (cid, result = { ok: true, messages: [] }) => ex.open.get(cid)(result)
  return ex
}

/** Timers the test fires by hand. */
function fakeTimers() {
  const t = { list: new Map(), seq: 0 }
  t.setTimeout = (fn, ms) => { const id = ++t.seq; t.list.set(id, { fn, ms }); return id }
  t.clearTimeout = (id) => { t.list.delete(id) }
  t.fire = (ms) => { for (const [id, e] of [...t.list]) if (e.ms <= ms) { t.list.delete(id); e.fn() } }
  return t
}

const cmd = (n, over = {}) => ({ cid: 'c' + n, seq: n, kind: 'thread', itemId: 'i' + n, args: {}, deadline: 1_000_000, ...over })

async function setup(t, { now = () => 0 } = {}) {
  const hub = fakeHub()
  const executor = fakeExecutor()
  const timers = fakeTimers()
  const client = createAgentClient({ baseUrl: 'http://hub.test', secret: 's', instanceKey: 'k', instanceId: 'aaaa1111', adapter: createStoreAdapter({ instanceId: 'aaaa1111' }), executor, fetch: hub.fetch, backoff: { minMs: 5, maxMs: 10 }, waitMs: 50, now, timers })
  t.after(() => client.stop({ bye: false }))
  client.start()
  await waitFor(() => client.state === 'connected', 3000, 'connected')
  await waitFor(() => hub.waiter !== undefined, 3000, 'the command poll is open')
  return { hub, executor, timers, client }
}
const reported = (hub, cid) => hub.results.find((r) => r.cid === cid)?.result
const later = (ms) => new Promise((r) => setTimeout(r, ms))

test('at most 8 thread commands wait for a slot: the next one is answered busy at once and never read', async (t) => {
  const { hub, executor } = await setup(t)
  hub.feed(...Array.from({ length: 11 }, (_, i) => cmd(i + 1)))
  await waitFor(() => reported(hub, 'c11') !== undefined, 3000, 'the eleventh was answered')
  assert.deepEqual(reported(hub, 'c11'), { ok: false, error: 'busy' })
  assert.deepEqual(executor.started, ['c1', 'c2'], 'two reads run, eight wait')
  for (let n = 1; n <= 10; n++) { await waitFor(() => executor.open.has('c' + n), 3000, 'c' + n + ' started'); executor.settle('c' + n) }
  await waitFor(() => hub.results.length === 11, 3000, 'all answered')
  assert.equal(executor.started.length, 10)
  assert.equal(executor.started.includes('c11'), false)
  assert.deepEqual(reported(hub, 'c10'), { ok: true, messages: [] })
})

test('a thread command that has room is not busy: ten at once (2 running, 8 waiting) are all read', async (t) => {
  const { hub, executor } = await setup(t)
  hub.feed(...Array.from({ length: 10 }, (_, i) => cmd(i + 1)))
  for (let n = 1; n <= 10; n++) { await waitFor(() => executor.open.has('c' + n), 3000, 'c' + n + ' started'); executor.settle('c' + n) }
  await waitFor(() => hub.results.length === 10, 3000, 'ten answered')
  assert.equal(hub.results.some((r) => r.result.error === 'busy'), false)
})

test('a waiting thread command whose deadline has passed is dropped without a read and without an answer (the hub answered it at its timeout)', async (t) => {
  let clock = 0
  const { hub, executor } = await setup(t, { now: () => clock })
  hub.feed(cmd(1), cmd(2), cmd(3, { deadline: 500 }), cmd(4, { deadline: 5000 }))
  await waitFor(() => executor.started.length === 2, 3000, 'two reads run')
  clock = 1000 // c3 is late now, c4 is not
  executor.settle('c1')
  await waitFor(() => executor.started.includes('c4'), 3000, 'the slot went to c4, past c3')
  assert.equal(executor.started.includes('c3'), false)
  executor.settle('c2'); executor.settle('c4')
  await waitFor(() => hub.results.length === 3, 3000, 'the others were answered')
  await later(50)
  assert.equal(reported(hub, 'c3'), undefined, 'nothing was reported for the dropped one')
})

test('expired waiting commands do not count against the bound of 8', async (t) => {
  let clock = 0
  const { hub, executor } = await setup(t, { now: () => clock })
  hub.feed(cmd(1), cmd(2), ...Array.from({ length: 8 }, (_, i) => cmd(i + 3, { deadline: 500 })))
  await waitFor(() => executor.started.length === 2, 3000, 'two reads run')
  clock = 1000 // the eight waiting ones are late
  hub.feed(cmd(11))
  await later(100)
  assert.equal(reported(hub, 'c11'), undefined, 'not answered busy: there is room once the late ones are gone')
  executor.settle('c1')
  await waitFor(() => executor.started.includes('c11'), 3000, 'c11 got the free slot')
  assert.deepEqual(executor.started.filter((c) => !['c1', 'c2', 'c11'].includes(c)), [], 'none of the late ones was read')
})

test('a read that never settles gives its slot back after 20 s: the next one starts and the late result is discarded', async (t) => {
  const { hub, executor, timers } = await setup(t)
  hub.feed(cmd(1), cmd(2), cmd(3))
  await waitFor(() => executor.started.length === 2, 3000, 'two reads run, the third waits')
  await later(50)
  assert.equal(executor.started.length, 2)
  assert.deepEqual([...timers.list.values()].map((e) => e.ms), [20_000, 20_000], 'each read has a timer of 20 s')
  timers.fire(20_000)
  await waitFor(() => executor.started.length === 3, 3000, 'the third started in a freed slot')
  executor.settle('c1', { ok: true, messages: [{ id: 1 }] }) // far too late
  executor.settle('c3')
  await waitFor(() => reported(hub, 'c3') !== undefined, 3000, 'the third was answered')
  await later(50)
  assert.equal(reported(hub, 'c1'), undefined, 'the late result is discarded')
  assert.equal(reported(hub, 'c2'), undefined)
})

test('a read that settles in time clears its timer, so no timer is left behind', async (t) => {
  const { hub, executor, timers } = await setup(t)
  hub.feed(cmd(1))
  await waitFor(() => executor.started.length === 1, 3000, 'the read runs')
  assert.equal(timers.list.size, 1)
  executor.settle('c1')
  await waitFor(() => reported(hub, 'c1') !== undefined, 3000, 'answered')
  assert.equal(timers.list.size, 0)
})

test('a slot freed by the timeout is not freed twice when the read settles later', async (t) => {
  const { hub, executor, timers } = await setup(t)
  hub.feed(cmd(1), cmd(2), cmd(3), cmd(4), cmd(5))
  await waitFor(() => executor.started.length === 2, 3000, 'two reads run')
  timers.fire(20_000) // both time out: c3 and c4 start
  await waitFor(() => executor.started.length === 4, 3000, 'c3 and c4 started')
  executor.settle('c1'); executor.settle('c2') // late: must not free two more slots
  await later(100)
  assert.deepEqual(executor.started, ['c1', 'c2', 'c3', 'c4'], 'c5 keeps waiting: only two reads are open')
})
