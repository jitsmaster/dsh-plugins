import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentClient } from '../agent/client.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { waitFor } from './hub-helpers.mjs'

// sessions-list (the follow-up's session list: a controller list plus a few log reads) has a lane of its own in the agent client: ONE at a time and TWO waiting, the next is
// answered busy at once. It is separate from the thread lane (2 reads at a time, 8 waiting), so a burst of follow-ups can neither starve the phone's chat reads nor be
// starved by them. Fake hub (fetch), fake executor and fake timers: nothing here waits for real time.

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

async function setup(t) {
  const hub = fakeHub()
  const executor = fakeExecutor()
  const timers = fakeTimers()
  const client = createAgentClient({ baseUrl: 'http://hub.test', secret: 's', instanceKey: 'k', instanceId: 'aaaa1111', adapter: createStoreAdapter({ instanceId: 'aaaa1111' }), executor, fetch: hub.fetch, backoff: { minMs: 5, maxMs: 10 }, waitMs: 50, now: () => 0, timers })
  t.after(() => client.stop({ bye: false }))
  client.start()
  await waitFor(() => client.state === 'connected', 3000, 'connected')
  await waitFor(() => hub.waiter !== undefined, 3000, 'the command poll is open')
  return { hub, executor, timers }
}

test('sessions-list runs one at a time, two wait, the fourth is answered busy at once and never read', async (t) => {
  const { hub, executor } = await setup(t)
  hub.feed(cmd(1, 'sessions-list'), cmd(2, 'sessions-list'), cmd(3, 'sessions-list'), cmd(4, 'sessions-list'))
  await waitFor(() => reported(hub, 'c4'), 3000, 'the fourth was turned away')
  assert.deepEqual(reported(hub, 'c4'), { ok: false, error: 'busy' })
  assert.deepEqual(executor.started, ['c1'], 'only the first is being read; two wait')
  executor.settle('c1')
  await waitFor(() => executor.started.includes('c2'), 3000, 'the next one starts when the first is done')
  assert.deepEqual(executor.started, ['c1', 'c2'])
  assert.equal(reported(hub, 'c1').ok, true)
  assert.equal(reported(hub, 'c3'), undefined, 'the third still waits')
  executor.settle('c2')
  await waitFor(() => executor.started.includes('c3'), 3000, 'the third starts when the second is done')
  executor.settle('c3')
  await waitFor(() => reported(hub, 'c3'), 3000, 'the third was read')
})

test('the lanes do not starve each other: a full sessions-list lane leaves the thread reads their slots, and a full thread lane leaves sessions-list its slot', async (t) => {
  const { hub, executor } = await setup(t)
  hub.feed(cmd(1, 'sessions-list'), cmd(2, 'sessions-list'), cmd(3, 'sessions-list'), cmd(4, 'thread'), cmd(5, 'thread'))
  await waitFor(() => executor.started.includes('c4') && executor.started.includes('c5'), 3000, 'both thread reads started')
  assert.deepEqual(executor.started, ['c1', 'c4', 'c5'], 'one list and two chat reads at once')
  const b = await setup(t)
  b.hub.feed(...Array.from({ length: 10 }, (_, i) => cmd(i + 1, 'thread')), cmd(11, 'sessions-list'))
  await waitFor(() => b.executor.started.includes('c11'), 3000, 'the list started although every chat slot is taken and eight chat reads wait')
  assert.deepEqual(b.executor.started, ['c1', 'c2', 'c11'])
})

test('a session list that never settles gives its slot back after 20 s, as a thread read does', async (t) => {
  const { hub, executor, timers } = await setup(t)
  hub.feed(cmd(1, 'sessions-list'), cmd(2, 'sessions-list'))
  await waitFor(() => executor.started.length === 1, 3000, 'first started')
  timers.fire(20_000)
  await waitFor(() => executor.started.includes('c2'), 3000, 'the waiting one got the slot')
  executor.settle('c1', { ok: true, sessions: [{ sessionId: 'late' }] })
  await later(60)
  assert.equal(reported(hub, 'c1'), undefined, 'the late result is discarded')
})

test('the thread lane keeps its bounds: two at a time, eight waiting, the eleventh is busy', async (t) => {
  const { hub, executor } = await setup(t)
  hub.feed(...Array.from({ length: 11 }, (_, i) => cmd(i + 1, 'thread')))
  await waitFor(() => reported(hub, 'c11'), 3000, 'the eleventh thread was turned away')
  assert.deepEqual(reported(hub, 'c11'), { ok: false, error: 'busy' })
  assert.deepEqual(executor.started, ['c1', 'c2'])
})
