/** apply() wires the Playwright-queue releaser to the tool/agent lifecycle events. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

// Permissive cordis stand-in that records ctx.on handlers by event name.
function fakeCtx(handlers) {
  const mk = (path) => new Proxy(function () {}, {
    get(_t, k) {
      if (typeof k === 'symbol' || k === 'then') return undefined
      if (path === 'ctx' && k === 'on') return (event, fn) => { (handlers[event] ??= []).push(fn) }
      if (path === 'ctx' && k === 'effect') return () => {}
      return mk(path + '.' + String(k))
    },
    apply() { return mk(path + '()') },
  })
  return mk('ctx')
}

test('PW1 apply() registers handlers for post-execute, turn-stopping, disposed and subagent/end', () => {
  const handlers = {}
  apply(fakeCtx(handlers), { stateDir: mkdtempSync(join(tmpdir(), 'pwq-wire-')), keepAwake: false })
  for (const ev of ['tools/post-execute', 'agent/turn-stopping', 'agent/disposed', 'subagent/end']) assert.ok(handlers[ev]?.length, ev)
})

test('PW3 a granted lease is released through the real queue when the turn stops; disabled config does nothing', async () => {
  const { mkdtempSync: mk, rmSync } = await import('node:fs')
  const { createQueue } = await import('../../dsh-playwright-queue/lib/index.js')
  const run = async (playwrightQueue) => {
    const dir = mk(join(tmpdir(), 'pwq-wire3-'))
    try {
      const handlers = {}
      apply(fakeCtx(handlers), { stateDir: mk(join(tmpdir(), 'pwq-wire-')), keepAwake: false, playwrightQueue: { ...playwrightQueue, dir, releaseGraceMs: 0 } })
      const q = createQueue({ dir })
      const { ticket } = q.enqueue({ holder: 'h1', pid: process.pid })
      const { token } = q.poll(ticket)
      const exec = { name: 'mcp__playwright__queue_acquire', agent: { id: 'a1' }, arguments: {}, callId: 'c' }
      const result = { isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'granted', token }) }] }
      for (const fn of handlers['tools/post-execute']) { try { await fn(exec, result, async () => ({ kind: 'accept' })) } catch { /* other handlers */ } }
      for (const fn of handlers['agent/turn-stopping']) { try { await fn({ agent: { id: 'a1', session: {} }, signal: undefined }) } catch { /* other handlers */ } }
      // the release is fire-and-forget (lazy queue import on first use): give it a moment
      for (let i = 0; i < 40 && q.validate(token); i++) await new Promise((r) => setTimeout(r, 25))
      return q.validate(token)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  assert.ok(!(await run({ enabled: true })), 'lease released')
  assert.ok(await run({ enabled: false }), 'disabled: lease untouched')
})

test('PW2 each release event (turn-stopping, subagent/end, disposed) calls the releaser for that agent', async () => {
  const { mkdtempSync: mk, rmSync } = await import('node:fs')
  const { createQueue } = await import('../../dsh-playwright-queue/lib/index.js')
  const events = {
    'agent/turn-stopping': { agent: { id: 'a1', session: {} }, signal: undefined },
    'subagent/end': { id: 'a1' },
    'agent/disposed': { agent: { id: 'a1' } },
  }
  for (const [event, payload] of Object.entries(events)) {
    const dir = mk(join(tmpdir(), 'pwq-wire2-'))
    try {
      const handlers = {}
      apply(fakeCtx(handlers), { stateDir: mk(join(tmpdir(), 'pwq-wire-')), keepAwake: false, playwrightQueue: { enabled: true, dir, releaseGraceMs: 0 } })
      const q = createQueue({ dir })
      const { ticket } = q.enqueue({ holder: 'h1', pid: process.pid })
      const { token } = q.poll(ticket)
      const exec = { name: 'mcp__playwright__queue_acquire', agent: { id: 'a1' }, arguments: {}, callId: 'c' }
      const result = { isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'granted', token }) }] }
      for (const fn of handlers['tools/post-execute']) { try { await fn(exec, result, async () => ({ kind: 'accept' })) } catch { /* other handlers */ } }
      assert.ok(q.validate(token), `${event}: lease held before the event`)
      for (const fn of handlers[event]) { try { await fn(payload) } catch { /* other handlers */ } }
      for (let i = 0; i < 40 && q.validate(token); i++) await new Promise((r) => setTimeout(r, 25))
      assert.ok(!q.validate(token), `${event}: lease released`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})
test('PW4 agent/pre-step handler calls noteActive and returns next() unchanged; never throws', async () => {
  const handlers = {}
  apply(fakeCtx(handlers), { stateDir: mkdtempSync(join(tmpdir(), 'pwq-wire-')), keepAwake: false })
  assert.ok(handlers['agent/pre-step']?.length >= 2, 'separate pre-step handler')
  const sentinel = { kind: 'x' }
  const mine = handlers['agent/pre-step'][0]
  assert.equal(await mine({ agent: { id: 'a1' }, messages: [], signal: undefined }, async () => sentinel), sentinel)
  assert.equal(await mine({}, async () => sentinel), sentinel)
})

test('PW5 a queue_acquire result arriving after subagent/end is ignored (no leaked slot)', async () => {
  const { mkdtempSync: mk, rmSync } = await import('node:fs')
  const { createQueue } = await import('../../dsh-playwright-queue/lib/index.js')
  const dir = mk(join(tmpdir(), 'pwq-wire5-'))
  try {
    const handlers = {}
    apply(fakeCtx(handlers), { stateDir: mk(join(tmpdir(), 'pwq-wire-')), keepAwake: false, playwrightQueue: { enabled: true, dir, releaseGraceMs: 0 } })
    for (const fn of handlers['subagent/end']) { try { await fn({ id: 'a1' }) } catch { /* other handlers */ } }
    const q = createQueue({ dir })
    const { ticket } = q.enqueue({ holder: 'h1', pid: process.pid })
    const { token } = q.poll(ticket)
    const exec = { name: 'mcp__playwright__queue_acquire', agent: { id: 'a1' }, arguments: {}, callId: 'c' }
    const result = { isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'granted', token }) }] }
    for (const fn of handlers['tools/post-execute']) { try { await fn(exec, result, async () => ({ kind: 'accept' })) } catch { /* other handlers */ } }
    for (const fn of handlers['agent/turn-stopping']) { try { await fn({ agent: { id: 'a1' } }) } catch { /* other handlers */ } }
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(q.validate(token), 'late grant was never recorded, so never released by us')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PW6 agent/created re-enables recording for a disposed id (real handlers)', async () => {
  const { mkdtempSync: mk, rmSync } = await import('node:fs')
  const { createQueue } = await import('../../dsh-playwright-queue/lib/index.js')
  const dir = mk(join(tmpdir(), 'pwq-wire6-'))
  try {
    const handlers = {}
    apply(fakeCtx(handlers), { stateDir: mk(join(tmpdir(), 'pwq-wire-')), keepAwake: false, playwrightQueue: { enabled: true, dir, releaseGraceMs: 0 } })
    const q = createQueue({ dir })
    const grant = () => { const { ticket } = q.enqueue({ holder: 'h1', pid: process.pid }); return q.poll(ticket).token }
    const post = async (token) => {
      const exec = { name: 'mcp__playwright__queue_acquire', agent: { id: 'a1' }, arguments: {}, callId: 'c' }
      const result = { isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'granted', token }) }] }
      for (const fn of handlers['tools/post-execute']) { try { await fn(exec, result, async () => ({ kind: 'accept' })) } catch { /* other handlers */ } }
    }
    const fire = async (ev, p) => { for (const fn of handlers[ev]) { try { await fn(p) } catch { /* other handlers */ } } }
    await fire('agent/disposed', { agent: { id: 'a1' } })
    await fire('agent/created', { agent: { id: 'a1', session: {} } })
    const token = grant()
    await post(token)
    await fire('agent/disposed', { agent: { id: 'a1' } })
    for (let i = 0; i < 40 && q.validate(token); i++) await new Promise((r) => setTimeout(r, 25))
    assert.ok(!q.validate(token), 'grant after re-creation was recorded, then released on dispose')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('PW7 agent/pre-step handler returns next() result by reference, leaves messages alone, never throws', async () => {
  const handlers = {}
  apply(fakeCtx(handlers), { stateDir: mkdtempSync(join(tmpdir(), 'pwq-wire-')), keepAwake: false })
  const mine = handlers['agent/pre-step'][0]
  const sentinel = { kind: 'accept' }
  const messages = [{ role: 'user', content: 'hi' }]
  const snapshot = JSON.stringify(messages)
  assert.equal(await mine({ agent: { id: 'a1' }, messages, signal: undefined }, async () => sentinel), sentinel)
  assert.equal(JSON.stringify(messages), snapshot)
  const throwing = { get id() { throw new Error('boom') } }
  assert.equal(await mine({ agent: throwing, messages }, async () => sentinel), sentinel)
  assert.equal(await mine({ agent: undefined, messages }, async () => sentinel), sentinel)
})
