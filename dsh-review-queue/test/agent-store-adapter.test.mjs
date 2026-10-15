import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createStoreAdapter } from '../agent/store-adapter.js'

function make(over = {}) {
  const file = { text: undefined, writes: 0 }
  const io = { read: () => file.text, write: (text) => { file.text = text; file.writes++ } }
  let t = 1000
  let n = 0
  const adapter = createStoreAdapter({ instanceId: 'aaaa1111', io, now: () => ++t, randomHex: () => String(++n).padStart(12, '0'), ...over })
  return { adapter, file, io, reopen: (o = {}) => createStoreAdapter({ instanceId: 'aaaa1111', io, now: () => ++t, randomHex: () => String(++n + 500).padStart(12, '0'), ...o }) }
}
const item = (over = {}) => ({ type: 'completed', sessionId: 's1', payload: { reply: 'r' }, ...over })
const ops = (a) => a.outbox().map(({ n, ...op }) => ({ n, ...op }))

test('an added item has an id <instance short>-<12 hex>, and the op carries the item', () => {
  const { adapter } = make()
  const added = adapter.add(item())
  assert.match(added.id, /^aaaa-[0-9a-f]{12}$/)
  assert.deepEqual(adapter.get(added.id), added)
  const [op] = ops(adapter)
  assert.deepEqual([op.n, op.op, op.item.id, op.item.type, op.item.createdAt], [1, 'add', added.id, 'completed', added.createdAt])
  assert.equal(adapter.n, 1)
})

test('the adapter answers like store.js for the same sequence of calls', () => {
  const run = (store) => {
    const a = store.add(item({ sessionId: 's1' })); const b = store.add(item({ sessionId: 's2' })); const c = store.add(item({ sessionId: 's2', type: 'question', key: 'k' })); const d = store.add(item({ sessionId: 's3' }))
    store.update(a.id, { summary: 'x' })
    store.resolve(b.id, { kind: 'reviewed' })
    store.resolve(b.id, { kind: 'again' })
    store.reopen(b.id)
    store.resolveSession('s2', { kind: 'session-ended' })
    store.reconcile(new Set(['s1']))
    const found = store.findOpen({ type: 'completed', sessionId: 's1' })?.id === a.id
    const snap = store.snapshot()
    return { found, open: snap.open.map((i) => [i.type, i.sessionId, i.position, i.summary]), resolved: snap.resolved.map((i) => [i.type, i.sessionId, i.resolution]), list: store.list({ status: 'open' }).length, c: store.get(c.id).status, d: store.get(d.id).status }
  }
  assert.deepEqual(run(make().adapter), run(createStore({ now: (() => { let t = 1000; return () => ++t })() })))
})

test('an update records only the defined fields and lists the undefined ones as unset', () => {
  const { adapter } = make()
  const a = adapter.add(item())
  adapter.update(a.id, { state: 'failed', error: undefined, n: 3 })
  adapter.update(a.id, { summary: 'only this' })
  assert.deepEqual(ops(adapter).slice(1), [
    { n: 2, op: 'update', id: a.id, patch: { state: 'failed', n: 3 }, unset: ['error'] },
    { n: 3, op: 'update', id: a.id, patch: { summary: 'only this' } },
  ])
  assert.equal(adapter.update('nope', { x: 1 }), false)
  assert.equal(adapter.n, 3)
})

test('resolve, reopen and resolveSession record one op each, and a call that changed nothing records nothing', () => {
  const { adapter } = make()
  const a = adapter.add(item({ sessionId: 'sA' }))
  adapter.add(item({ sessionId: 'sB' }))
  assert.equal(adapter.resolve(a.id, { kind: 'reviewed', by: 'card' }), true)
  assert.equal(adapter.resolve(a.id, { kind: 'late' }), false)
  assert.equal(adapter.reopen(a.id), true)
  assert.equal(adapter.reopen(a.id), false)
  assert.equal(adapter.resolveSession('sB', { kind: 'session-ended' }), true)
  assert.equal(adapter.resolveSession('sB', { kind: 'session-ended' }), false)
  assert.deepEqual(ops(adapter).slice(2).map(({ n, ...op }) => op), [
    { op: 'resolve', id: a.id, resolution: { kind: 'reviewed', by: 'card' } },
    { op: 'reopen', id: a.id },
    { op: 'resolveSession', sessionId: 'sB', resolution: { kind: 'session-ended' } },
  ])
})

test('reconcile resolves what is not live and records a resolve op for each item it ended', () => {
  const { adapter } = make()
  const a = adapter.add(item({ sessionId: 'live' }))
  const b = adapter.add(item({ sessionId: 'dead' }))
  assert.equal(adapter.reconcile(new Set(['live'])), true)
  assert.deepEqual([adapter.get(a.id).status, adapter.get(b.id).status], ['open', 'resolved'])
  assert.deepEqual(ops(adapter).slice(2), [{ n: 3, op: 'resolve', id: b.id, resolution: { kind: 'session-ended' } }])
})

test('retitle renames the session on the local items and records one op', () => {
  const { adapter } = make()
  const a = adapter.add(item({ sessionId: 's1', sessionTitle: 'old' }))
  adapter.add(item({ sessionId: 's2', sessionTitle: 'other' }))
  adapter.retitle('s1', 'new')
  assert.equal(adapter.get(a.id).sessionTitle, 'new')
  assert.deepEqual(ops(adapter).slice(2), [{ n: 3, op: 'retitle', sessionId: 's1', title: 'new' }])
})

test('the file keeps items, the op counter and the outbox, so a restart loses neither', () => {
  const { adapter, file, reopen } = make()
  const a = adapter.add(item())
  adapter.add(item({ sessionId: 's2' }))
  adapter.ack(1)
  const saved = JSON.parse(file.text)
  assert.deepEqual([saved.v, saved.items.length, saved.agent.n, saved.agent.outbox.map((o) => o.n)], [1, 2, 2, [2]])
  const again = reopen()
  assert.deepEqual(again.get(a.id), adapter.get(a.id))
  assert.equal(again.n, 2)
  assert.deepEqual(again.outbox().map((o) => o.n), [2])
  again.add(item())
  assert.equal(again.n, 3, 'the counter goes on')
})

test('ack drops what the hub applied, synced drops everything up to the sync and clears the resync flag', () => {
  const { adapter } = make({ maxOutbox: 3 })
  for (let i = 0; i < 3; i++) adapter.add(item({ sessionId: 's' + i }))
  adapter.ack(2)
  assert.deepEqual(adapter.outbox().map((o) => o.n), [3])
  for (let i = 0; i < 3; i++) adapter.add(item({ sessionId: 'x' + i }))
  assert.equal(adapter.needsResync, true, 'more ops than the outbox keeps: only a full sync can follow')
  assert.deepEqual(adapter.outbox(), [])
  assert.equal(adapter.n, 6)
  adapter.add(item())
  assert.deepEqual(adapter.outbox().map((o) => o.n), [7])
  adapter.synced(7)
  assert.equal(adapter.needsResync, false)
  assert.deepEqual(adapter.outbox(), [])
})

test('onOp tells the client about every recorded op, onChange tells the service about every change', () => {
  const { adapter } = make()
  const seen = []
  const changes = []
  const off = adapter.onOp((op) => seen.push(op.op))
  adapter.onChange(() => changes.push(1))
  const a = adapter.add(item())
  adapter.update(a.id, { summary: 's' })
  adapter.resolve(a.id, { kind: 'reviewed' })
  assert.deepEqual(seen, ['add', 'update', 'resolve'])
  assert.equal(changes.length, 3)
  off()
  adapter.reopen(a.id)
  assert.equal(seen.length, 3)
})

test('changes of the hub are applied without recording an op: resolve, reopen and drop', () => {
  const { adapter } = make()
  const a = adapter.add(item())
  const b = adapter.add(item({ sessionId: 's2' }))
  const before = adapter.n
  let changes = 0
  adapter.onChange(() => changes++)
  assert.deepEqual(adapter.applyRemote({ op: 'resolve', id: a.id, resolution: { kind: 'reviewed', by: 'card' } }), { ok: true })
  assert.deepEqual(adapter.get(a.id).resolution, { kind: 'reviewed', by: 'card' })
  assert.deepEqual(adapter.applyRemote({ op: 'reopen', id: a.id }), { ok: true })
  assert.equal(adapter.get(a.id).status, 'open')
  assert.deepEqual(adapter.applyRemote({ op: 'drop', id: b.id }), { ok: true })
  assert.equal(adapter.get(b.id), undefined)
  assert.equal(adapter.list().length, 1)
  assert.deepEqual(adapter.applyRemote({ op: 'explode' }), { ok: false, error: 'bad-change' })
  assert.equal(adapter.n, before)
  assert.equal(adapter.outbox().length, before)
  assert.equal(changes, 3)
})

test('an item moved here by the hub is adopted under its own id, open, with no op', () => {
  const { adapter } = make()
  const moved = { id: 'bbbb-000000000009', type: 'todo', text: 'fix', state: 'awaiting-confirm', createdAt: 77, owner: 'bbbb2222', seq: 3, status: 'open' }
  assert.deepEqual(adapter.adopt(moved), { ok: true })
  const got = adapter.get(moved.id)
  assert.deepEqual([got.type, got.text, got.state, got.createdAt, got.status, got.owner], ['todo', 'fix', 'awaiting-confirm', 77, 'open', undefined])
  assert.equal(adapter.n, 0)
  assert.deepEqual(adapter.adopt(moved), { ok: true, existing: true })
})

test('the sync payload is the owner view: open items, recent resolved ones, the sessions of the open ones and the counter', () => {
  const { adapter } = make()
  const a = adapter.add(item({ sessionId: 'sA' }))
  const b = adapter.add(item({ sessionId: 'sB' }))
  adapter.add(item({ sessionId: 'sA' }))
  adapter.resolve(b.id, { kind: 'reviewed' })
  const s = adapter.syncPayload({ maxResolved: 5 })
  assert.deepEqual([s.n, s.openItems.length, s.resolvedItems.map((i) => i.id), s.sessionIds.sort()], [3 + 1, 2, [b.id], ['sA']])
  assert.equal(s.openItems.find((i) => i.id === a.id).status, 'open')
  assert.equal(adapter.syncPayload({ maxResolved: 0 }).resolvedItems.length, 0)
})

test('with no file of its own the legacy shared queue is read once, read only, so nothing seems to vanish', () => {
  const legacy = JSON.stringify({ v: 1, seq: 4, items: [{ id: 'old1', seq: 4, type: 'completed', status: 'open', createdAt: 5, sessionId: 'sO', payload: {} }] })
  const { adapter, file } = make({ legacyRead: () => legacy })
  assert.equal(adapter.get('old1').status, 'open')
  assert.equal(adapter.n, 0)
  adapter.add(item())
  assert.equal(JSON.parse(file.text).items.length, 2)
  const own = make({ legacyRead: () => legacy })
  own.file.text = JSON.stringify({ v: 1, seq: 0, items: [] })
  assert.equal(own.reopen({ legacyRead: () => legacy }).get('old1'), undefined)
})

test('a missing or corrupt file starts empty and never throws', () => {
  const { adapter, file, reopen } = make()
  file.text = '{nope'
  assert.deepEqual(reopen().list(), [])
  const broken = createStoreAdapter({ instanceId: 'aaaa1111', io: { read: () => { throw new Error('x') }, write: () => { throw new Error('disk full') } } })
  assert.equal(broken.add(item()).type, 'completed')
  void adapter
})
