import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'

const DAY = 24 * 3600 * 1000
function make(extra = {}) {
  let t = 1_000_000
  let n = 0
  const store = createStore({ now: () => t, uuid: () => 'id' + ++n, ...extra })
  return { store, tick: (ms = 1000) => { t += ms; return t } }
}
const q = (over = {}) => ({ type: 'question', sessionId: 's1', sessionTitle: 'One', payload: { questions: [] }, ...over })

test('add assigns id, open status and creation time; list is time ascending (oldest first)', () => {
  const { store, tick } = make()
  const a = store.add(q({ sessionId: 'a' }))
  tick()
  const b = store.add({ type: 'completed', sessionId: 'b', sessionTitle: 'Two', payload: { reply: 'done' } })
  assert.equal(a.status, 'open')
  assert.ok(a.id && b.id && a.id !== b.id)
  assert.deepEqual(store.list().map((i) => i.sessionId), ['a', 'b'])
})

test('items with the same timestamp keep insertion order', () => {
  const { store } = make()
  store.add(q({ sessionId: 'a' })); store.add(q({ sessionId: 'b' })); store.add(q({ sessionId: 'c' }))
  assert.deepEqual(store.list().map((i) => i.sessionId), ['a', 'b', 'c'])
})

test('snapshot numbers open items by position, oldest = 1, and lists resolved separately', () => {
  const { store, tick } = make()
  const a = store.add(q({ sessionId: 'a' })); tick()
  store.add(q({ sessionId: 'b' })); tick()
  store.resolve(a.id, { kind: 'answered' })
  const snap = store.snapshot()
  assert.deepEqual(snap.open.map((i) => [i.position, i.sessionId]), [[1, 'b']])
  assert.deepEqual(snap.resolved.map((i) => i.sessionId), ['a'])
  assert.equal(snap.resolved[0].resolution.kind, 'answered')
})

test('resolve is once-only and unknown ids are refused', () => {
  const { store } = make()
  const a = store.add(q())
  assert.equal(store.resolve(a.id, { kind: 'answered' }), true)
  assert.equal(store.resolve(a.id, { kind: 'expired' }), false)
  assert.equal(store.get(a.id).resolution.kind, 'answered')
  assert.equal(store.resolve('nope', { kind: 'answered' }), false)
})

test('snapshotId changes on every mutation and isCurrent tells stale ids', () => {
  const { store } = make()
  const s0 = store.snapshot().snapshotId
  const a = store.add(q())
  const s1 = store.snapshot().snapshotId
  assert.notEqual(s0, s1)
  assert.equal(store.isCurrent(s1), true)
  store.resolve(a.id, { kind: 'answered' })
  assert.equal(store.isCurrent(s1), false)
})

test('update patches an open item (summary arrives later) and notifies', () => {
  const { store } = make()
  const calls = []
  store.onChange(() => calls.push(1))
  const a = store.add({ type: 'completed', sessionId: 's', payload: { reply: 'x' } })
  store.update(a.id, { summary: 'Did X.' })
  assert.equal(store.get(a.id).summary, 'Did X.')
  assert.equal(calls.length, 2)
  assert.equal(store.update('nope', { summary: 'y' }), false)
})

test('onChange can be unsubscribed and a throwing listener does not break others', () => {
  const { store } = make()
  let n = 0
  const off = store.onChange(() => { throw new Error('boom') })
  store.onChange(() => { n++ })
  store.add(q())
  assert.equal(n, 1)
  off()
  store.add(q())
  assert.equal(n, 2)
})

test('resolved items are pruned after seven days, open ones never', () => {
  const { store, tick } = make()
  const a = store.add(q({ sessionId: 'a' }))
  const b = store.add(q({ sessionId: 'b' }))
  store.resolve(a.id, { kind: 'answered' })
  tick(7 * DAY - 1000)
  store.prune()
  assert.ok(store.get(a.id))
  tick(2000)
  store.prune()
  assert.equal(store.get(a.id), undefined)
  assert.ok(store.get(b.id))
})

test('findOpen locates items by type, session and key', () => {
  const { store } = make()
  store.add(q({ sessionId: 'a', key: 'call1' }))
  const b = store.add(q({ sessionId: 'a', key: 'call2' }))
  assert.equal(store.findOpen({ type: 'question', sessionId: 'a', key: 'call2' }).id, b.id)
  assert.equal(store.findOpen({ type: 'permission', sessionId: 'a' }), undefined)
})

test('persists to the injected file and a new store restores it', () => {
  const disk = {}
  const io = { read: () => disk.text, write: (text) => { disk.text = text } }
  const one = make({ io })
  const a = one.store.add(q({ sessionId: 'a' }))
  one.store.add(q({ sessionId: 'b' }))
  one.store.resolve(a.id, { kind: 'answered' })
  const two = make({ io })
  assert.deepEqual(two.store.snapshot().open.map((i) => i.sessionId), ['b'])
  assert.deepEqual(two.store.snapshot().resolved.map((i) => i.sessionId), ['a'])
})

test('a corrupt or unreadable file starts empty instead of failing', () => {
  assert.equal(make({ io: { read: () => '{not json', write() {} } }).store.list().length, 0)
  assert.equal(make({ io: { read: () => { throw new Error('EACCES') }, write() {} } }).store.list().length, 0)
})

test('a write failure never throws into the caller', () => {
  const { store } = make({ io: { read: () => undefined, write: () => { throw new Error('disk full') } } })
  assert.doesNotThrow(() => store.add(q()))
})

test('reconcile resolves open items whose session no longer exists', () => {
  const { store } = make()
  store.add(q({ sessionId: 'gone' })); store.add(q({ sessionId: 'live' }))
  store.reconcile(new Set(['live']))
  assert.deepEqual(store.snapshot().open.map((i) => i.sessionId), ['live'])
  assert.equal(store.snapshot().resolved[0].resolution.kind, 'session-ended')
})

test('resolveSession ends every open item of one session', () => {
  const { store } = make()
  store.add(q({ sessionId: 'a' })); store.add(q({ sessionId: 'a' })); store.add(q({ sessionId: 'b' }))
  store.resolveSession('a', { kind: 'session-ended' })
  assert.deepEqual(store.snapshot().open.map((i) => i.sessionId), ['b'])
})

test('reopen puts a resolved item back in the queue in its old place', () => {
  let t = 0
  const store = createStore({ now: () => ++t, uuid: () => 'u' + t })
  const a = store.add({ type: 'completed', sessionId: 's', payload: {} })
  const b = store.add({ type: 'completed', sessionId: 's', payload: {} })
  store.resolve(a.id, { kind: 'reviewed' })
  assert.deepEqual(store.snapshot().open.map((i) => i.id), [b.id])
  assert.equal(store.reopen(a.id), true)
  const snap = store.snapshot()
  assert.deepEqual(snap.open.map((i) => i.id), [a.id, b.id])
  assert.equal(snap.open[0].resolution, undefined)
  assert.equal(snap.open[0].resolvedAt, undefined)
  assert.equal(store.reopen(a.id), false)
  assert.equal(store.reopen('nope'), false)
})

test('add accepts an explicit id and creation time (the hub stores what an agent captured)', () => {
  const { store } = make()
  const a = store.add(q(), { id: 'ab12-0123456789ab', createdAt: 42 })
  assert.equal(a.id, 'ab12-0123456789ab')
  assert.equal(a.createdAt, 42)
  assert.equal(store.get('ab12-0123456789ab').createdAt, 42)
  assert.equal(store.add(q()).id, 'id2', 'without options the generated id and the clock are used')
})

test('dump gives the state a file needs and restore loads it into a fresh store', () => {
  const { store } = make()
  const a = store.add(q({ sessionId: 'a' }))
  store.add(q({ sessionId: 'b' }))
  store.resolve(a.id, { kind: 'answered' })
  const dumped = JSON.parse(JSON.stringify(store.dump()))
  assert.equal(dumped.seq, 2)
  assert.equal(dumped.items.length, 2)
  const { store: other } = make()
  other.restore(dumped)
  assert.deepEqual(other.list(), store.list())
  assert.equal(other.add(q({ sessionId: 'c' })).seq, 3, 'the sequence continues after a restore')
})

test('restore skips malformed items and replaces what was there', () => {
  const { store } = make()
  store.add(q({ sessionId: 'old' }))
  store.restore({ seq: 9, items: [null, { id: 5, type: 'question' }, { id: 'x' }, { id: 'ok', type: 'question', seq: 1, createdAt: 1, status: 'open' }] })
  assert.deepEqual(store.list().map((i) => i.id), ['ok'])
})
