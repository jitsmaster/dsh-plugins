import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHubStore } from '../hub/hub-store.js'
import { createFileIo, writeAtomic } from '../hub/atomic-file.js'
import { fakeClock, memIo, tmpDir } from './hub-helpers.mjs'

const HOUR = 3600 * 1000
function make({ io = memIo(), ...extra } = {}) {
  const clock = fakeClock()
  let n = 0
  const store = createHubStore({ now: clock.now, uuid: () => 'u' + ++n, io, timers: clock, ...extra })
  return { store, clock, io }
}
const item = (over = {}) => ({ type: 'completed', sessionId: 's1', sessionTitle: 'One', payload: { reply: 'r' }, ...over })
const add = (store, over = {}, owner = 'A1') => store.applyOp({ op: 'add', item: item(over) }, { owner })

// ---- items, order, owner -------------------------------------------------------------------------------------------------------

test('add keeps the agent id, records the owner and assigns an open status and a hub seq', () => {
  const { store } = make()
  const r = add(store, { id: 'a1b2-000000000001' })
  assert.deepEqual(r, { ok: true, id: 'a1b2-000000000001' })
  const it = store.get('a1b2-000000000001')
  assert.equal(it.owner, 'A1')
  assert.equal(it.status, 'open')
  assert.equal(it.seq, 1)
  assert.equal(add(store, { id: 'a1b2-000000000002' }).ok, true)
  assert.equal(store.get('a1b2-000000000002').seq, 2)
})

test('an item without an id gets one, and the agent cannot set status, seq, owner or a resolution', () => {
  const { store } = make()
  const r = add(store, { status: 'resolved', seq: 99, owner: 'EVIL', resolvedAt: 5, resolution: { kind: 'answered' } })
  const it = store.get(r.id)
  assert.match(r.id, /^[0-9a-z-]+$/)
  assert.equal(it.status, 'open')
  assert.equal(it.seq, 1)
  assert.equal(it.owner, 'A1')
  assert.equal(it.resolvedAt, undefined)
  assert.equal(it.resolution, undefined)
})

test('a malformed add is refused', () => {
  const { store } = make()
  assert.deepEqual(store.applyOp({ op: 'add' }, { owner: 'A1' }), { ok: false, error: 'bad-op' })
  assert.deepEqual(store.applyOp({ op: 'add', item: { sessionId: 's' } }, { owner: 'A1' }), { ok: false, error: 'bad-op' })
  assert.deepEqual(store.applyOp({ op: 'nope' }, { owner: 'A1' }), { ok: false, error: 'bad-op' })
  assert.deepEqual(store.applyOp(undefined, { owner: 'A1' }), { ok: false, error: 'bad-op' })
  assert.equal(store.list().length, 0)
})

test('order is (createdAt, seq): an earlier createdAt goes first, equal times keep arrival order, positions are global across owners', () => {
  const { store, clock } = make()
  const t = clock.now()
  add(store, { id: 'late', sessionId: 'late', createdAt: t - 1000 }, 'A1')
  add(store, { id: 'early', sessionId: 'early', createdAt: t - 5000 }, 'B2')
  add(store, { id: 'tie1', sessionId: 'tie1', createdAt: t - 1000 }, 'B2')
  const open = store.snapshot().open
  assert.deepEqual(open.map((i) => [i.position, i.id, i.owner]), [[1, 'early', 'B2'], [2, 'late', 'A1'], [3, 'tie1', 'B2']])
})

test('createdAt from an agent is clamped to the last 24 hours up to now', () => {
  const { store, clock } = make()
  const now = clock.now()
  add(store, { id: 'future', createdAt: now + 10 * HOUR })
  add(store, { id: 'ancient', createdAt: now - 30 * HOUR })
  add(store, { id: 'missing' })
  add(store, { id: 'junk', createdAt: 'yesterday' })
  add(store, { id: 'fine', createdAt: now - HOUR })
  assert.equal(store.get('future').createdAt, now)
  assert.equal(store.get('ancient').createdAt, now - 24 * HOUR)
  assert.equal(store.get('missing').createdAt, now)
  assert.equal(store.get('junk').createdAt, now)
  assert.equal(store.get('fine').createdAt, now - HOUR)
})

test('the same id again from the same owner is a no-op replay; from another owner it is an id-conflict', () => {
  const { store } = make()
  add(store, { id: 'dup', sessionTitle: 'first' }, 'A1')
  const rev = store.rev
  assert.deepEqual(add(store, { id: 'dup', sessionTitle: 'again' }, 'A1'), { ok: true, id: 'dup', duplicate: true })
  assert.equal(store.get('dup').sessionTitle, 'first')
  assert.equal(store.rev, rev, 'a replay changes nothing')
  assert.deepEqual(add(store, { id: 'dup' }, 'B2'), { ok: false, error: 'id-conflict' })
  assert.equal(store.list().length, 1)
})

// ---- ops -----------------------------------------------------------------------------------------------------------------------

test('update patches an item of the same owner, never its identity or state, and still applies after a resolve', () => {
  const { store } = make()
  add(store, { id: 'x' })
  assert.deepEqual(store.applyOp({ op: 'update', id: 'x', patch: { summary: 'Did X.', id: 'other', seq: 77, status: 'resolved', owner: 'B2', createdAt: 1 } }, { owner: 'A1' }), { ok: true })
  const it = store.get('x')
  assert.equal(it.summary, 'Did X.')
  assert.deepEqual([it.id, it.seq, it.status, it.owner], ['x', 1, 'open', 'A1'])
  assert.notEqual(it.createdAt, 1)
  store.applyOp({ op: 'resolve', id: 'x', resolution: { kind: 'reviewed' } }, { owner: 'A1' })
  assert.equal(store.applyOp({ op: 'update', id: 'x', patch: { summary: 'Late summary.' } }, { owner: 'A1' }).ok, true)
  assert.equal(store.get('x').summary, 'Late summary.')
})

test('update refuses an unknown id and another owner', () => {
  const { store } = make()
  add(store, { id: 'x' }, 'A1')
  assert.deepEqual(store.applyOp({ op: 'update', id: 'nope', patch: {} }, { owner: 'A1' }), { ok: false, error: 'not-found' })
  assert.deepEqual(store.applyOp({ op: 'update', id: 'x', patch: { summary: 's' } }, { owner: 'B2' }), { ok: false, error: 'not-owner' })
  assert.equal(store.get('x').summary, undefined)
})

test('the first resolve wins; a second one reports not-open and the item keeps its resolution', () => {
  const { store } = make()
  add(store, { id: 'x' })
  assert.deepEqual(store.applyOp({ op: 'resolve', id: 'x', resolution: { kind: 'answered' } }, { owner: 'A1' }), { ok: true })
  assert.deepEqual(store.applyOp({ op: 'resolve', id: 'x', resolution: { kind: 'expired' } }, { owner: 'A1' }), { ok: false, error: 'not-open' })
  assert.equal(store.get('x').resolution.kind, 'answered')
  assert.deepEqual(store.applyOp({ op: 'resolve', id: 'nope', resolution: { kind: 'answered' } }, { owner: 'A1' }), { ok: false, error: 'not-found' })
})

test('reopen puts a resolved item back, in its old place', () => {
  const { store } = make()
  add(store, { id: 'a' }); add(store, { id: 'b' })
  store.applyOp({ op: 'resolve', id: 'a', resolution: { kind: 'reviewed' } }, { owner: 'A1' })
  assert.deepEqual(store.applyOp({ op: 'reopen', id: 'a' }, { owner: 'A1' }), { ok: true })
  assert.deepEqual(store.snapshot().open.map((i) => i.id), ['a', 'b'])
  assert.deepEqual(store.applyOp({ op: 'reopen', id: 'a' }, { owner: 'A1' }), { ok: false, error: 'not-reopenable' })
})

test('resolveSession closes every open item of a session', () => {
  const { store } = make()
  add(store, { id: 'a', sessionId: 's1' }); add(store, { id: 'b', sessionId: 's1' }); add(store, { id: 'c', sessionId: 's2' })
  assert.deepEqual(store.applyOp({ op: 'resolveSession', sessionId: 's1', resolution: { kind: 'session-ended' } }, { owner: 'A1' }), { ok: true, changed: true })
  assert.deepEqual(store.snapshot().open.map((i) => i.id), ['c'])
  assert.deepEqual(store.applyOp({ op: 'resolveSession', sessionId: 's1', resolution: { kind: 'session-ended' } }, { owner: 'A1' }), { ok: true, changed: false })
})

// ---- rev, snapshot, prune, listeners -------------------------------------------------------------------------------------------

test('rev counts changes only; the snapshot id is epoch and rev; a refused op changes nothing', () => {
  const { store } = make()
  const r0 = store.rev
  add(store, { id: 'x' })
  assert.equal(store.rev, r0 + 1)
  const id1 = store.snapshot().snapshotId
  assert.equal(id1, store.epoch + ':' + store.rev)
  assert.equal(store.isCurrent(id1), true)
  store.applyOp({ op: 'update', id: 'nope', patch: {} }, { owner: 'A1' })
  assert.equal(store.rev, r0 + 1)
  store.applyOp({ op: 'resolve', id: 'x', resolution: { kind: 'reviewed' } }, { owner: 'A1' })
  assert.equal(store.isCurrent(id1), false)
})

test('the snapshot lists open items by position and resolved items newest first', () => {
  const { store, clock } = make()
  add(store, { id: 'a', createdAt: clock.now() }); add(store, { id: 'b' }); add(store, { id: 'c' })
  store.applyOp({ op: 'resolve', id: 'a', resolution: { kind: 'reviewed' } }, { owner: 'A1' })
  clock.advance(1000)
  store.applyOp({ op: 'resolve', id: 'b', resolution: { kind: 'reviewed' } }, { owner: 'A1' })
  const snap = store.snapshot()
  assert.deepEqual(snap.open.map((i) => [i.position, i.id]), [[1, 'c']])
  assert.deepEqual(snap.resolved.map((i) => i.id), ['b', 'a'])
})

test('prune drops resolved items past the retention (7 days by default) and counts a change', () => {
  const { store, clock } = make()
  add(store, { id: 'old' }); add(store, { id: 'open' })
  store.applyOp({ op: 'resolve', id: 'old', resolution: { kind: 'reviewed' } }, { owner: 'A1' })
  clock.advance(7 * 24 * HOUR - 1000)
  store.prune()
  assert.ok(store.get('old'))
  clock.advance(2000)
  const rev = store.rev
  store.prune()
  assert.equal(store.get('old'), undefined)
  assert.ok(store.get('open'), 'open items are never pruned')
  assert.equal(store.rev, rev + 1)
})

test('prune honours a configured retention', () => {
  const { store, clock } = make({ retentionMs: 1000 })
  add(store, { id: 'old' })
  store.applyOp({ op: 'resolve', id: 'old', resolution: { kind: 'reviewed' } }, { owner: 'A1' })
  assert.ok(store.get('old'))
  clock.advance(1500)
  store.prune()
  assert.equal(store.get('old'), undefined)
})

test('onChange tells listeners about every change until they unsubscribe; a throwing listener does not stop the others', () => {
  const { store } = make()
  const calls = []
  const off = store.onChange(() => calls.push('a'))
  store.onChange(() => { throw new Error('bad listener') })
  store.onChange(() => calls.push('b'))
  add(store, { id: 'x' })
  assert.deepEqual(calls, ['a', 'b'])
  off()
  add(store, { id: 'y' })
  assert.deepEqual(calls, ['a', 'b', 'b'])
})

// ---- persistence ---------------------------------------------------------------------------------------------------------------

test('changes are written once, 200 ms after the last one', () => {
  const { store, clock, io } = make()
  add(store, { id: 'a' })
  clock.advance(100)
  add(store, { id: 'b' })
  clock.advance(199)
  assert.equal(io.writes.length, 0)
  clock.advance(1)
  assert.equal(io.writes.length, 1)
  assert.equal(JSON.parse(io.writes[0].text).items.length, 2)
  clock.advance(5000)
  assert.equal(io.writes.length, 1, 'nothing more to write')
})

test('a stream of changes is still written once a second', () => {
  const { store, clock, io } = make()
  for (let i = 0; i < 9; i++) { add(store, { id: 'i' + i }); clock.advance(100) }
  assert.equal(io.writes.length, 0, 'still debouncing at 900 ms')
  add(store, { id: 'i9' })
  clock.advance(100)
  assert.equal(io.writes.length, 1, 'forced at 1 s')
  assert.equal(JSON.parse(io.writes[0].text).items.length, 10)
})

test('many changes inside one window cost one write of the whole 620 KB queue', () => {
  const { store, clock, io } = make()
  const big = 'x'.repeat(5000)
  for (let i = 0; i < 124; i++) add(store, { id: 'big' + i, payload: { reply: big } })
  assert.ok(store.stats.lastBytes === 0)
  for (let i = 0; i < 50; i++) { store.applyOp({ op: 'update', id: 'big' + i, patch: { summary: 's' + i } }, { owner: 'A1' }); clock.advance(5) }
  clock.advance(300)
  assert.equal(io.writes.length, 1)
  assert.ok(io.writes[0].text.length > 600_000, 'the queue file is about 620 KB: ' + io.writes[0].text.length)
  assert.equal(store.stats.writes, 1)
  assert.equal(store.stats.lastBytes, io.writes[0].text.length)
})

test('flush writes at once, is a no-op when nothing changed, and close flushes the rest', () => {
  const { store, clock, io } = make()
  store.flush()
  assert.equal(io.writes.length, 0)
  add(store, { id: 'a' })
  store.flush()
  assert.equal(io.writes.length, 1)
  assert.equal(clock.pending(), 0, 'the debounce timer is gone')
  store.flush()
  assert.equal(io.writes.length, 1)
  add(store, { id: 'b' })
  store.close()
  assert.equal(io.writes.length, 2)
  assert.equal(clock.pending(), 0)
})

test('the file holds version, epoch, seq, rev, items and instances; a new store reads it back', () => {
  const { store, io } = make()
  add(store, { id: 'a' }); add(store, { id: 'b', createdAt: 5 })
  store.setInstances([{ key: 'k', id: 'i', label: 'DSH :1', lastSeenAt: 3 }])
  store.flush()
  const data = JSON.parse(io.files.main)
  assert.deepEqual(Object.keys(data).sort(), ['epoch', 'instances', 'items', 'rev', 'seq', 'v'])
  assert.equal(data.v, 2)
  assert.equal(data.items.length, 2)
  const { store: again } = make({ io })
  assert.equal(again.loadedFrom, 'main')
  assert.deepEqual(again.list(), store.list())
  assert.equal(again.epoch, store.epoch)
  assert.equal(again.rev, store.rev)
  assert.deepEqual(again.getInstances(), [{ key: 'k', id: 'i', label: 'DSH :1', lastSeenAt: 3 }])
  assert.equal(add(again, { id: 'c' }).ok, true)
  assert.equal(again.get('c').seq, 3, 'the hub seq continues across a restart')
})

test('the last good file is kept as .bak: each write moves the previous one aside', () => {
  const { store, io } = make()
  add(store, { id: 'a' })
  store.flush()
  assert.equal(io.writes[0].rotate, false, 'nothing on disk yet, nothing to keep')
  add(store, { id: 'b' })
  store.flush()
  assert.equal(io.writes[1].rotate, true)
  assert.equal(JSON.parse(io.files.bak).items.length, 1)
})

test('a corrupt main file is replaced from .bak, and the first write after that does not overwrite the good .bak with the corrupt one', () => {
  const good = JSON.stringify({ v: 2, epoch: 'e1', seq: 1, rev: 4, items: [{ id: 'a', type: 'completed', seq: 1, status: 'open', createdAt: 1, owner: 'A1' }], instances: [] })
  const io = memIo({ main: '{"v":2,"epoch":"e1","items":[{"id":"a"', bak: good })
  const logs = []
  const { store, clock } = make({ io, log: (l) => logs.push(l) })
  assert.equal(store.loadedFrom, 'bak')
  assert.deepEqual(store.list().map((i) => i.id), ['a'])
  assert.equal(store.rev, 4)
  assert.ok(logs.some((l) => /recover/i.test(l)))
  add(store, { id: 'b' })
  clock.advance(300)
  assert.equal(io.writes[0].rotate, false, 'the corrupt file must not become the .bak')
  assert.equal(io.files.bak, good)
  add(store, { id: 'c' })
  clock.advance(300)
  assert.equal(io.writes[1].rotate, true, 'after a good write the rotation is back')
})

test('a missing, wrong-version or unreadable pair starts empty without throwing', () => {
  for (const io of [memIo(), memIo({ main: 'not json', bak: '{also bad' }), memIo({ main: JSON.stringify({ v: 1, items: [] }) }), memIo({ main: JSON.stringify({ v: 2, items: 'no' }) })]) {
    const { store } = make({ io })
    assert.equal(store.loadedFrom, 'empty')
    assert.deepEqual(store.list(), [])
    assert.equal(store.rev, 0)
  }
})

test('a failing write keeps the store working and is retried with the next debounce', () => {
  const { store, clock, io } = make()
  io.failNext = 1
  add(store, { id: 'a' })
  clock.advance(250)
  assert.equal(io.writes.length, 0)
  assert.equal(store.stats.failures, 1)
  assert.equal(store.get('a').id, 'a')
  clock.advance(250)
  assert.equal(io.writes.length, 1, 'retried and written')
  assert.equal(JSON.parse(io.files.main).items.length, 1)
})

test('a failing flush on close does not throw', () => {
  const { store, io } = make()
  io.failNext = 5
  add(store, { id: 'a' })
  assert.doesNotThrow(() => store.close())
  assert.equal(store.stats.failures, 1)
  assert.equal(io.writes.length, 0)
})

// ---- real files ----------------------------------------------------------------------------------------------------------------

test('writeAtomic writes <name>.<pid>.tmp, keeps the old file as .bak when asked, and renames over the target', () => {
  const calls = []
  const rec = (name) => (...args) => { calls.push([name, ...args]) }
  const fakeFs = { mkdirSync: rec('mkdir'), writeFileSync: rec('write'), renameSync: rec('rename'), unlinkSync: rec('unlink') }
  writeAtomic(join('d', 'queue.json'), 'TEXT', { rotate: true, pid: 4242, fs: fakeFs })
  const tmp = join('d', 'queue.json') + '.4242.tmp'
  assert.deepEqual(calls.map((c) => c[0]), ['mkdir', 'write', 'rename', 'rename'])
  assert.equal(calls[1][1], tmp)
  assert.equal(calls[1][2], 'TEXT')
  assert.deepEqual(calls[2].slice(1), [join('d', 'queue.json'), join('d', 'queue.json') + '.bak'])
  assert.deepEqual(calls[3].slice(1), [tmp, join('d', 'queue.json')])
})

test('writeAtomic without rotate does not touch .bak, and a failing rename removes the temp file and throws', () => {
  const calls = []
  const fakeFs = { mkdirSync() {}, writeFileSync() {}, renameSync() { throw new Error('EPERM') }, unlinkSync: (p) => calls.push(p) }
  assert.throws(() => writeAtomic(join('d', 'q.json'), 'T', { pid: 7, fs: fakeFs }), /EPERM/)
  assert.deepEqual(calls, [join('d', 'q.json') + '.7.tmp'])
})

test('on disk: a store round-trips through createFileIo and leaves no temp file behind', (t) => {
  const dir = tmpDir(t)
  const file = join(dir, 'hub', 'queue.json')
  const { store } = make({ io: createFileIo(file) })
  add(store, { id: 'a' })
  store.flush()
  assert.deepEqual(readdirSync(join(dir, 'hub')), ['queue.json'])
  const { store: again } = make({ io: createFileIo(file) })
  assert.deepEqual(again.list().map((i) => i.id), ['a'])
})

test('on disk: a truncated queue.json is recovered from queue.json.bak (the last good copy)', (t) => {
  const dir = tmpDir(t)
  const file = join(dir, 'queue.json')
  const { store } = make({ io: createFileIo(file) })
  add(store, { id: 'a' })
  store.flush()
  add(store, { id: 'b' })
  store.flush()
  assert.ok(existsSync(file + '.bak'))
  truncateSync(file, Math.floor(readFileSync(file).length / 2))
  const logs = []
  const { store: again } = make({ io: createFileIo(file), log: (l) => logs.push(l) })
  assert.equal(again.loadedFrom, 'bak')
  assert.deepEqual(again.list().map((i) => i.id), ['a'], 'the .bak is the write before the last one')
  assert.ok(logs.length > 0)
})

test('on disk: both files corrupt starts empty; the next write replaces them', (t) => {
  const dir = tmpDir(t)
  const file = join(dir, 'queue.json')
  writeFileSync(file, '{"v":2,"ite'); writeFileSync(file + '.bak', '')
  const { store } = make({ io: createFileIo(file) })
  assert.equal(store.loadedFrom, 'empty')
  add(store, { id: 'z' })
  store.flush()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items.length, 1)
})
