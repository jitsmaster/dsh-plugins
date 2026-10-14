// Alerts that arrive while a voice flow runs are not lost: they are held (bounded, expiring) and spoken once the flow is over.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeferredAlerts, capHeldBody, permissionAlertRelevant, permissionIsPending, alertRelevant, questionAlertRelevant } from '../voice/deferred-alerts.js'

function make(over = {}) {
  const h = { busy: false, enabled: true, t: 0, played: [], logs: [] }
  h.alerts = createDeferredAlerts({
    busy: () => h.busy,
    enabled: () => h.enabled,
    play: (item) => { h.played.push(item) },
    now: () => h.t,
    log: (e) => h.logs.push(e),
    ...over,
  })
  return h
}

test('A1 a held alert is not played while the flow is busy and is played once it is over, in arrival order', async () => {
  const h = make()
  h.busy = true
  h.alerts.defer('one')
  h.alerts.defer('two')
  await h.alerts.flush()
  assert.deepEqual(h.played, [])
  assert.equal(h.alerts.size(), 2)
  h.busy = false
  await h.alerts.flush()
  assert.deepEqual(h.played, ['one', 'two'])
  assert.equal(h.alerts.size(), 0)
  await h.alerts.flush()
  assert.deepEqual(h.played, ['one', 'two'], 'played once')
})

test('A2 an alert older than maxAgeMs is dropped instead of being read out late', async () => {
  const h = make({ maxAgeMs: 90_000 })
  h.alerts.defer('old')
  h.t = 89_999
  h.alerts.defer('fresh')
  h.t = 90_001
  await h.alerts.flush()
  assert.deepEqual(h.played, ['fresh'])
})

test('A3 the queue is bounded: the oldest alerts are dropped first', async () => {
  const h = make({ max: 3 })
  for (const x of ['a', 'b', 'c', 'd', 'e']) h.alerts.defer(x)
  assert.equal(h.alerts.size(), 3)
  await h.alerts.flush()
  assert.deepEqual(h.played, ['c', 'd', 'e'])
})

test('A4 with read-outs switched off, held alerts are discarded, not replayed later', async () => {
  const h = make()
  h.alerts.defer('x')
  h.enabled = false
  await h.alerts.flush()
  assert.deepEqual(h.played, [])
  assert.equal(h.alerts.size(), 0)
  h.enabled = true
  await h.alerts.flush()
  assert.deepEqual(h.played, [])
})

test('A5 a throwing play() never breaks the rest of the flush', async () => {
  const h = make({ play: (item) => { if (item === 'bad') throw new Error('boom'); h.played.push(item) } })
  h.alerts.defer('bad')
  h.alerts.defer('good')
  await assert.doesNotReject(async () => h.alerts.flush())
  assert.deepEqual(h.played, ['good'])
})

test('A6 a throwing busy() or defer of nothing is harmless; clear() empties the queue', async () => {
  const h = make({ busy: () => { throw new Error('x') } })
  h.alerts.defer('a')
  await assert.doesNotReject(async () => h.alerts.flush())
  assert.equal(h.alerts.size(), 1, 'kept when busy cannot be read')
  h.alerts.clear()
  assert.equal(h.alerts.size(), 0)
})


test('A7 an alert that is no longer relevant when the flow ends (its request was answered meanwhile) is not replayed', async () => {
  const h = make({ relevant: (item) => item !== 'answered' })
  h.alerts.defer('answered')
  h.alerts.defer('still pending')
  await h.alerts.flush()
  assert.deepEqual(h.played, ['still pending'])
  assert.equal(h.logs.some((l) => l.stage === 'dropped-stale'), true)
})

test('A18 a throwing relevant() keeps the alert (better a late alert than a lost one)', async () => {
  const h = make({ relevant: () => { throw new Error('x') } })
  h.alerts.defer('a')
  await h.alerts.flush()
  assert.deepEqual(h.played, ['a'])
})

const alert = (sessionId, event, extra = {}) => ({ sessionId, event, ...extra })

test('A8 held alerts are deduped per (session, event): the newest replaces the older one and takes the later place', async () => {
  const h = make()
  h.alerts.defer(alert('a', 'Stop', { n: 1 }))
  h.alerts.defer(alert('b', 'Stop', { n: 2 }))
  h.alerts.defer(alert('a', 'Stop', { n: 3 }))
  h.alerts.defer(alert('a', 'PermissionRequest', { n: 4 }))
  assert.equal(h.alerts.size(), 3, 'a Stop and a PermissionRequest of the same session are different alerts')
  await h.alerts.flush()
  assert.deepEqual(h.played.map((p) => p.n), [2, 3, 4])
})

test('A19 items without a session and event are never deduped', async () => {
  const h = make()
  h.alerts.defer('x'); h.alerts.defer('x')
  assert.equal(h.alerts.size(), 2)
})

test('A9 over capacity the oldest non-permission alert is evicted first, even when a permission alert is older', async () => {
  const h = make({ max: 3 })
  h.alerts.defer(alert('p', 'PermissionRequest', { n: 1 }))
  h.alerts.defer(alert('a', 'Stop', { n: 2 }))
  h.alerts.defer(alert('b', 'Stop', { n: 3 }))
  h.alerts.defer(alert('c', 'Stop', { n: 4 }))
  assert.equal(h.alerts.size(), 3)
  await h.alerts.flush()
  assert.deepEqual(h.played.map((p) => p.n), [1, 3, 4])
  assert.equal(h.logs.some((l) => l.stage === 'dropped-overflow'), true)
})

test('A10 a Stop alert never evicts a PermissionRequest alert: when only permission alerts are held, the new Stop is the one dropped', async () => {
  const h = make({ max: 2 })
  h.alerts.defer(alert('p1', 'PermissionRequest', { n: 1 }))
  h.alerts.defer(alert('p2', 'PermissionRequest', { n: 2 }))
  h.alerts.defer(alert('s', 'Stop', { n: 3 }))
  assert.equal(h.alerts.size(), 2)
  await h.alerts.flush()
  assert.deepEqual(h.played.map((p) => p.n), [1, 2])
})

test('A20 a permission alert may only push out an older permission alert when nothing else can go', async () => {
  const h = make({ max: 2 })
  h.alerts.defer(alert('p1', 'PermissionRequest', { n: 1 }))
  h.alerts.defer(alert('p2', 'PermissionRequest', { n: 2 }))
  h.alerts.defer(alert('p3', 'PermissionRequest', { n: 3 }))
  await h.alerts.flush()
  assert.deepEqual(h.played.map((p) => p.n), [2, 3])
})

test('A11 a permission alert stays relevant when voice is off or its request was never tracked; otherwise the tool must still be pending', async () => {
  const item = (tool, tracked) => ({ event: 'PermissionRequest', sessionId: 's', body: { tool_name: tool }, tracked })
  const pending = [{ sessionId: 's', toolName: 'pwsh' }]
  assert.equal(permissionAlertRelevant(item('pwsh', true), { voiceOn: true, pending }), true, 'still pending')
  assert.equal(permissionAlertRelevant(item('pwsh', true), { voiceOn: true, pending: [{ sessionId: 's', toolName: 'write' }] }), false, 'another tool is pending: this request was answered')
  assert.equal(permissionAlertRelevant(item('pwsh', true), { voiceOn: true, pending: [] }), false, 'answered')
  assert.equal(permissionAlertRelevant(item('pwsh', true), { voiceOn: false, pending: [] }), true, 'voice off: nothing is tracked, so cannot tell')
  assert.equal(permissionAlertRelevant(item('pwsh', false), { voiceOn: true, pending: [] }), true, 'never tracked: cannot tell')
  assert.equal(permissionAlertRelevant({ event: 'Stop', sessionId: 's', body: {} }, { voiceOn: true, pending: [] }), true, 'only permission alerts go stale')
  assert.equal(permissionIsPending(item('pwsh'), pending), true)
  assert.equal(permissionIsPending(item('write'), pending), false)
  assert.equal(permissionIsPending({ event: 'PermissionRequest', sessionId: 's', body: {} }, pending), false, 'no tool name to compare')
})

test('A12 a held hook body is capped at ~8 KB: tool_input and last_assistant_message are truncated when it is deferred, the rest is kept', async () => {
  const h = make()
  const big = 'x'.repeat(100_000)
  h.alerts.defer(alert('a', 'Stop', { body: { headline: 'Done', session_id: 's', last_assistant_message: big, tool_input: { command: big } } }))
  h.alerts.defer(alert('b', 'PermissionRequest', { body: { headline: 'Approve?', tool_name: 'pwsh', tool_input: big } }))
  await h.alerts.flush()
  const [stop, perm] = h.played.map((p) => p.body)
  assert.equal(stop.headline, 'Done')
  assert.equal(stop.session_id, 's')
  assert.ok(Buffer.byteLength(JSON.stringify(stop)) < 20_000, 'the stored body is small')
  assert.ok(stop.last_assistant_message.length <= 8192 && stop.last_assistant_message.length > 8000)
  assert.equal(typeof stop.tool_input, 'string', 'an oversized object is stored as truncated JSON text')
  assert.ok(stop.tool_input.length <= 8192)
  assert.equal(perm.tool_name, 'pwsh')
  assert.ok(perm.tool_input.length <= 8192)
  assert.equal(h.logs.some((l) => l.stage === 'body-truncated'), true)
})

test('A21 small bodies are kept as they are (same object contents), and multi-byte text is cut by bytes without a broken last character', async () => {
  const small = { headline: 'x', tool_input: { command: 'ls' }, last_assistant_message: 'done' }
  assert.deepEqual(capHeldBody(small), small)
  const wide = capHeldBody({ last_assistant_message: '\u4E2D'.repeat(10_000) })
  assert.ok(Buffer.byteLength(wide.last_assistant_message) <= 8192)
  assert.doesNotMatch(wide.last_assistant_message, /\uFFFD/)
  assert.equal(capHeldBody('not an object'), 'not an object')
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('A13 flush plays the held alerts one after another in arrival order: the next launcher starts only after the previous one finished', async () => {
  const events = []
  const releases = []
  const h = make({ play: (item) => { events.push('start ' + item); return new Promise((r) => releases.push(() => { events.push('end ' + item); r() })) } })
  h.alerts.defer('a'); h.alerts.defer('b'); h.alerts.defer('c')
  const done = h.alerts.flush()
  await sleep(5)
  assert.deepEqual(events, ['start a'], 'b waits for a')
  releases.shift()()
  await sleep(5)
  assert.deepEqual(events, ['start a', 'end a', 'start b'])
  releases.shift()()
  await sleep(5)
  releases.shift()()
  await done
  assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  assert.equal(h.alerts.size(), 0)
})

test('A22 a second flush while one is running does not play anything twice', async () => {
  const played = []
  let release
  const h = make({ play: (item) => { played.push(item); return new Promise((r) => { release = r }) } })
  h.alerts.defer('a'); h.alerts.defer('b')
  const first = h.alerts.flush()
  const second = h.alerts.flush()
  await sleep(5)
  assert.deepEqual(played, ['a'])
  release(); await sleep(5); release()
  await Promise.all([first, second])
  assert.deepEqual(played, ['a', 'b'])
})

test('A14 when a flow starts again while the flush runs, the remaining alerts stay held (and expire by their own age) and play after it ends', async () => {
  const h = make({ play: (item) => { h.played.push(item); if (item === 'a') h.busy = true } })
  h.alerts.defer('a'); h.alerts.defer('b'); h.alerts.defer('c')
  await h.alerts.flush()
  assert.deepEqual(h.played, ['a'], 'the flow started again after a: b and c are not spoken into the open mic')
  assert.equal(h.alerts.size(), 2)
  h.busy = false
  h.t = 89_000
  await h.alerts.flush()
  assert.deepEqual(h.played, ['a', 'b', 'c'])

  const g = make({ play: (item) => { g.played.push(item); g.t += 100_000 } }) // each launcher takes 100 s of the clock
  g.alerts.defer('x'); g.alerts.defer('y')
  await g.alerts.flush()
  assert.deepEqual(g.played, ['x'], 'y is older than maxAgeMs by the time its turn comes')
  assert.equal(g.logs.some((l) => l.stage === 'dropped-expired'), true)
})

test('A23 relevance is re-checked per item, at its own turn', async () => {
  const answered = new Set()
  const h = make({ relevant: (item) => !answered.has(item), play: (item) => { h.played.push(item); answered.add('b') } })
  h.alerts.defer('a'); h.alerts.defer('b')
  await h.alerts.flush()
  assert.deepEqual(h.played, ['a'], 'b was answered while a was being launched')
})

test('A15 a launcher that never finishes does not block the alerts behind it for ever', async () => {
  const h = make({ playTimeoutMs: 20, play: (item) => { h.played.push(item); return item === 'stuck' ? new Promise(() => {}) : undefined } })
  h.alerts.defer('stuck'); h.alerts.defer('next')
  await h.alerts.flush()
  assert.deepEqual(h.played, ['stuck', 'next'])
  assert.equal(h.logs.some((l) => l.stage === 'play-timeout'), true)
})

test('A24 a rejecting async launcher is logged and the rest still plays', async () => {
  const h = make({ play: async (item) => { if (item === 'bad') throw new Error('boom'); h.played.push(item) } })
  h.alerts.defer('bad'); h.alerts.defer('good')
  await h.alerts.flush()
  assert.deepEqual(h.played, ['good'])
  assert.equal(h.logs.some((l) => l.stage === 'play-failed'), true)
})

test('A16 only alerts that really get replayed reach play(), in order: a deduped, evicted or expired held alert never does (so it never becomes lastAlerted)', async () => {
  const noted = []
  const h = make({ play: (item) => { noted.push(item.n) } })
  h.alerts.defer(alert('a', 'Stop', { n: 1 }))        // replaced by n 2 (dedupe)
  h.alerts.defer(alert('a', 'Stop', { n: 2 }))        // expires
  h.alerts.defer(alert('e', 'Stop', { n: 3 }))        // expires
  h.t = 80_000
  h.alerts.defer(alert('b', 'Stop', { n: 4 }))
  h.t = 95_000
  await h.alerts.flush()
  assert.deepEqual(noted, [4])
  const g = make({ max: 2, play: (item) => { noted.push(item.n) } })
  g.alerts.defer(alert('s1', 'Stop', { n: 11 }))      // evicted by the third
  g.alerts.defer(alert('s2', 'Stop', { n: 12 }))
  g.alerts.defer(alert('s3', 'Stop', { n: 13 }))
  await g.alerts.flush()
  assert.deepEqual(noted, [4, 12, 13])
})

test('A17 a body whose tool_input cannot be serialised is never held uncapped: the field is replaced by an empty string', () => {
  const loop = { big: 'x'.repeat(100_000) }
  loop.self = loop
  const out = capHeldBody({ headline: 'h', tool_name: 'pwsh', tool_input: loop, last_assistant_message: 'ok' })
  assert.equal(out.tool_input, '')
  assert.equal(out.headline, 'h')
  assert.equal(out.tool_name, 'pwsh')
  assert.equal(out.last_assistant_message, 'ok')
  const big = { toJSON() { throw new Error('nope') }, pad: 'x'.repeat(100_000) }
  assert.equal(capHeldBody({ tool_input: big }).tool_input, '')
  assert.equal(capHeldBody({ tool_input: 10n }).tool_input, '', 'a BigInt cannot be stringified either')
})

test('Q1 a held question alert is stale once its call is no longer pending; untracked, voice-off and other kinds are relevant', () => {
  const item = { sessionId: 's1', event: 'PreToolUse', question: true, callId: 'c1', tracked: true }
  const on = { voiceOn: true, pendingQuestions: [{ sessionId: 's1', callId: 'c1' }] }
  assert.equal(questionAlertRelevant(item, on), true, 'still pending')
  assert.equal(questionAlertRelevant(item, { ...on, pendingQuestions: [] }), false, 'answered meanwhile')
  assert.equal(questionAlertRelevant(item, { ...on, pendingQuestions: [{ sessionId: 's1', callId: 'c2' }] }), false, 'another call of the session is not this one')
  assert.equal(questionAlertRelevant(item, { ...on, pendingQuestions: [{ sessionId: 's2', callId: 'c1' }] }), false, 'same call id in another session is not this one')
  assert.equal(questionAlertRelevant(item, { voiceOn: false, pendingQuestions: [] }), true, 'voice off: nothing says it was answered')
  assert.equal(questionAlertRelevant({ ...item, tracked: false }, { ...on, pendingQuestions: [] }), true, 'never tracked')
  assert.equal(questionAlertRelevant({ sessionId: 's1', event: 'Stop' }, { ...on, pendingQuestions: [] }), true, 'a Stop alert is never judged stale')
  assert.equal(questionAlertRelevant(undefined, on), true)
})

test('Q2 alertRelevant combines the permission and question rules', () => {
  const state = { voiceOn: true, pending: [], pendingQuestions: [] }
  assert.equal(alertRelevant({ sessionId: 's', event: 'PermissionRequest', tracked: true, body: { tool_name: 'pwsh' } }, state), false)
  assert.equal(alertRelevant({ sessionId: 's', event: 'PreToolUse', question: true, callId: 'c', tracked: true }, state), false)
  assert.equal(alertRelevant({ sessionId: 's', event: 'Stop' }, state), true)
})
