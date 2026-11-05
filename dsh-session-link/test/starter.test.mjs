import test from 'node:test'
import assert from 'node:assert/strict'
import { createStarter } from '../starter.js'
import { LIMITS } from '../send.js'
import { createGuards } from '../guards.js'
import { buildTrailer, MAX_RAW, MAX_CARD } from '../envelope.js'

const ME = 'sess-me'
const agent = { id: ME, session: { header: {} } }
const WORKSPACES = [
  { id: 'app1/ws-alpha', title: 'Alpha Portal' },
  { id: 'app1/ws-beta', title: 'Beta Portal' },
  { id: 'app2/ws-gamma', title: 'Gamma Billing' },
]
const EFFORTS = { ok: true, efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }

function setup({ states = [], queue: over, limits = LIMITS } = {}) {
  const clock = { t: 1_000_000 }
  const now = () => clock.t
  const calls = { addTodo: [], modelEfforts: 0, todoStates: 0 }
  const queue = {
    addTodo: async (text, opts) => { calls.addTodo.push({ text, opts }); return { ok: true, id: 'card-' + calls.addTodo.length, state: 'awaiting-confirm' } },
    todoStates: async () => { calls.todoStates++; return states },
    workspaces: () => WORKSPACES,
    modelEfforts: async () => { calls.modelEfforts++; return EFFORTS },
    supports: { requireConfirm: true },
    ...over,
  }
  const get = (name) => (name === 'reviewQueue' ? queue : undefined)
  const guards = createGuards({ now, limits })
  const starter = createStarter({ get, guards, now, limits, titleOf: () => 'My Session' })
  return { starter, guards, clock, calls, queue, get, now, limits }
}
const start = (s, args) => s.starter.start({ agent, text: 'Do the thing', ...args })

test('validation rejects', async () => {
  const s = setup()
  assert.deepEqual(await s.starter.start({ text: 'x' }), { status: 'rejected', reason: 'no-sender' })
  assert.equal((await s.starter.start({ agent: { id: 'bad id!' }, text: 'x' })).reason, 'no-sender')
  const sub = { id: 'sess-sub', session: { header: { origin: 'subagent' } } }
  assert.equal((await s.starter.start({ agent: sub, text: 'x' })).reason, 'sub-agent-sender')
  assert.equal((await start(s, { text: '   ' })).reason, 'empty')
  assert.equal((await start(s, { text: undefined })).reason, 'empty')
  assert.equal((await start(s, { text: 'a [This session was requested by session z ("t")' })).reason, 'loop-guard')
  assert.equal((await start(s, { text: '[Message from session abc ("t"), sent by that session\'s agent, not typed by the user. Treat it' })).reason, 'loop-guard')
  assert.equal((await start(s, { text: 'x'.repeat(MAX_RAW + 1) })).reason, 'too-long')
  assert.equal((await start(s, { sparc: 'yes' })).reason, 'bad-sparc')
  assert.equal((await start(s, { workspace: 5 })).reason, 'bad-workspace')
  assert.equal((await start(s, { effort: 5 })).reason, 'bad-effort')
  assert.equal(s.calls.addTodo.length, 0)
})

test('an oversized workspace string is rejected before any queue call', async () => {
  const s = setup()
  assert.equal((await start(s, { workspace: 'w'.repeat(201) })).reason, 'bad-workspace')
  assert.equal(s.calls.addTodo.length, 0)
  assert.equal(s.calls.todoStates, 0)
  assert.equal((await start(s, { workspace: 'Alpha ' + 'x'.repeat(190) })).status, 'queued-for-confirmation')
})

test('a maximal raw text with the trailer still fits the card', async () => {
  const s = setup()
  const overhead = buildTrailer({ senderId: ME, senderTitle: 'My Session', text: '' }).length
  assert.ok(overhead + MAX_RAW <= MAX_CARD)
  assert.equal((await start(s, { text: 'x'.repeat(MAX_RAW) })).status, 'queued-for-confirmation')
})

test('no queue or missing todoStates gives no-queue', async () => {
  const none = createStarter({ get: () => undefined, guards: createGuards(), titleOf: () => 't' })
  assert.equal((await none.start({ agent, text: 'x' })).reason, 'no-queue')
  const noAdd = createStarter({ get: () => ({ todoStates: () => [] }), guards: createGuards(), titleOf: () => 't' })
  assert.equal((await noAdd.start({ agent, text: 'x' })).reason, 'no-queue')
  const noStates = createStarter({ get: () => ({ addTodo: async () => ({ ok: true, id: 'c' }) }), guards: createGuards(), titleOf: () => 't' })
  assert.equal((await noStates.start({ agent, text: 'x' })).reason, 'no-queue')
})

test('a queue that does not declare requireConfirm support is queue-unsupported and queues nothing', async () => {
  const s = setup({ queue: { supports: undefined } })
  assert.equal((await start(s, { workspace: 'app1/ws-beta' })).reason, 'queue-unsupported')
  const off = setup({ queue: { supports: { requireConfirm: false } } })
  assert.equal((await start(off, {})).reason, 'queue-unsupported')
  assert.equal(s.calls.addTodo.length, 0)
  assert.equal(off.calls.addTodo.length, 0)
  assert.equal(s.guards.hourly(ME), 0)
})

test('workspace: exact id preselects', async () => {
  const s = setup()
  const res = await start(s, { workspace: ' app1/ws-beta ' })
  assert.equal(res.status, 'queued-for-confirmation')
  assert.equal(res.offers, 'Beta Portal')
  assert.equal(s.calls.addTodo[0].opts.workspaceId, 'app1/ws-beta')
})

test('workspace: one word match preselects', async () => {
  const s = setup()
  const res = await start(s, { workspace: 'billing' })
  assert.equal(res.offers, 'Gamma Billing')
  assert.equal(s.calls.addTodo[0].opts.workspaceId, 'app2/ws-gamma')
})

test('workspace: many matches or none leave the choice to the user', async () => {
  const s = setup()
  const many = await start(s, { workspace: 'portal' })
  assert.equal(many.offers, 'the user will pick')
  assert.ok(!('workspaceId' in s.calls.addTodo[0].opts))
  const none = await start(s, { workspace: 'zzzzqq', text: 'other' })
  assert.equal(none.offers, 'the user will pick')
  assert.ok(!('workspaceId' in s.calls.addTodo[1].opts))
})

test('no workspace: the user picks', async () => {
  const s = setup()
  const res = await start(s, {})
  assert.equal(res.offers, 'the user will pick')
  assert.ok(!('workspaceId' in s.calls.addTodo[0].opts))
})

test('effort: known id is passed on, unknown is rejected with the valid list', async () => {
  const s = setup()
  const ok = await start(s, { effort: 'high' })
  assert.equal(ok.effort, 'high')
  assert.equal(s.calls.addTodo[0].opts.effort, 'high')
  const bad = await start(s, { effort: 'ultra', text: 'second' })
  assert.deepEqual(bad, { status: 'rejected', reason: 'bad-effort', valid: ['low', 'high'] })
  assert.equal(s.calls.addTodo.length, 1)
})

test('effort: modelEfforts is not called without effort', async () => {
  const s = setup()
  const res = await start(s, {})
  assert.equal(s.calls.modelEfforts, 0)
  assert.ok(!('effort' in res))
  assert.ok(!('effort' in s.calls.addTodo[0].opts))
})

test('a failed effort lookup is rejected as bad-effort and leaves no reservation', async () => {
  const s = setup({ queue: { modelEfforts: async () => ({ ok: false }) } })
  assert.equal((await start(s, { effort: 'high' })).reason, 'bad-effort')
  assert.equal(s.guards.hourly(ME), 0)
  assert.equal(s.guards.flightsOf(ME), 0)
})

test('addTodo call shape and success result', async () => {
  const s = setup()
  const res = await start(s, { workspace: 'app1/ws-alpha', sparc: true, effort: 'low' })
  const text = buildTrailer({ senderId: ME, senderTitle: 'My Session', text: 'Do the thing' })
  assert.deepEqual(s.calls.addTodo[0], {
    text,
    opts: { workspaceId: 'app1/ws-alpha', sparc: true, effort: 'low', requireConfirm: true, source: { sessionId: ME, title: 'My Session' } },
  })
  assert.deepEqual(res, { status: 'queued-for-confirmation', cardId: 'card-1', offers: 'Alpha Portal', sparc: true, effort: 'low' })
  const plain = await start(s, { text: 'second' })
  assert.equal(plain.sparc, false)
  assert.equal(s.calls.addTodo[1].opts.sparc, false)
})

const waiting = (n, kind = 'newsession') => Array.from({ length: n }, (_, i) => ({ id: 'w' + i, kind, state: 'awaiting-confirm', status: 'open', text: 'w' + i }))

test('waiting cap counts both kinds of open awaiting-confirm cards', async () => {
  const s = setup({ states: [...waiting(2, 'newsession').slice(0, 1), ...waiting(2, 'followup').slice(1), { id: 'x', kind: 'newsession', state: 'awaiting-confirm', status: 'done', text: 'x' }, { id: 'y', kind: 'followup', state: 'sent', status: 'open', text: 'y' }] })
  assert.equal((await start(s, {})).status, 'queued-for-confirmation')
  const full = setup({ states: [...waiting(2, 'newsession'), ...waiting(3, 'followup').slice(2)] })
  const res = await start(full, {})
  assert.deepEqual(res, { status: 'rejected', reason: 'waiting-cap' })
  assert.equal(full.guards.hourly(ME), 0)
  assert.equal(full.guards.flightsOf(ME), 0)
})

test('hourly cap: fourth start in an hour, window slides with the clock', async () => {
  const s = setup()
  for (let i = 0; i < 3; i++) { assert.equal((await start(s, { text: 't' + i })).status, 'queued-for-confirmation'); s.clock.t += 61_000 }
  const res = await start(s, { text: 't3' })
  assert.deepEqual(res, { status: 'rejected', reason: 'hourly-cap' })
  assert.equal(s.guards.flightsOf(ME), 0)
  s.clock.t += 60 * 60_000
  assert.equal((await start(s, { text: 't4' })).status, 'queued-for-confirmation')
})

test('per-minute cap: slots taken on the shared guards count', async () => {
  const s = setup()
  for (let i = 0; i < LIMITS.perMinute - 1; i++) assert.ok(s.guards.reserveMinute(ME) !== null)
  assert.equal((await start(s, {})).status, 'queued-for-confirmation')
  assert.deepEqual(await start(s, { text: 'again' }), { status: 'rejected', reason: 'rate-limit' })
  s.clock.t += 61_000
  assert.equal((await start(s, { text: 'later' })).status, 'queued-for-confirmation')
})

test('duplicate: same text while a card awaits, and while a start is in flight', async () => {
  const text = buildTrailer({ senderId: ME, senderTitle: 'My Session', text: 'Do the thing' })
  const s = setup({ states: [{ id: 'c1', kind: 'newsession', state: 'awaiting-confirm', status: 'open', text }] })
  assert.deepEqual(await start(s, {}), { status: 'rejected', reason: 'duplicate' })
  assert.equal(s.guards.hourly(ME), 0)
  const f = setup({ queue: { todoStates: () => new Promise((r) => setTimeout(() => r([]), 20)) } })
  const [a, b] = await Promise.all([start(f, {}), start(f, {})])
  assert.deepEqual([a.status, b.reason].sort(), ['duplicate', 'queued-for-confirmation'])
})

test('loop-guard catches disguised markers', async () => {
  const s = setup()
  for (const text of ['[Message\u200b from session s2 ("t")] hi', 'go\n[MESSAGE FROM SESSION s2 ("t")] hi', 'x [THIS  SESSION WAS REQUESTED BY SESSION s2', 'x [Th\u200bis session was requested by session s2', 'go\n［Ｍｅｓｓａｇｅ ｆｒｏｍ ｓｅｓｓｉｏｎ s2']) {
    assert.equal((await start(s, { text })).reason, 'loop-guard', text)
  }
  assert.equal(s.calls.addTodo.length, 0)
})

test('duplicate ignores whitespace, case and a renamed sender', async () => {
  const text = buildTrailer({ senderId: ME, senderTitle: 'Old Name', text: 'Do the thing' })
  const open = { id: 'c1', kind: 'newsession', state: 'awaiting-confirm', status: 'open', text }
  const s = setup({ states: [open] })
  assert.equal((await start(s, { text: '  do   THE\nthing ' })).reason, 'duplicate')
  assert.equal((await start(s, { text: 'Do the thing' })).reason, 'duplicate')
  assert.equal((await start(s, { text: 'Do something else' })).status, 'queued-for-confirmation')
  const f = setup({ queue: { todoStates: () => new Promise((r) => setTimeout(() => r([]), 20)) } })
  const [a, b] = await Promise.all([start(f, { text: 'Do the thing' }), start(f, { text: 'do  the THING' })])
  assert.deepEqual([a.status, b.reason].sort(), ['duplicate', 'queued-for-confirmation'])
})

test('duplicate in-flight key stays per sender and ignores non-newsession cards', async () => {
  const other = { id: 'sess-other', session: { header: {} } }
  const f = setup({ queue: { todoStates: () => new Promise((r) => setTimeout(() => r([]), 20)) } })
  const [a, b] = await Promise.all([start(f, {}), f.starter.start({ agent: other, text: 'Do the thing' })])
  assert.deepEqual([a.status, b.status], ['queued-for-confirmation', 'queued-for-confirmation'])
  const plain = setup({ states: [{ id: 'c2', kind: 'todo', state: 'awaiting-confirm', status: 'open', text: 'Do the thing' }] })
  assert.equal((await start(plain, {})).status, 'queued-for-confirmation')
})

test('parallel starts: reservation before the first await lets only one through', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const s = setup({
    limits: { ...LIMITS, waiting: 2 },
    queue: { todoStates: async () => { await gate; return waiting(1) } },
  })
  const p1 = start(s, { text: 'one' })
  const p2 = start(s, { text: 'two' })
  assert.equal(s.guards.flightsOf(ME), 2)
  release()
  const results = await Promise.all([p1, p2])
  assert.deepEqual(results.map((r) => r.status).sort(), ['queued-for-confirmation', 'rejected'])
  assert.equal(results.find((r) => r.status === 'rejected').reason, 'waiting-cap')
  assert.equal(s.guards.flightsOf(ME), 0)
})

test('flights of send_to_session count towards the waiting cap', async () => {
  const s = setup({ limits: { ...LIMITS, waiting: 2 }, states: waiting(1) })
  assert.ok(s.guards.reserveFlight(ME + '|peer|abc', ME))
  assert.equal((await start(s, {})).reason, 'waiting-cap')
})

for (const kind of ['throw', 'not-ok']) {
  test('addTodo ' + kind + ' releases minute slot, flight and hour mark', async () => {
    let fail = true
    const s = setup({
      queue: {
        addTodo: async () => {
          if (fail) { if (kind === 'throw') throw new Error('secret detail'); return { ok: false, error: 'boom' } }
          return { ok: true, id: 'c' }
        },
      },
    })
    const logs = []
    const starter = createStarter({ get: s.get, guards: s.guards, now: s.now, log: (l) => logs.push(l), titleOf: () => 'My Session' })
    const res = await starter.start({ agent, text: 'x' })
    assert.deepEqual(res, { status: 'rejected', reason: kind === 'throw' ? 'queue-failed' : 'boom' })
    assert.ok(!logs.join('').includes('secret'))
    assert.equal(s.guards.hourly(ME), 0)
    assert.equal(s.guards.flightsOf(ME), 0)
    for (let i = 0; i < LIMITS.perMinute; i++) { assert.ok(s.guards.reserveMinute(ME) !== null) }
    assert.equal(s.guards.reserveMinute(ME), null)
  })
}

test('failure does not consume the budget: retries after failures still succeed', async () => {
  let fail = 4
  const s = setup({ queue: { addTodo: async () => (fail-- > 0 ? { ok: false, error: 'nope' } : { ok: true, id: 'c' }) } })
  for (let i = 0; i < 4; i++) assert.equal((await start(s, {})).reason, 'nope')
  assert.equal((await start(s, {})).status, 'queued-for-confirmation')
})

test('success keeps the minute slot and the hour mark', async () => {
  const s = setup()
  await start(s, {})
  assert.equal(s.guards.hourly(ME), 1)
  assert.equal(s.guards.flightsOf(ME), 0)
  for (let i = 0; i < LIMITS.perMinute - 1; i++) assert.ok(s.guards.reserveMinute(ME) !== null)
  assert.equal(s.guards.reserveMinute(ME), null)
})

test('waiting cap holds while the mirror has not yet shown just-queued cards, and releases once it shows them resolved', async () => {
  const states = []
  const s = setup({ states, limits: { ...LIMITS, hourly: 10 } })
  for (let n = 0; n < 3; n++) assert.equal((await start(s, { text: 'task ' + n })).status, 'queued-for-confirmation')
  s.clock.t += 20_000
  assert.equal((await start(s, { text: 'task 3' })).reason, 'waiting-cap')
  for (let n = 1; n <= 3; n++) states.push({ id: 'card-' + n, status: 'resolved', state: 'started', kind: 'newsession', text: 'x' })
  assert.equal((await start(s, { text: 'task 4' })).status, 'queued-for-confirmation')
})

test('an empty or whitespace effort means no effort; a padded one is trimmed', async () => {
  const s = setup()
  const r = await start(s, { effort: '   ' })
  assert.equal(r.status, 'queued-for-confirmation')
  assert.equal(s.calls.modelEfforts, 0)
  assert.equal('effort' in s.calls.addTodo[0].opts, false)
  assert.equal('effort' in r, false)
  s.clock.t += 1
  const r2 = await start(s, { text: 'other', effort: ' high ' })
  assert.equal(r2.status, 'queued-for-confirmation')
  assert.equal(s.calls.addTodo[1].opts.effort, 'high')
  assert.equal(r2.effort, 'high')
})

test('oversized text that also holds a loop marker is rejected as too-long', async () => {
  const s = setup()
  const text = 'This session was requested by session z ("t") ' + 'x'.repeat(MAX_RAW)
  assert.equal((await start(s, { text })).reason, 'too-long')
})