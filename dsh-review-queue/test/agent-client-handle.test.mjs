import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClientHandle } from '../agent/client-handle.js'

// The handle stands in for the agent client from the first moment (the hub queue and the proxy are wired to it before any hub exists)
// and forwards to the real client once the launcher found a hub.
function fakeReal() {
  const stateL = new Set()
  const mirrorL = new Set()
  const r = {
    state: 'stopped', started: 0, stopped: [], calls: [],
    mirror: { ready: false, snap: undefined, ws: [], snapshot: () => r.mirror.snap, workspaces: () => r.mirror.ws, onChange: (l) => { mirrorL.add(l); return () => mirrorL.delete(l) } },
    onState: (l) => { stateL.add(l); return () => stateL.delete(l) },
    start() { r.started++; r.setState('connecting') },
    async stop(opts) { r.stopped.push(opts); r.setState('stopped') },
    async call(kind, body) { r.calls.push([kind, body]); return { ok: true } },
    setState(s) { r.state = s; stateL.forEach((l) => l(s)) },
    setMirror(snap) { r.mirror.ready = true; r.mirror.snap = snap; mirrorL.forEach((l) => l()) },
    listeners: () => stateL.size + mirrorL.size,
  }
  return r
}

test('before a client is attached it is stopped, has no mirror and refuses calls without throwing', async () => {
  const h = createClientHandle({ instanceId: 'abcd1234' })
  assert.equal(h.instanceId, 'abcd1234')
  assert.equal(h.state, 'stopped')
  assert.deepEqual([h.mirror.ready, h.mirror.snapshot(), h.mirror.workspaces()], [false, undefined, []])
  assert.deepEqual(await h.call('approve', { id: 'x' }), { ok: false, error: 'hub-unreachable' })
  h.start()
  await h.stop()
  assert.equal(h.attached, false)
})

test('listeners added before the client exists hear its state and its mirror afterwards', () => {
  const h = createClientHandle({ instanceId: 'abcd1234' })
  const heard = []
  h.onState((s) => heard.push('state:' + s))
  h.mirror.onChange(() => heard.push('mirror'))
  const real = fakeReal()
  h.attach(real)
  h.start()
  real.setMirror({ snapshotId: 'e:1', open: [], resolved: [] })
  assert.equal(real.started, 1)
  assert.deepEqual(heard, ['state:connecting', 'mirror'])
  assert.deepEqual([h.state, h.mirror.ready, h.mirror.snapshot().snapshotId], ['connecting', true, 'e:1'])
})

test('calls and stop go to the real client; a removed listener hears nothing', async () => {
  const h = createClientHandle({ instanceId: 'abcd1234' })
  const real = fakeReal()
  h.attach(real)
  let n = 0
  const off = h.onState(() => n++)
  assert.deepEqual(await h.call('deny', { id: 'a' }), { ok: true })
  assert.deepEqual(real.calls, [['deny', { id: 'a' }]])
  real.setState('connected')
  off()
  real.setState('degraded')
  assert.equal(n, 1)
  await h.stop({ bye: false })
  assert.deepEqual(real.stopped, [{ bye: false }])
})

test('attaching a second client retires the first one without a goodbye and moves the listeners over', () => {
  const h = createClientHandle({ instanceId: 'abcd1234' })
  const first = fakeReal()
  const second = fakeReal()
  h.attach(first)
  const heard = []
  h.onState((s) => heard.push(s))
  h.attach(second)
  assert.deepEqual(first.stopped, [{ bye: false }])
  assert.equal(first.listeners(), 0, 'nothing is left subscribed to the old client')
  first.setState('connected')
  second.setState('connected')
  assert.deepEqual(heard.filter((s) => s === 'connected'), ['connected'])
  assert.equal(h.real, second)
})

test('syncWorkspaces goes to the real client; before one is attached it answers and does nothing', async () => {
  const h = createClientHandle({ instanceId: 'abcd1234' })
  await h.syncWorkspaces()
  const real = fakeReal()
  real.syncWorkspaces = async () => { real.synced = (real.synced ?? 0) + 1 }
  h.attach(real)
  await h.syncWorkspaces()
  assert.equal(real.synced, 1)
})
