import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { createHubStore } from '../hub/hub-store.js'
import { createNotifier } from '../hub/notifier.js'
import { createPushStore } from '../hub/push.js'
import { b64u } from '../hub/webpush.js'
import { fakeClock } from './hub-helpers.mjs'

const keys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64u(e.getPublicKey()), auth: b64u(randomBytes(16)) } }
const START = Date.parse('2026-10-15T12:00:00Z')

/** A hub store, a push store with a recording sender, and a notifier on one fake clock; devices are given as { name, types?, quiet? }. */
function setup({ devices = [{ name: 'Pixel' }], presence = () => -Infinity, start = START, over = {} } = {}) {
  const clock = fakeClock(start)
  let n = 0
  const store = createHubStore({ now: clock.now, uuid: () => 'u' + ++n, timers: clock })
  const sent = []
  const logs = []
  const push = createPushStore({ now: clock.now, uuid: () => 'p' + ++n, sendPush: async (subscription, payload, opts) => { sent.push({ endpoint: subscription.endpoint, payload, opts, at: clock.now() }); return { ok: true, status: 201, gone: false } }, vapid: { publicKey: 'P', privateKey: 'K', subject: 'mailto:a@b.c' } })
  devices.forEach((d, i) => push.upsert({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/dev' + i, keys: keys() }, deviceId: 'dv_' + i, ...d }))
  const notifier = createNotifier({ store, push, now: clock.now, timers: clock, presence: (...a) => presence(...a), log: (l) => logs.push(l), ...over })
  const add = (type, extra = {}) => store.applyOp({ op: 'add', item: { type, sessionId: 's' + ++n, sessionTitle: 'Secret title', summary: 'Secret summary', payload: { reply: 'secret reply', summary: 'secret cmd', detail: 'secret detail', questions: [{ id: 'q', question: 'secret question?' }] }, ...extra } }, { owner: 'A1' }).id
  const settle = async () => { clock.advance(500); await Promise.resolve(); await new Promise((r) => setImmediate(r)) }
  return { clock, store, push, notifier, sent, logs, add, settle }
}
test('a new permission request pushes one notification: type and count only, tag = type, 12 h TTL, high urgency', async () => {
  const { add, sent, settle } = setup()
  const id = add('permission')
  await settle()
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].payload, { title: 'Permission waiting', body: '1 item', tag: 'permission', url: '#/item/' + id })
  assert.deepEqual([sent[0].opts.ttl, sent[0].opts.urgency, sent[0].opts.topic], [12 * 3600, 'high', 'permission'])
})

test('every type has its own words, tag and urgency (a question is as urgent as a permission, the rest is normal)', async () => {
  const { add, sent, settle, store } = setup()
  add('question'); await settle()
  add('pr-merged'); await settle()
  const done = add('completed'); await settle()
  store.applyOp({ op: 'update', id: done, patch: { actionable: true } }, { owner: 'A1' }); await settle()
  assert.deepEqual(sent.map((s) => [s.payload.title, s.payload.tag, s.opts.urgency]), [['Question waiting', 'question', 'high'], ['Pull request merged', 'pr-merged', 'normal'], ['Done', 'completed', 'normal']])
})

test('a second item of the same type replaces the first notification (same tag) and the count goes up', async () => {
  const { add, sent, settle } = setup()
  add('permission'); await settle()
  add('permission'); await settle()
  assert.deepEqual(sent.map((s) => [s.payload.tag, s.payload.body, s.payload.url]), [['permission', '1 item', sent[0].payload.url], ['permission', '2 items', '#/']])
})

test('items that arrive in one burst make one push with the count', async () => {
  const { add, sent, settle } = setup()
  add('permission'); add('permission'); add('permission')
  await settle()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.body, '3 items')
})

test('nothing the user wrote or the agent said ever goes into a push: no title, summary, command, question or reply', async () => {
  const { add, sent, settle, logs } = setup()
  for (const type of ['permission', 'question', 'pr-merged']) add(type)
  add('completed', { actionable: true })
  await settle()
  assert.ok(sent.length >= 3)
  const all = JSON.stringify(sent.map((s) => s.payload)) + logs.join('\n')
  for (const secret of ['Secret title', 'Secret summary', 'secret reply', 'secret cmd', 'secret detail', 'secret question', 'fcm.googleapis.com']) assert.ok(!all.includes(secret), secret)
})

test('todo items are never pushed, and items that were already open when the hub started are not announced again', async () => {
  const clock = fakeClock(START)
  const store = createHubStore({ now: clock.now, timers: clock })
  store.applyOp({ op: 'add', item: { type: 'permission', sessionId: 's0' } }, { owner: 'A1' })
  const sent = []
  const push = createPushStore({ now: clock.now, sendPush: async (s, p) => { sent.push(p); return { ok: true, status: 201, gone: false } }, vapid: { publicKey: 'P', privateKey: 'K', subject: 'mailto:a@b.c' } })
  push.upsert({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: keys() } })
  createNotifier({ store, push, now: clock.now, timers: clock, presence: () => -Infinity, log: () => {} })
  store.applyOp({ op: 'add', item: { type: 'todo', sessionId: 's1', text: 'do it' } }, { owner: 'A1' })
  clock.advance(1000); await new Promise((r) => setImmediate(r))
  assert.deepEqual(sent, [])
})

test('an item that is resolved before the push goes out is not pushed', async () => {
  const { add, store, sent, settle } = setup()
  const id = add('permission')
  store.resolve(id, { kind: 'approved' })
  await settle()
  assert.deepEqual(sent, [])
})

test('a device that switched a type off does not get it; the other devices do', async () => {
  const { add, sent, settle } = setup({ devices: [{ name: 'A', types: { permission: false } }, { name: 'B' }] })
  add('permission'); await settle()
  assert.deepEqual(sent.map((s) => s.endpoint), ['https://fcm.googleapis.com/fcm/send/dev1'])
})

test('no devices: nothing is sent, and a phone that subscribes later is not told about old items', async () => {
  const { add, push, sent, settle } = setup({ devices: [] })
  add('permission'); await settle()
  push.upsert({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/late', keys: keys() } })
  await settle()
  assert.deepEqual(sent, [])
})

// ---- presence ----------------------------------------------------------------------------------------------------------------------

test('while the desktop overlay was looked at in the last 60 s the push is held; it goes out 60 s after the last look if the item is still open', async () => {
  let seen = START
  const { add, sent, clock, settle } = setup({ presence: () => seen })
  add('permission'); await settle()
  assert.deepEqual(sent, [], 'held')
  clock.advance(30_000); seen = clock.now()
  clock.advance(59_000); await settle()
  assert.deepEqual(sent, [], 'a newer look moved the hold on')
  clock.advance(2000); await settle()
  assert.equal(sent.length, 1)
  assert.ok(sent[0].at >= seen + 60_000)
})

test('a held item that is answered on the desktop within the hold is never pushed', async () => {
  const { add, store, sent, clock, settle } = setup({ presence: () => START })
  const id = add('permission'); await settle()
  store.resolve(id, { kind: 'approved', by: 'card' })
  clock.advance(120_000); await settle()
  assert.deepEqual(sent, [])
})

test('no look at all within 60 s: pushed at once', async () => {
  const { add, sent, settle } = setup({ presence: () => START - 61_000 })
  add('permission'); await settle()
  assert.equal(sent.length, 1)
})

// ---- the done verdict --------------------------------------------------------------------------------------------------------------

test('a finished message is pushed only after the actionable verdict: not at capture time', async () => {
  const { add, store, sent, settle } = setup()
  const id = add('completed', { summarySource: 'fallback' }); await settle()
  assert.deepEqual(sent, [], 'no verdict yet')
  store.applyOp({ op: 'update', id, patch: { summary: 'x', summarySource: 'llm', actionable: true } }, { owner: 'A1' }); await settle()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.tag, 'completed')
})

test('a "no action" verdict hides the item and it is never pushed', async () => {
  const { add, store, sent, clock, settle } = setup()
  const id = add('completed', { summarySource: 'fallback' }); await settle()
  store.applyOp({ op: 'update', id, patch: { actionable: false } }, { owner: 'A1' })
  store.resolve(id, { kind: 'no-action', by: 'auto' })
  clock.advance(120_000); await settle()
  assert.deepEqual(sent, [])
})

test('an answer without a verdict (the model did not say) is shown, so it is pushed; so is a model failure after the summary timeout', async () => {
  const a = setup()
  const id = a.add('completed', { summarySource: 'fallback' }); await a.settle()
  a.store.applyOp({ op: 'update', id, patch: { summarySource: 'llm' } }, { owner: 'A1' }); await a.settle()
  assert.equal(a.sent.length, 1, 'llm answered without a verdict')
  const b = setup()
  b.add('completed', { summarySource: 'fallback' }); await b.settle()
  assert.deepEqual(b.sent, [])
  b.clock.advance(20_000); await b.settle()
  assert.equal(b.sent.length, 1, 'no verdict after the grace: it is shown, so it is pushed')
})

// ---- quiet hours ---------------------------------------------------------------------------------------------------------------------

const NIGHT = { enabled: true, start: '22:00', end: '07:00', tz: 'UTC' }
const AT_23 = Date.parse('2026-10-15T23:00:00Z')

test('quiet hours: a permission request and a question still come through', async () => {
  const { add, sent, settle } = setup({ devices: [{ name: 'A', quiet: NIGHT }], start: AT_23 })
  add('permission'); add('question'); await settle()
  assert.deepEqual(sent.map((s) => s.payload.tag).sort(), ['permission', 'question'])
})

test('quiet hours: done and merged wait and arrive as one count-only digest when the quiet hours end', async () => {
  const { add, sent, clock, settle } = setup({ devices: [{ name: 'A', quiet: NIGHT }], start: AT_23 })
  add('pr-merged'); add('completed', { actionable: true }); add('completed', { actionable: true }); await settle()
  assert.deepEqual(sent, [], 'held for the night')
  clock.advance(8 * 3600_000 + 5000); await settle()
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].payload, { title: 'Task list', body: '2 done, 1 PR merged waiting', tag: 'digest', url: '#/' })
  assert.equal(sent[0].opts.urgency, 'normal')
})

test('the digest counts only what is still open when it goes out, and nothing is sent when nothing is', async () => {
  const { add, store, sent, clock, settle } = setup({ devices: [{ name: 'A', quiet: NIGHT }], start: AT_23 })
  const a = add('pr-merged'); add('completed', { actionable: true }); await settle()
  store.resolve(a, { kind: 'reviewed' })
  clock.advance(8 * 3600_000); await settle()
  assert.equal(sent[0].payload.body, '1 done waiting')
  const other = setup({ devices: [{ name: 'A', quiet: NIGHT }], start: AT_23 })
  const c = other.add('pr-merged'); await other.settle()
  other.store.resolve(c, { kind: 'reviewed' })
  other.clock.advance(8 * 3600_000); await other.settle()
  assert.deepEqual(other.sent, [])
})

test('quiet hours belong to the device: a device without them gets the push at once while another waits', async () => {
  const { add, sent, settle } = setup({ devices: [{ name: 'A', quiet: NIGHT }, { name: 'B' }], start: AT_23 })
  add('pr-merged'); await settle()
  assert.deepEqual(sent.map((s) => s.endpoint), ['https://fcm.googleapis.com/fcm/send/dev1'])
})

// ---- robustness -----------------------------------------------------------------------------------------------------------------------

test('a sender that fails does not break the notifier or the next push; the log says counts and types only', async () => {
  let fail = true
  const clock = fakeClock(START)
  const store = createHubStore({ now: clock.now, timers: clock })
  const logs = []
  const sent = []
  const push = createPushStore({ now: clock.now, sendPush: async (s, p) => { if (fail) throw new Error('boom https://fcm.googleapis.com/fcm/send/x'); sent.push(p); return { ok: true, status: 201, gone: false } }, vapid: { publicKey: 'P', privateKey: 'K', subject: 'mailto:a@b.c' } })
  push.upsert({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: keys() } })
  createNotifier({ store, push, now: clock.now, timers: clock, presence: () => -Infinity, log: (l) => logs.push(l) })
  store.applyOp({ op: 'add', item: { type: 'permission', sessionId: 's1' } }, { owner: 'A1' })
  clock.advance(500); await new Promise((r) => setImmediate(r))
  fail = false
  store.applyOp({ op: 'add', item: { type: 'permission', sessionId: 's2' } }, { owner: 'A1' })
  clock.advance(500); await new Promise((r) => setImmediate(r))
  assert.equal(sent.length, 1)
  assert.ok(!logs.join('\n').includes('fcm.googleapis.com'))
})

test('dispose stops everything: later items and pending holds send nothing', async () => {
  const { add, sent, notifier, clock, settle } = setup({ presence: () => START })
  add('permission')
  notifier.dispose()
  clock.advance(120_000); await settle()
  add('question'); await settle()
  assert.deepEqual(sent, [])
})
