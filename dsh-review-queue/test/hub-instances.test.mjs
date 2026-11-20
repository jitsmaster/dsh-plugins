import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHubStore } from '../hub/hub-store.js'
import { createCommands } from '../hub/commands.js'
import { createInstances, AWAY_MS, GRACE_MS, ORPHAN_KEEP_MS } from '../hub/instances.js'
import { fakeClock, memIo } from './hub-helpers.mjs'

const A = 'aaaa1111'
const B = 'bbbb2222'
let n = 0
function make({ io, ...over } = {}) {
  const clock = fakeClock()
  const store = createHubStore({ now: clock.now, uuid: () => 'u' + ++n, timers: clock, io })
  const commands = createCommands({ now: clock.now, timers: clock })
  const instances = createInstances({ store, commands, now: clock.now, ...over })
  return { clock, store, commands, instances }
}
const reg = (instances, id = A, over = {}) => instances.register({ key: 'k1', id, label: 'DSH :1', ...over })
const add = (store, owner, over = {}) => store.applyOp({ op: 'add', item: { type: 'question', sessionId: 's1', payload: {}, ...over } }, { owner }).id
const state = (instances, id = A) => instances.get(id)?.state
const open = (store) => store.list({ status: 'open' }).map((i) => i.id)
const idle = (clock, instances, ms) => { clock.advance(ms); instances.tick() }

test('the defaults are the design values: away after 45 s, gone after 120 s, orphans kept 24 h', () => {
  assert.deepEqual([AWAY_MS, GRACE_MS, ORPHAN_KEEP_MS], [45_000, 120_000, 24 * 3600 * 1000])
})

// ---- register, poll, away, gone ----------------------------------------------------------------------------------------

test('a new instance registers online and is remembered in the hub store', () => {
  const { store, instances } = make()
  const r = reg(instances, A, { pid: 42, pluginVersion: '0.1.0' })
  assert.equal(r.ok, true)
  assert.equal(state(instances), 'online')
  assert.equal(instances.get(A).key, 'k1')
  assert.equal(instances.byKey('k1').id, A)
  assert.deepEqual(store.getInstances().map((i) => [i.key, i.id, i.label]), [['k1', A, 'DSH :1']])
})

test('an instance id or key that is not usable is refused', () => {
  const { instances } = make()
  for (const bad of [{ id: '' }, { id: 'a b' }, { id: 'x' }, { id: 'a'.repeat(40) }, { key: '' }, { key: 5 }]) {
    assert.deepEqual(reg(instances, bad.id ?? A, bad.key === undefined ? {} : { key: bad.key }), { ok: false, error: 'bad-instance' }, JSON.stringify(bad))
  }
  assert.equal(instances.list().length, 0)
})

test('no poll for AWAY_MS makes an instance away, a poll in flight keeps it online, the next poll brings it back', () => {
  const { clock, instances } = make()
  reg(instances)
  idle(clock, instances, AWAY_MS - 1000)
  assert.equal(state(instances), 'online')
  idle(clock, instances, 2000)
  assert.equal(state(instances), 'away')
  assert.ok(instances.pollOpen(A))
  assert.equal(state(instances), 'online')
  idle(clock, instances, AWAY_MS * 3)
  assert.equal(state(instances), 'online', 'an open long poll counts as polling')
  instances.pollClose(A)
  idle(clock, instances, AWAY_MS + 1000)
  assert.equal(state(instances), 'away')
})

test('a state change moves the hub rev so waiting snapshots refresh, polling does not', () => {
  const { clock, store, instances } = make()
  reg(instances)
  const rev = store.rev
  instances.pollOpen(A); instances.pollClose(A); instances.touch(A)
  assert.equal(store.rev, rev)
  idle(clock, instances, AWAY_MS + 1000)
  assert.equal(store.rev, rev + 1)
})

test('away for GRACE_MS since the last sign of life makes it gone; its permissions end, its questions stay open as detached cards, other items stay', () => {
  const { clock, store, instances } = make()
  reg(instances)
  const q = add(store, A, { type: 'question' })
  const p = add(store, A, { type: 'permission' })
  const c = add(store, A, { type: 'completed' })
  idle(clock, instances, AWAY_MS + 1000)
  assert.equal(state(instances), 'away')
  assert.deepEqual(open(store).sort(), [q, p, c].sort())
  idle(clock, instances, GRACE_MS)
  assert.equal(state(instances), 'gone')
  assert.deepEqual(open(store).sort(), [q, c].sort())
  assert.deepEqual([store.get(q).detached, store.get(q).restarted], [true, true], 'its request died with the process: the answer will go out as a new message')
  assert.deepEqual(store.get(p).resolution, { kind: 'session-ended', by: 'hub', reason: 'owner-gone' })
})

test('settling twice changes nothing the second time', () => {
  const { clock, store, instances } = make()
  reg(instances)
  add(store, A, { type: 'permission' })
  idle(clock, instances, AWAY_MS + GRACE_MS + 1000)
  assert.equal(state(instances), 'gone')
  assert.equal(store.list({ status: 'open' }).length, 0)
  const rev = store.rev
  idle(clock, instances, 60_000)
  assert.equal(store.rev, rev)
})

test('the grace is configurable and a gone instance cannot poll', () => {
  const { clock, instances } = make({ graceMs: 10_000, awayMs: 5_000 })
  reg(instances)
  idle(clock, instances, 6000)
  assert.equal(state(instances), 'away')
  idle(clock, instances, 5000)
  assert.equal(state(instances), 'gone')
  assert.equal(instances.pollOpen(A), undefined)
  assert.equal(instances.touch(A), undefined)
})

// ---- every close the hub makes by itself names the item and the reason in its log ----
const closeLine = (logs, id) => logs.find((l) => l.includes(id))

test('a gone owner\'s permission is closed with a log line naming the item and the reason', () => {
  const logs = []
  const { clock, store, instances } = make({ log: (l) => logs.push(l) })
  reg(instances)
  const p = add(store, A, { type: 'permission' })
  idle(clock, instances, AWAY_MS + GRACE_MS + 1000)
  const line = closeLine(logs, p)
  assert.ok(line, logs.join(' | '))
  assert.match(line, /session-ended/)
})

test('a gone owner\'s question is kept open as detached, with a log line naming the item and the reason', () => {
  const logs = []
  const { clock, store, instances } = make({ log: (l) => logs.push(l) })
  reg(instances)
  const q = add(store, A, { type: 'question' })
  idle(clock, instances, AWAY_MS + GRACE_MS + 1000)
  const line = closeLine(logs, q)
  assert.ok(line, logs.join(' | '))
  assert.match(line, /detached/)
  assert.match(line, /owner-gone/)
})

test('a restarted app\'s dead question is kept open as detached, with a log line naming the item and the reason', () => {
  const logs = []
  const { store, instances } = make({ log: (l) => logs.push(l) })
  reg(instances, A)
  const q = add(store, A, { type: 'question' })
  reg(instances, B)
  assert.match(closeLine(logs, q) ?? '', /restarted/, logs.join(' | '))
  assert.match(closeLine(logs, q) ?? '', /detached/, logs.join(' | '))
})

test('an item the app no longer lists at a sync is closed with a log line naming the item and the reason', () => {
  const logs = []
  const { store, instances } = make({ log: (l) => logs.push(l) })
  reg(instances)
  const lost = add(store, A, { type: 'completed' })
  reg(instances, A, { sync: { n: 1, openItems: [], resolvedItems: [], workspaces: [], sessionIds: [] } })
  assert.match(closeLine(logs, lost) ?? '', /not-in-sync/, logs.join(' | '))
})

test('an orphan that outlived ORPHAN_KEEP_MS is closed with a log line naming the item and the reason', () => {
  const logs = []
  const { clock, store, instances } = make({ orphanKeepMs: 3_600_000, log: (l) => logs.push(l) })
  reg(instances)
  const c = add(store, A, { type: 'completed' })
  idle(clock, instances, AWAY_MS + GRACE_MS + 1000)
  idle(clock, instances, 3_601_000)
  assert.match(closeLine(logs, c) ?? '', /orphan-expired/, logs.join(' | '))
})

test('the other items of a gone owner are ended after ORPHAN_KEEP_MS', () => {
  const { clock, store, instances } = make({ orphanKeepMs: 3_600_000 })
  reg(instances)
  const c = add(store, A, { type: 'completed' })
  idle(clock, instances, AWAY_MS + GRACE_MS + 1000)
  assert.deepEqual(open(store), [c])
  idle(clock, instances, 3_599_000)
  assert.deepEqual(open(store), [c])
  idle(clock, instances, 2000)
  assert.deepEqual(open(store), [])
  assert.equal(store.get(c).resolution.reason, 'orphan-expired')
})

test('after a hub start every persisted instance gets GRACE_MS to come back, and cannot poll before it registered again', () => {
  const io = memIo()
  const first = make({ io })
  reg(first.instances)
  add(first.store, A, { type: 'question' })
  first.store.flush(true)
  const second = make({ io: memIo({ main: io.files.main }) })
  const inst = second.instances.get(A)
  assert.equal(inst.state, 'away')
  assert.equal(inst.lastSeenAt, second.clock.now())
  assert.equal(second.instances.pollOpen(A), undefined, 'unknown until it registers again')
  idle(second.clock, second.instances, GRACE_MS - 1000)
  assert.equal(state(second.instances), 'away')
  idle(second.clock, second.instances, 2000)
  assert.equal(state(second.instances), 'gone')
})

// ---- adoption, revival, sync ---------------------------------------------------------------------------------------------------

test('the same key with a new id is a restarted app: its permissions end, its question stays as a detached card, the rest is adopted', () => {
  const { store, instances, commands } = make()
  reg(instances, A)
  const q = add(store, A, { type: 'question' })
  const perm = add(store, A, { type: 'permission' })
  const done = add(store, A, { type: 'completed' })
  const todo = add(store, A, { type: 'todo', state: 'awaiting-confirm' })
  const waiting = commands.enqueue(A, { kind: 'approve', itemId: perm })
  const r = reg(instances, B)
  assert.equal(r.ok, true)
  assert.equal(r.adopted, 3)
  assert.deepEqual(store.get(perm).resolution, { kind: 'session-ended', by: 'hub', reason: 'restarted' })
  assert.deepEqual([q, done, todo].map((id) => [store.get(id).owner, store.get(id).status]), [[B, 'open'], [B, 'open'], [B, 'open']])
  assert.deepEqual([store.get(q).detached, store.get(q).restarted], [true, true])
  assert.ok(r.adoptedItems.some((i) => i.id === q && i.detached === true && i.restarted === true), 'the new app is handed the question flagged')
  assert.equal(state(instances, A), 'gone')
  assert.equal(state(instances, B), 'online')
  assert.equal(instances.byKey('k1').id, B)
  return waiting.then((x) => assert.deepEqual(x, { ok: false, error: 'owner-offline' }))
})

test('a returning owner revives the items the hub ended while it was away', () => {
  const { clock, store, instances } = make()
  reg(instances)
  const q = add(store, A, { type: 'permission' })
  idle(clock, instances, AWAY_MS + GRACE_MS + 1000)
  assert.equal(store.get(q).status, 'resolved')
  const r = reg(instances, A, { sync: { n: 3, openItems: [store.get(q)], resolvedItems: [], workspaces: [], sessionIds: ['s1'] } })
  assert.equal(r.revived, 1)
  assert.equal(store.get(q).status, 'open')
  assert.equal(store.get(q).resolution, undefined)
  assert.equal(state(instances), 'online')
  assert.equal(instances.get(A).lastOp, 3)
})

test('an item somebody else resolved is not revived: first resolve wins, and the owner is told', () => {
  const { store, instances } = make()
  reg(instances)
  const c = add(store, A, { type: 'completed' })
  store.resolve(c, { kind: 'reviewed', by: 'card' })
  const r = reg(instances, A, { sync: { n: 0, openItems: [{ ...store.get(c), status: 'open', resolution: undefined }], resolvedItems: [], workspaces: [], sessionIds: [] } })
  assert.equal(r.revived, 0)
  assert.equal(store.get(c).status, 'resolved')
  assert.deepEqual(r.resolved, [{ id: c, resolution: { kind: 'reviewed', by: 'card' } }])
})

test('a sync is the owner view of its items: new ones are added, missing open ones end, its resolutions are applied', () => {
  const { store, instances } = make()
  reg(instances)
  const keep = add(store, A, { type: 'question' })
  const gone = add(store, A, { type: 'completed' })
  const answered = add(store, A, { type: 'question' })
  const fresh = { id: 'aaaa-0123456789ab', type: 'completed', sessionId: 's9', createdAt: 5, payload: { reply: 'r' } }
  const r = reg(instances, A, { sync: {
    n: 7,
    openItems: [{ ...store.get(keep), summary: 'new summary' }, fresh],
    resolvedItems: [{ ...store.get(answered), status: 'resolved', resolution: { kind: 'answered', by: 'screen' } }],
    workspaces: [], sessionIds: [],
  } })
  assert.equal(r.ok, true)
  assert.equal(store.get(keep).summary, 'new summary')
  assert.deepEqual([store.get(fresh.id).owner, store.get(fresh.id).status], [A, 'open'])
  assert.deepEqual(store.get(gone).resolution, { kind: 'session-ended', by: 'hub', reason: 'not-in-sync' })
  assert.equal(store.get(answered).resolution.kind, 'answered')
  assert.equal(r.ended, 1)
})

test('an item the sync lists that another instance owns is not taken: the owner is told to drop its copy', () => {
  const { store, instances } = make()
  reg(instances, A)
  instances.register({ key: 'k2', id: B, label: 'DSH :2' })
  const mine = add(store, B, { type: 'todo' })
  const r = reg(instances, A, { sync: { n: 0, openItems: [store.get(mine)], resolvedItems: [], workspaces: [], sessionIds: [] } })
  assert.deepEqual(r.foreign, [mine])
  assert.equal(store.get(mine).owner, B)
})

test('a detached question of a gone owner is adopted by a new app (another key) that has its session; a live question never is', () => {
  const { store, instances } = make()
  reg(instances, A)
  const gone = add(store, A, { type: 'question', sessionId: 'sq' })
  instances.bye(A)
  const r = instances.register({ key: 'k2', id: B, label: 'DSH :2', sync: { n: 0, openItems: [], resolvedItems: [], workspaces: [], sessionIds: ['sq'] } })
  assert.equal(store.get(gone).owner, B)
  assert.ok(r.adoptedItems.some((i) => i.id === gone))
  const fresh = add(store, B, { type: 'question', sessionId: 'sz' })
  instances.register({ key: 'k3', id: 'cccc3333', label: 'DSH :3', sync: { n: 0, openItems: [], resolvedItems: [], workspaces: [], sessionIds: ['sz'] } })
  assert.equal(store.get(fresh).owner, B, 'an online owner with a live question is not robbed')
})

test('orphans of the legacy import are adopted by the instance that has their session', () => {
  const { store, instances } = make()
  const orphan = store.applyOp({ op: 'add', item: { type: 'completed', sessionId: 'sX', payload: {} } }, {}).id
  const other = store.applyOp({ op: 'add', item: { type: 'completed', sessionId: 'sY', payload: {} } }, {}).id
  const r = reg(instances, A, { sync: { n: 0, openItems: [], resolvedItems: [], workspaces: [], sessionIds: ['sX'] } })
  assert.equal(r.orphans, 1)
  assert.equal(store.get(orphan).owner, A)
  assert.equal(store.get(other).owner, undefined)
})

test('a graceful bye ends permissions at once, keeps questions as detached cards and the rest as orphans', () => {
  const { store, instances } = make()
  reg(instances)
  const q = add(store, A, { type: 'question' })
  const p = add(store, A, { type: 'permission' })
  const c = add(store, A, { type: 'completed' })
  assert.deepEqual(instances.bye(A), { ok: true })
  assert.equal(state(instances), 'gone')
  assert.equal(store.get(p).resolution.reason, 'owner-gone')
  assert.deepEqual([store.get(q).status, store.get(q).detached, store.get(q).restarted], ['open', true, true])
  assert.equal(store.get(c).status, 'open')
  assert.deepEqual(instances.bye('nope'), { ok: false, error: 'unknown-instance' })
})

// ---- what the snapshot and the routing ask -------------------------------------------------------------------------------------

test('view tells label and state of an owner; an unknown or missing owner is gone', () => {
  const { clock, instances } = make()
  reg(instances)
  assert.deepEqual(instances.view(A), { label: 'DSH :1', state: 'online' })
  idle(clock, instances, AWAY_MS + 1000)
  assert.equal(instances.view(A).state, 'away')
  assert.equal(instances.view('nope').state, 'gone')
  assert.equal(instances.view(undefined).state, 'gone')
})

test('the workspace union lists online instances only; the caller own come first and unsuffixed, the others carry the label', () => {
  const { clock, instances } = make()
  reg(instances, A, { sync: { n: 0, openItems: [], resolvedItems: [], sessionIds: [], workspaces: [{ id: 'w1', title: 'alpha', path: 'D:/a', sessionIds: ['s1'] }] } })
  instances.register({ key: 'k2', id: B, label: 'DSH :2', sync: { n: 0, openItems: [], resolvedItems: [], sessionIds: [], workspaces: [{ id: 'w1', title: 'beta', path: 'D:/b' }] } })
  assert.deepEqual(instances.workspaces({ caller: B }), [{ id: 'bbbb/w1', title: 'beta' }, { id: 'aaaa/w1', title: 'alpha (DSH :1)' }])
  assert.deepEqual(instances.workspaces({}), [{ id: 'aaaa/w1', title: 'alpha (DSH :1)' }, { id: 'bbbb/w1', title: 'beta (DSH :2)' }])
  assert.equal(instances.workspaces({ full: true })[0].path, 'D:/a')
  instances.bye(B)
  assert.deepEqual(instances.workspaces({}), [{ id: 'aaaa/w1', title: 'alpha' }])
  void clock
})

test('the coordinator of a todo is the caller if it is online, else the most recently desktop-active online instance', () => {
  const { clock, instances } = make()
  reg(instances, A)
  instances.register({ key: 'k2', id: B, label: 'DSH :2' })
  instances.presence(A, { desktopActive: true })
  clock.advance(1000)
  instances.presence(B, { desktopActive: true })
  assert.equal(instances.coordinator(A).id, A)
  assert.equal(instances.coordinator(undefined).id, B)
  clock.advance(1000)
  instances.presence(A, { desktopActive: true })
  assert.equal(instances.coordinator('nope').id, A)
  instances.bye(A)
  assert.equal(instances.coordinator(A).id, B)
  instances.bye(B)
  assert.equal(instances.coordinator(undefined), undefined)
})

// ---- decision never travels over the owner sync (hub-store blocks it too; this is the first line) --------------------------

test('owner sync carries a valid decision to the hub store (add and update), marked trusted', () => {
  const { store, instances } = make()
  const ctxs = []
  const orig = store.applyOp
  store.applyOp = (op, ctx) => { ctxs.push(ctx); return orig(op, ctx) }
  reg(instances, A, { sync: { openItems: [{ id: 'dn1', type: 'completed', sessionId: 's1', payload: {}, decision: { text: 'Q?', options: ['A', 'B'], free: true } }] } })
  assert.deepEqual(store.get('dn1').decision, { text: 'Q?', options: ['A', 'B'], free: true })
  instances.sync(A, { openItems: [{ id: 'dn1', type: 'completed', sessionId: 's1', payload: {}, summary: 'x', decision: { text: 'Q2?', options: ['A', 'B', 'C'], free: true } }] })
  assert.deepEqual(store.get('dn1').decision.options, ['A', 'B', 'C'])
  assert.ok(ctxs.length >= 2 && ctxs.every((c) => c.trusted === true && c.owner === A), JSON.stringify(ctxs))
})

test('owner sync drops a malformed decision (wrong type, too many options, long text) instead of storing it', () => {
  const { store, instances } = make()
  const bad = [
    { text: 5, options: [] }, { text: 'Q?', options: 'AB' }, { text: 'Q?', options: ['A', 'B', 'C', 'D', 'E'] },
    { text: 'x'.repeat(2000), options: ['A', 'B'] }, { text: 'Q?', options: [{ label: 'A' }, 'B'] }, 'evil', null,
  ]
  bad.forEach((decision, n) => reg(instances, A, { sync: { openItems: [{ id: 'bad' + n, type: 'completed', sessionId: 's' + n, payload: {}, decision }] } }))
  for (let n = 0; n < bad.length; n++) assert.equal(store.get('bad' + n)?.decision, undefined, 'malformed decision #' + n)
})
test('a sync that lists a restarted question without the detached flags does not unset them on the hub', () => {
  const { store, instances } = make()
  reg(instances, A)
  const q = add(store, A, { type: 'question', sessionId: 'sq' })
  reg(instances, B)
  assert.deepEqual([store.get(q).detached, store.get(q).restarted], [true, true])
  const plain = { ...store.get(q) }
  delete plain.detached
  delete plain.restarted
  instances.sync(B, { n: 1, openItems: [plain], resolvedItems: [], workspaces: [], sessionIds: ['sq'] })
  assert.deepEqual([store.get(q).detached, store.get(q).restarted], [true, true])
})

test('the same process coming back (sleep, hub restart) clears the flags the hub set on its live question', () => {
  const { clock, store, instances } = make()
  reg(instances)
  const q = add(store, A, { type: 'question', sessionId: 'sq' })
  idle(clock, instances, AWAY_MS + GRACE_MS + 1000)
  assert.equal(state(instances), 'gone')
  assert.deepEqual([store.get(q).detached, store.get(q).restarted], [true, true])
  const live = { ...store.get(q) }
  delete live.detached
  delete live.restarted
  reg(instances, A, { sync: { n: 0, openItems: [live], resolvedItems: [], workspaces: [], sessionIds: ['sq'] } })
  assert.equal(state(instances), 'online')
  assert.equal(store.get(q).status, 'open')
  assert.deepEqual([store.get(q).detached, store.get(q).restarted], [undefined, undefined], 'its request is alive again: it is not a restarted question')
})

test('a graceful bye followed by the same instance coming back also clears the flags; another instance never does', () => {
  const { store, instances } = make()
  reg(instances)
  const q = add(store, A, { type: 'question', sessionId: 'sq' })
  instances.bye(A)
  assert.deepEqual([store.get(q).detached, store.get(q).restarted], [true, true])
  reg(instances, B)
  const plain = { ...store.get(q) }
  delete plain.detached
  delete plain.restarted
  instances.sync(B, { n: 1, openItems: [plain], resolvedItems: [], workspaces: [], sessionIds: ['sq'] })
  assert.deepEqual([store.get(q).detached, store.get(q).restarted], [true, true], 'a different app (it never held the request) cannot unset them')
})

test('a sync carries sessionGone of a resolved item the hub already holds: set, then taken back', () => {
  const { store, instances } = make()
  reg(instances)
  const id = add(store, A, { type: 'completed' })
  store.applyOp({ op: 'resolve', id, resolution: { kind: 'reviewed', by: 'screen' } }, { owner: A })
  assert.equal(store.get(id).status, 'resolved')
  reg(instances, A, { sync: { n: 1, openItems: [], resolvedItems: [{ ...store.get(id), sessionGone: true }], workspaces: [], sessionIds: [] } })
  assert.equal(store.get(id).sessionGone, true)
  const { sessionGone, ...without } = store.get(id)
  reg(instances, A, { sync: { n: 2, openItems: [], resolvedItems: [without], workspaces: [], sessionIds: [] } })
  assert.notEqual(store.get(id).sessionGone, true)
})
