import test from 'node:test'
import assert from 'node:assert/strict'
import { createArchiver } from '../archiver.js'
import { createGuards } from '../guards.js'

const ME = 'sess-me'
const agent = { id: ME, session: { header: { cwd: 'D:\\dev\\ai\\proj' } } }
const LIMITS = { perMinute: 5, windowMs: 60_000, archiveMs: 60_000 }

function setup({ queue: over, noQueue = false, titleOf = () => 'My Session' } = {}) {
  const clock = { t: 1_000_000 }
  const calls = []
  const logs = []
  const queue = noQueue ? undefined : {
    offerArchive: (info) => { calls.push(info); return { ok: true, id: 'card-' + calls.length } },
    archiveOfferEnabled: () => true,
    supports: { requireConfirm: true, offerArchive: true },
    ...over,
  }
  const get = (name) => (name === 'reviewQueue' ? queue : undefined)
  const guards = createGuards({ now: () => clock.t, limits: LIMITS })
  const archiver = createArchiver({ get, titleOf, guards, log: (m) => logs.push(String(m)) })
  return { archiver, guards, clock, calls, logs, queue }
}
const offer = (s, args) => s.archiver.offer({ agent, message: 'Finished the guard work, nothing is waiting.', ...args })

test('a valid call sends exactly the four fields and returns offered', async () => {
  const s = setup()
  const res = await offer(s, {})
  assert.deepEqual(res, { status: 'offered', cardId: 'card-1', updated: false })
  assert.deepEqual(s.calls, [{ sessionId: ME, sessionTitle: 'My Session', workspace: 'D:\\dev\\ai\\proj', reason: 'Finished the guard work, nothing is waiting.' }])
})

test('updated passes through when the queue refreshed an open card', async () => {
  const s = setup({ queue: { offerArchive: () => ({ ok: true, id: 'card-9', updated: true }) } })
  assert.deepEqual(await offer(s, {}), { status: 'offered', cardId: 'card-9', updated: true })
})

test('a session without a working directory sends an undefined workspace', async () => {
  const s = setup()
  await s.archiver.offer({ agent: { id: ME, session: { header: {} } }, message: 'done' })
  assert.equal(s.calls[0].workspace, undefined)
})

test('the title sent to the queue is cleaned', async () => {
  const s = setup({ titleOf: () => '\u202eevil\u200b "title"\u3164 [x]' })
  await offer(s, {})
  assert.equal(s.calls[0].sessionTitle, 'evil title x')
})

test('the message is collapsed to one line, stripped of control characters and clipped to 200', async () => {
  const s = setup()
  await offer(s, { message: '  did   the\n thing\u0000\t\u202e well\r\n  ' })
  assert.equal(s.calls[0].reason, 'did the thing well')
  s.clock.t += 60_000
  await offer(s, { message: 'x'.repeat(300) })
  assert.equal(s.calls[1].reason.length, 200)
})

test('an empty or non-string message is rejected before any queue call and costs no slot', async () => {
  const s = setup()
  for (const message of ['', '   ', '\n\t', '\u0000\u200b', '\u3164\u2800\ufe0f', undefined, 5, null, {}, ['x']]) {
    assert.deepEqual(await offer(s, { message }), { status: 'rejected', reason: 'empty' }, String(message))
  }
  assert.equal(s.calls.length, 0)
  assert.equal(s.guards.sizes().archives, 0)
})

test('no sender and sub-agent senders are rejected', async () => {
  const s = setup()
  assert.deepEqual(await s.archiver.offer({ message: 'x' }), { status: 'rejected', reason: 'no-sender' })
  assert.equal((await s.archiver.offer({ agent: { id: 'bad id!' }, message: 'x' })).reason, 'no-sender')
  const byOrigin = { id: 'sess-sub', session: { header: { origin: 'subagent' } } }
  const byParent = { id: 'sess-sub2', session: { header: { parentSession: 'sess-me' } } }
  assert.equal((await s.archiver.offer({ agent: byOrigin, message: 'x' })).reason, 'sub-agent-sender')
  assert.equal((await s.archiver.offer({ agent: byParent, message: 'x' })).reason, 'sub-agent-sender')
  assert.equal(s.calls.length, 0)
})

test('a missing queue, or one without archive support, is rejected', async () => {
  assert.equal((await offer(setup({ noQueue: true }), {})).reason, 'no-queue')
  const noMethod = setup({ queue: { offerArchive: undefined } })
  assert.equal((await offer(noMethod, {})).reason, 'queue-unsupported')
  const oldQueue = setup({ queue: { supports: { requireConfirm: true } } })
  assert.equal((await offer(oldQueue, {})).reason, 'queue-unsupported')
  assert.equal(oldQueue.calls.length, 0)
  const noSupports = setup({ queue: { supports: undefined } })
  assert.equal((await offer(noSupports, {})).reason, 'queue-unsupported')
  const falsy = setup({ queue: { supports: { offerArchive: 'yes' } } })
  assert.equal((await offer(falsy, {})).reason, 'queue-unsupported')
})

test('disabled answers disabled, never reaches the queue and does not use the rate limit', async () => {
  let enabled = false
  const s = setup({ queue: { archiveOfferEnabled: () => enabled } })
  assert.deepEqual(await offer(s, {}), { status: 'rejected', reason: 'disabled' })
  assert.equal(s.calls.length, 0)
  assert.equal(s.guards.sizes().archives, 0)
  enabled = true
  assert.equal((await offer(s, {})).status, 'offered')
})

test('a queue that declares offerArchive support but has no archiveOfferEnabled is queue-unsupported (the switch cannot be bypassed)', async () => {
  const s = setup({ queue: { archiveOfferEnabled: undefined } })
  assert.deepEqual(await offer(s, {}), { status: 'rejected', reason: 'queue-unsupported' })
  assert.equal(s.calls.length, 0)
  assert.equal(s.guards.sizes().archives, 0)
})

test('only an explicit true from archiveOfferEnabled() enables the offer (fails closed)', async () => {
  for (const value of [undefined, null, 0, '', 'yes', {}]) {
    const s = setup({ queue: { archiveOfferEnabled: () => value } })
    assert.deepEqual(await offer(s, {}), { status: 'rejected', reason: 'disabled' }, String(value))
    assert.equal(s.calls.length, 0)
    assert.equal(s.guards.sizes().archives, 0)
  }
})

test('a throwing archiveOfferEnabled() is answered queue-failed, logged briefly, and costs no slot', async () => {
  let boom = true
  const s = setup({ queue: { archiveOfferEnabled: () => { if (boom) throw new Error('secret boom C:\\private'); return true } } })
  assert.deepEqual(await offer(s, {}), { status: 'rejected', reason: 'queue-failed' })
  assert.deepEqual(s.logs, ['session-link: archiveOfferEnabled failed'])
  assert.equal(s.calls.length, 0)
  assert.equal(s.guards.sizes().archives, 0)
  boom = false
  assert.equal((await offer(s, {})).status, 'offered')
})

test('a second offer inside 60 s is rate limited, then allowed again', async () => {
  const s = setup()
  assert.equal((await offer(s, {})).status, 'offered')
  assert.deepEqual(await offer(s, {}), { status: 'rejected', reason: 'rate-limit' })
  s.clock.t += 59_999
  assert.equal((await offer(s, {})).reason, 'rate-limit')
  s.clock.t += 1
  assert.equal((await offer(s, {})).status, 'offered')
  assert.equal(s.calls.length, 2)
})

test('the rate limit is per session', async () => {
  const s = setup()
  assert.equal((await offer(s, {})).status, 'offered')
  const other = { id: 'sess-other', session: { header: {} } }
  assert.equal((await s.archiver.offer({ agent: other, message: 'done' })).status, 'offered')
})

test('parallel calls of one session reserve the slot before the first await', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const s = setup({ queue: { offerArchive: async (info) => { await gate; return { ok: true, id: 'card-p' } } } })
  const first = offer(s, {})
  const second = offer(s, {})
  assert.deepEqual(await second, { status: 'rejected', reason: 'rate-limit' })
  release()
  assert.equal((await first).status, 'offered')
})

test('the slot is released when the queue throws or answers not ok, and kept after success', async () => {
  let mode = 'throw'
  const s = setup({ queue: { offerArchive: () => {
    if (mode === 'throw') throw new Error('secret boom C:\\private')
    if (mode === 'notok') return { ok: false, error: 'bad-input' }
    return { ok: true, id: 'card-ok' }
  } } })
  assert.deepEqual(await offer(s, {}), { status: 'rejected', reason: 'queue-failed' })
  mode = 'notok'
  assert.deepEqual(await offer(s, {}), { status: 'rejected', reason: 'bad-input' })
  mode = 'ok'
  assert.equal((await offer(s, {})).status, 'offered')
  assert.equal((await offer(s, {})).reason, 'rate-limit')
})

test('a queue answer without ok or with a non-string error becomes queue-failed', async () => {
  const s = setup({ queue: { offerArchive: () => undefined } })
  assert.equal((await offer(s, {})).reason, 'queue-failed')
  const t = setup({ queue: { offerArchive: () => ({ ok: false, error: { x: 1 } }) } })
  assert.equal((await offer(t, {})).reason, 'queue-failed')
  const u = setup({ queue: { offerArchive: () => ({ ok: true }) } })
  assert.equal((await offer(u, {})).reason, 'queue-failed')
})

test('a queue failure logs only a short plain string, never the raw error text', async () => {
  const s = setup({ queue: { offerArchive: () => { throw new Error('secret boom C:\\private') } } })
  await offer(s, {})
  assert.deepEqual(s.logs, ['session-link: offerArchive failed'])
})

test('an async queue rejection is handled like a throw', async () => {
  const s = setup({ queue: { offerArchive: async () => { throw new Error('async boom') } } })
  assert.equal((await offer(s, {})).reason, 'queue-failed')
  assert.equal(s.guards.sizes().archives, 0)
})

test('only the caller own id is ever sent: no argument can change sessionId', async () => {
  const s = setup()
  await s.archiver.offer({ agent, message: 'done', sessionId: 'sess-victim', session: 'sess-victim', id: 'sess-victim', workspace: 'evil', sessionTitle: 'evil' })
  assert.equal(s.calls[0].sessionId, ME)
  assert.equal(s.calls[0].workspace, 'D:\\dev\\ai\\proj')
  assert.equal(s.calls[0].sessionTitle, 'My Session')
})
