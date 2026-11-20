import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createSessionCounter } from '../sessions.js'
import { canPost, hasThread } from '../lib/mobile/thread.js'

// A resolved item stays in the list when its session is gone, but loses its session controls (Open session, View Changes; on the phone the
// conversation, the composer and Archive session). The app marks its own resolved items `sessionGone` from the session list.

const GRACE = 60_000
function setup({ live = ['alive'], controller, span = 0 } = {}) {
  const t = { v: 1_000_000 }
  const state = { live: [...live] }
  const ctl = controller === undefined ? { list: async () => ({ items: state.live.map((sessionId) => ({ sessionId, running: false, updatedAt: 1, blank: false })) }) } : controller
  const store = createStore({ now: () => t.v })
  const sessions = createSessionCounter({ controllerOf: () => ctl ?? undefined, now: () => t.v, ttlMs: 0, goneSpanMs: span }) // span 0: absent from the latest answer is enough; the span tests set a real one
  const queue = createReviewQueue({ store, capture: {}, log: () => {}, sessions, now: () => t.v })
  const resolved = (sessionId, extra = {}) => { const it = store.add({ type: 'completed', sessionId, ...extra }); store.resolve(it.id, { kind: 'reviewed', by: 'card' }); return it }
  const snap = async () => { queue.snapshot({ watch: true }); await sessions.refresh(); queue.snapshot({ watch: true }); await sessions.refresh(); return queue.snapshot({ watch: true }) } // two lists answered, then the flags are read
  return { t, state, store, sessions, queue, resolved, snap }
}
const goneOf = (s, id) => s.resolved.find((i) => i.id === id).sessionGone === true

// ---- the counter knows every listed session
test('counter: knownIds is every listed session (archived and child ones too), undefined while unknown', async () => {
  const listed = { items: [{ sessionId: 'a', running: true }, { sessionId: 'sub', origin: 'subagent' }, { sessionId: 'arch' }, { nope: 1 }] }
  const counter = createSessionCounter({ controllerOf: () => ({ list: async () => listed }), registryOf: () => ({ archivedSessionIds: ['arch'] }), ttlMs: 0 })
  assert.equal(counter.knownIds(), undefined)
  counter.touch()
  await counter.refresh()
  assert.deepEqual([...counter.knownIds()].sort(), ['a', 'arch', 'sub'])
})

test('counter: a failing list keeps the last known ids', async () => {
  let fail = false
  const counter = createSessionCounter({ controllerOf: () => ({ list: async () => { if (fail) throw new Error('x'); return { items: [{ sessionId: 'a' }] } } }), ttlMs: 0 })
  counter.touch(); await counter.refresh()
  fail = true; await counter.refresh()
  assert.deepEqual([...counter.knownIds()], ['a'])
})

test('counter: a change of the known ids alone does not wake the listeners (the next snapshot reads them anyway)', async () => {
  let items = [{ sessionId: 'a' }]
  let t = 0
  const counter = createSessionCounter({ controllerOf: () => ({ list: async () => ({ items }) }), now: () => t, ttlMs: 0, minEmitMs: 0 })
  let heard = 0
  counter.onChange(() => { heard++ })
  counter.touch(); await counter.refresh()
  const first = heard
  items = [{ sessionId: 'a' }, { sessionId: 'b', parentSessionId: 'a' }] // the open count stays 1, only a known id appears
  t += 10; await counter.refresh()
  assert.equal(heard, first, 'child and blank sessions come and go often: no long-poll wake-up for them')
})

test('counter: isUnlisted needs the session absent from every answer of the whole span, and answers covering that span', async () => {
  let items = [{ sessionId: 'a' }]
  let t = 0
  const counter = createSessionCounter({ controllerOf: () => ({ list: async () => ({ items }) }), now: () => t, ttlMs: 0, interestMs: 100_000, goneSpanMs: 30_000, minEmitMs: 0 })
  const answer = async (at) => { t = at; counter.touch(); await counter.refresh() }
  await answer(0)
  assert.equal(counter.isUnlisted('x'), false, 'one answer covers no time')
  await answer(10_000)
  assert.equal(counter.isUnlisted('x'), false, 'only 10 s of answers so far')
  await answer(31_000)
  assert.equal(counter.isUnlisted('x'), true)
  assert.equal(counter.isUnlisted('a'), false, 'a listed session is never unlisted')
  items = [{ sessionId: 'a' }, { sessionId: 'x' }]
  await answer(32_000)
  assert.equal(counter.isUnlisted('x'), false, 'listed in the latest answer')
  items = [{ sessionId: 'a' }]
  await answer(40_000)
  assert.equal(counter.isUnlisted('x'), false, 'it was listed 8 s ago: the span restarts')
  await answer(63_000)
  assert.equal(counter.isUnlisted('x'), true, 'absent for 31 s since it was last listed')
})

test('counter: isUnlisted starts over after a gap in the answers (the counter stopped listing while nobody looked)', async () => {
  let t = 0
  const counter = createSessionCounter({ controllerOf: () => ({ list: async () => ({ items: [{ sessionId: 'a' }] }) }), now: () => t, ttlMs: 0, interestMs: 100_000, goneSpanMs: 30_000 })
  const answer = async (at) => { t = at; counter.touch(); await counter.refresh() }
  await answer(0); await answer(31_000)
  assert.equal(counter.isUnlisted('x'), true)
  await answer(200_000) // the previous answer is older than the interest time
  assert.equal(counter.isUnlisted('x'), false, 'a fresh streak of answers covers no time yet')
  await answer(231_000)
  assert.equal(counter.isUnlisted('x'), true)
})

// ---- the service marks the resolved items
test('service: a resolved item whose session is not listed gets sessionGone; a listed one does not', async () => {
  const { t, resolved, snap } = setup()
  const gone = resolved('missing'); const kept = resolved('alive')
  t.v += GRACE + 1
  await snap()
  const again = await snap()
  assert.equal(goneOf(again, gone.id), true)
  assert.equal(goneOf(again, kept.id), false)
})

test('service: the item stays in the resolved list when its session is gone', async () => {
  const { t, resolved, snap } = setup()
  const gone = resolved('missing')
  t.v += GRACE + 1
  await snap()
  assert.ok((await snap()).resolved.some((i) => i.id === gone.id))
})

test('service: the flag is stored, so it reaches the hub and the phone as data', async () => {
  const { t, resolved, snap, store } = setup()
  const gone = resolved('missing')
  t.v += GRACE + 1
  await snap(); await snap()
  assert.equal(store.get(gone.id).sessionGone, true)
})

test('service: a resolved item is judged only after a grace time (a session just created may not be listed yet)', async () => {
  const { t, resolved, snap } = setup()
  const fresh = resolved('missing')
  t.v += GRACE - 1000
  assert.equal(goneOf(await snap(), fresh.id), false)
  t.v += 2000
  await snap()
  assert.equal(goneOf(await snap(), fresh.id), true)
})

test('service: open items and items without a session are never marked', async () => {
  const { t, store, resolved, snap } = setup()
  const open = store.add({ type: 'completed', sessionId: 'missing' })
  const bare = resolved(undefined)
  const empty = resolved('')
  t.v += GRACE + 1
  const s = await snap()
  assert.equal(s.open.find((i) => i.id === open.id).sessionGone, undefined)
  assert.equal(goneOf(s, bare.id), false)
  assert.equal(goneOf(s, empty.id), false)
})

test('service: nothing is marked while the session list is unknown or empty', async () => {
  for (const controller of [null, { list: async () => ({ items: [] }) }, { list: async () => { throw new Error('busy') } }, { list: async () => ({}) }]) {
    const { t, resolved, snap } = setup({ controller })
    const it = resolved('missing')
    t.v += GRACE + 1
    await snap()
    assert.equal(goneOf(await snap(), it.id), false, JSON.stringify(controller))
  }
})

test('service: the flag is taken back when the session is listed again', async () => {
  const { t, state, resolved, snap, store } = setup()
  const it = resolved('back')
  t.v += GRACE + 1
  await snap()
  assert.equal(goneOf(await snap(), it.id), true)
  state.live.push('back')
  await snap()
  assert.equal(goneOf(await snap(), it.id), false)
  assert.notEqual(store.get(it.id).sessionGone, true)
})

test('service: a reopened item loses the flag (it is open again, its session controls come back to the usual rules)', async () => {
  const { t, resolved, snap, store } = setup()
  const it = resolved('missing')
  t.v += GRACE + 1
  await snap(); await snap()
  assert.equal(store.get(it.id).sessionGone, true)
  assert.equal(store.reopen(it.id), true)
  const s = await snap()
  assert.equal(s.open.find((i) => i.id === it.id).sessionGone, undefined)
  assert.notEqual(store.get(it.id).sessionGone, true)
})
test('service: marking is idempotent, it does not change the store again once set', async () => {
  const { t, resolved, snap, store } = setup()
  resolved('missing')
  t.v += GRACE + 1
  await snap(); await snap()
  let changes = 0
  store.onChange(() => { changes++ })
  await snap(); await snap()
  assert.equal(changes, 0)
})

// ---- the desktop overlay
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')
function loadClient() {
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  return registered.factory(() => stubReact).__test
}

test('desktop: no Open session control (or View Changes) on a resolved item whose session is gone', () => {
  const T = loadClient()
  assert.equal(T.resolvedOpenAction({ sessionId: 's1', sessionGone: true }, true), 'none')
  assert.equal(T.openControl({ type: 'todo', sessionId: 's1', sessionGone: true }, true), 'none')
  assert.equal(T.openControl({ type: 'completed', sessionId: 's1', sessionGone: true }, true), 'none')
})

test('desktop: the control stays for an item whose session exists (flag absent or false)', () => {
  const T = loadClient()
  assert.equal(T.resolvedOpenAction({ sessionId: 's1' }, true), 'open')
  assert.equal(T.resolvedOpenAction({ sessionId: 's1', sessionGone: false }, true), 'open')
  assert.equal(T.openControl({ type: 'todo', sessionId: 's1', sessionGone: false }, true), 'button')
})

// ---- the phone
test('phone: a gone session has no conversation, composer or Archive session (hasThread / canPost false)', () => {
  const item = { type: 'completed', status: 'resolved', sessionId: 's1', sessionGone: true }
  assert.equal(hasThread(item), false)
  assert.equal(canPost(item), false)
})

test('phone: a session that exists keeps them', () => {
  for (const flag of [undefined, false]) {
    const item = { type: 'completed', status: 'resolved', sessionId: 's1', sessionGone: flag }
    assert.equal(hasThread(item), true)
    assert.equal(canPost(item), true)
  }
})

// ---- wiring: the cards use these predicates (a gone item shows no View Changes / Open session, no archive button, no conversation)
test('desktop: View Changes and Open session sit inside the canOpen branch of ResolvedCard', () => {
  const start = source.indexOf('function ResolvedCard')
  const card = source.slice(start, source.indexOf('function ResolvedList'))
  const branch = card.slice(card.indexOf('canOpen ? h("div", { className: "rq-row" }'))
  assert.match(branch, /Open session/)
  assert.match(branch, /View Changes/)
  assert.match(card, /resolvedOpenAction\(it, !!hostApi\.openSession\) === "open"/)
})

test('phone: Conversation, Composer and the archive helper are all gated by hasThread / canPost', () => {
  const views = readFileSync(new URL('../lib/mobile/views.js', import.meta.url), 'utf8')
  assert.match(views, /const chat = hasThread\(item\)/)
  assert.match(views, /const writable = canPost\(item\)/)
  assert.match(views, /if \(!hasThread\(item\) \|\|/)
})
// ---- review fixes: stale list, short-lived miss, open items
test('service: a session is flagged only after it was absent for the whole span; a listing in between restarts the span', async () => {
  const { t, state, resolved, sessions, queue } = setup({ span: 30_000 })
  const it = resolved('flaky')
  t.v += GRACE + 1
  // One step = the time passes, one list answer is read, then the flags are read (a second call is started and awaited so nothing is in flight).
  const step = async (ms) => { t.v += ms; queue.snapshot({ watch: true }); await sessions.refresh(); const s = queue.snapshot({ watch: true }); await sessions.refresh(); return s }
  assert.equal(goneOf(await step(0), it.id), false, 'the first answer covers no time')
  assert.equal(goneOf(await step(10_000), it.id), false, 'absent for 10 s only')
  assert.equal(goneOf(await step(25_000), it.id), true, 'absent for 35 s')
  state.live.push('flaky') // the host lists it again
  assert.equal(goneOf(await step(1000), it.id), false, 'the flag is taken back at once')
  state.live.pop()
  assert.equal(goneOf(await step(1000), it.id), false, 'absent again, but it was listed a moment ago')
  assert.equal(goneOf(await step(31_000), it.id), true, 'absent for the whole span again')
})

test('service: a list older than the interest time is not trusted (the counter stopped listing while nobody looked)', async () => {
  const { t, state, resolved, sessions, queue, snap } = setup()
  await snap() // known is fresh
  const it = resolved('newborn') // created and resolved while nobody looked
  t.v += GRACE * 3
  const stale = queue.snapshot({ watch: true }) // known is 3 min old: nothing is judged on it
  assert.equal(goneOf(stale, it.id), false)
  state.live.push('newborn')
  await sessions.refresh()
  assert.equal(goneOf(await snap(), it.id), false, 'the fresh list has it: never flagged')
})

test('counter: knownIds is undefined once its answer is older than the interest time', async () => {
  let t = 0
  const counter = createSessionCounter({ controllerOf: () => ({ list: async () => ({ items: [{ sessionId: 'a' }] }) }), now: () => t, ttlMs: 0, interestMs: 1000 })
  counter.touch(); await counter.refresh()
  assert.deepEqual([...counter.knownIds()], ['a'])
  t += 1500
  assert.equal(counter.knownIds(), undefined)
})

test('predicates: sessionGone counts on resolved items only (an open item keeps its controls)', () => {
  const T = loadClient()
  assert.equal(T.resolvedOpenAction({ sessionId: 's1', status: 'open', sessionGone: true }, true), 'open')
  assert.equal(T.resolvedOpenAction({ sessionId: 's1', status: 'resolved', sessionGone: true }, true), 'none')
  assert.equal(hasThread({ type: 'completed', status: 'open', sessionId: 's1', sessionGone: true }), true)
  assert.equal(canPost({ type: 'completed', status: 'open', sessionId: 's1', sessionGone: true }), true)
})
test('service: one snapshot writes at most a bounded number of flags (a deleted session with many items does not burst the store)', async () => {
  const { t, resolved, sessions, queue, store } = setup()
  for (let n = 0; n < 600; n++) resolved('missing')
  t.v += GRACE + 1
  queue.snapshot({ watch: true }); await sessions.refresh() // list answer 1
  queue.snapshot({ watch: true }); await sessions.refresh() // list answer 2 (one answer alone never flags)
  const marked = () => store.list({ status: 'resolved' }).filter((i) => i.sessionGone === true).length
  queue.snapshot({ watch: true }) // one flag pass
  const first = marked()
  assert.ok(first > 0 && first <= 500, 'at most 500 per snapshot, got ' + first)
  for (let n = 0; n < 5; n++) queue.snapshot({ watch: true })
  assert.equal(marked(), 600, 'the rest follow on the next snapshots')
})
// ---- regression-review fixes
test('service: a failing store write in the flag pass does not break the snapshot', async () => {
  const { t, resolved, snap, store, queue } = setup()
  resolved('missing')
  t.v += GRACE + 1
  await snap()
  store.updateMany = () => { throw new Error('disk full') }; store.update = () => { throw new Error('disk full') }
  resolved('missing2')
  t.v += GRACE + 1
  await snap()
  assert.doesNotThrow(() => queue.snapshot({ watch: true }))
})

test('service: when no flag changes, the snapshot does not copy the resolved items again', async () => {
  const { t, resolved, snap, store, queue } = setup()
  for (let n = 0; n < 5; n++) resolved(n % 2 ? 'missing' : 'alive')
  t.v += GRACE + 1
  await snap()
  const orig = store.list
  let copies = 0
  store.list = (arg) => { if (arg?.status === 'resolved') copies++; return orig(arg) }
  for (let n = 0; n < 4; n++) queue.snapshot({ watch: true })
  assert.equal(copies, 0)
})

test('service: an already flagged item keeps its flag across an idle gap (no flicker while the new span builds up)', async () => {
  const { t, state, resolved, sessions, queue, store } = setup({ span: 30_000 })
  const it = resolved('deleted')
  t.v += GRACE + 1
  const step = async (ms) => { t.v += ms; queue.snapshot({ watch: true }); await sessions.refresh(); const s = queue.snapshot({ watch: true }); await sessions.refresh(); return s }
  await step(0); await step(10_000)
  assert.equal(goneOf(await step(25_000), it.id), true, 'flagged before the gap')
  let writes = 0
  store.onChange(() => { writes++ })
  const seen = []
  seen.push(goneOf(await step(180_000), it.id)) // nobody looked for 3 min: the list run starts over
  seen.push(goneOf(await step(5_000), it.id))
  seen.push(goneOf(await step(10_000), it.id))
  seen.push(goneOf(await step(31_000), it.id))
  assert.deepEqual(seen, [true, true, true, true], 'the flag never drops without a listing of the session')
  assert.equal(writes, 0, 'and nothing is written to the store or sent to the hub')
  state.live.push('deleted') // positive evidence: the host lists it
  assert.equal(goneOf(await step(1000), it.id), false, 'a listing takes the flag back at once')
})

test('counter: isUnlisted needs at least two answers lacking the session, not one sparse answer long after the last listing', async () => {
  let items = [{ sessionId: 'a' }, { sessionId: 'x' }]
  let t = 0
  const counter = createSessionCounter({ controllerOf: () => ({ list: async () => ({ items }) }), now: () => t, ttlMs: 0, interestMs: 100_000, goneSpanMs: 30_000, minEmitMs: 0 })
  const answer = async (at) => { t = at; counter.touch(); await counter.refresh() }
  await answer(0)
  items = [{ sessionId: 'a' }] // a half-loaded host: x is missing from this one answer only
  await answer(35_000)
  assert.equal(counter.isUnlisted('x'), false, 'one absent answer, however late, is not enough')
  await answer(36_000)
  assert.equal(counter.isUnlisted('x'), true, 'two absent answers over more than the span')
  items = [{ sessionId: 'a' }, { sessionId: 'x' }]
  await answer(37_000)
  assert.equal(counter.isUnlisted('x'), false)
})

// ---- batched flag writes (perf review)
test('store: updateMany patches several items with one change notification and one save', () => {
  const file = { writes: 0 }
  const store = createStore({ now: () => 1, io: { read: () => undefined, write: () => { file.writes++ } } })
  const a = store.add({ type: 'completed', sessionId: 'a' }); const b = store.add({ type: 'completed', sessionId: 'b' })
  store.resolve(a.id, { kind: 'reviewed' }); store.resolve(b.id, { kind: 'reviewed' })
  let changes = 0
  store.onChange(() => { changes++ })
  const w = file.writes
  const n = store.updateMany([{ id: a.id, patch: { sessionGone: true } }, { id: b.id, patch: { sessionGone: true } }, { id: 'nope', patch: { sessionGone: true } }])
  assert.equal(n, 2, 'unknown ids are skipped and not counted')
  assert.equal(store.get(a.id).sessionGone, true)
  assert.equal(store.get(b.id).sessionGone, true)
  assert.equal(changes, 1)
  assert.equal(file.writes - w, 1)
  assert.equal(store.updateMany([]), 0)
  assert.equal(changes, 1, 'nothing to patch, nothing announced')
})

test('service: one flag pass over many items is one store change', async () => {
  const { t, resolved, sessions, queue, store } = setup()
  for (let n = 0; n < 10; n++) resolved('missing')
  t.v += GRACE + 1
  queue.snapshot({ watch: true }); await sessions.refresh()
  queue.snapshot({ watch: true }); await sessions.refresh()
  let changes = 0
  store.onChange(() => { changes++ })
  queue.snapshot({ watch: true })
  assert.equal(store.list({ status: 'resolved' }).filter((i) => i.sessionGone === true).length, 10)
  assert.equal(changes, 1, 'ten flags, one notification')
})

test('store: updateMany skips malformed entries instead of throwing', () => {
  const store = createStore({ now: () => 1 })
  const a = store.add({ type: 'completed', sessionId: 'a' })
  assert.doesNotThrow(() => store.updateMany([null, undefined, 5, { id: a.id, patch: { summary: 'x' } }]))
  assert.equal(store.get(a.id).summary, 'x')
})

test('store: pick returns the ids of live items that pass the test, at most limit, without copying', () => {
  const store = createStore({ now: () => 1 })
  const ids = [1, 2, 3, 4].map((n) => store.add({ type: 'completed', sessionId: 's' + n }).id)
  assert.deepEqual(store.pick((i) => i.sessionId !== 's2', 2).length, 2)
  assert.deepEqual(store.pick((i) => i.sessionId === 's3', 10), [ids[2]])
  assert.deepEqual(store.pick(() => true, 0), [])
})

test('service: a flag pass with stale items does not clone the resolved items, and drains them in one batch', async () => {
  const { t, resolved, sessions, queue, store } = setup()
  for (let n = 0; n < 60; n++) resolved('missing')
  t.v += GRACE + 1
  queue.snapshot({ watch: true }); await sessions.refresh()
  queue.snapshot({ watch: true }); await sessions.refresh()
  const orig = store.list
  let copies = 0
  store.list = (arg) => { if (arg?.status === 'resolved') copies++; return orig(arg) }
  let changes = 0
  store.onChange(() => { changes++ })
  queue.snapshot({ watch: true })
  // store.snapshot() copies once itself; the flag pass adds no list() copy
  assert.equal(copies, 0)
  assert.equal(orig({ status: 'resolved' }).filter((i) => i.sessionGone === true).length, 60, 'all 60 in one pass')
  assert.equal(changes, 1)
})
