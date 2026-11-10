/** playwright-queue.js: releases the Playwright queue lease a session holds when the session stops. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createQueueReleaser } from '../playwright-queue.js'

const ACQUIRE = 'mcp__playwright__queue_acquire'
const RELEASE = 'mcp__playwright__queue_release'
const text = (obj) => ({ isError: false, content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] })
const granted = (token) => text({ status: 'granted', token, idleTimeoutMs: 600000 })

function setup(opts = {}) {
  const calls = []
  const logs = []
  const queue = {
    release: (t) => { calls.push(['release', t]); if (opts.failRelease) throw new Error('boom'); return { ok: true } },
    cancel: (t) => { calls.push(['cancel', t]); return { ok: true } },
  }
  const releaser = createQueueReleaser({
    queueFactory: opts.queueFactory ?? (async () => queue),
    logger: { warn: (m) => logs.push(['warn', m]), info: (m) => logs.push(['info', m]) },
    ...opts.extra,
  })
  return { calls, logs, releaser }
}

test('PQ1 a grant is recorded and released when the agent stops', async () => {
  const { calls, releaser } = setup()
  await releaser.observe('a1', ACQUIRE, {}, granted('tok1'))
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [['release', 'tok1']])
  await releaser.releaseAgent('a1')
  assert.equal(calls.length, 1, 'forgotten after release')
})

test('PQ2 queue_release forgets the token (no double release)', async () => {
  const { calls, releaser } = setup()
  await releaser.observe('a1', ACQUIRE, {}, granted('tok1'))
  await releaser.observe('a1', RELEASE, { queueToken: 'tok1' }, text({ status: 'released', ok: true }))
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [])
})

test('PQ3 a waiting result is not recorded as a token; its ticket is cancelled on release', async () => {
  const { calls, releaser } = setup()
  await releaser.observe('a1', ACQUIRE, {}, text({ status: 'waiting', ticket: 'tk9', position: 2 }))
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [['cancel', 'tk9']])
})

test('PQ3b a later grant of the waiting ticket replaces the ticket record', async () => {
  const { calls, releaser } = setup()
  await releaser.observe('a1', ACQUIRE, {}, text({ status: 'waiting', ticket: 'tk9' }))
  await releaser.observe('a1', ACQUIRE, { ticket: 'tk9' }, granted('tok1'))
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [['release', 'tok1']])
})

test('PQ4 subagent end releases only that agent', async () => {
  const { calls, releaser } = setup()
  await releaser.observe('parent', ACQUIRE, {}, granted('tP'))
  await releaser.observe('sub', ACQUIRE, {}, granted('tS'))
  await releaser.releaseAgent('sub')
  assert.deepEqual(calls, [['release', 'tS']])
  await releaser.releaseAgent('parent')
  assert.deepEqual(calls, [['release', 'tS'], ['release', 'tP']])
})

test('PQ5 multiple tokens per agent are all released', async () => {
  const { calls, releaser } = setup()
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  await releaser.observe('a1', ACQUIRE, {}, granted('t2'))
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls.map((c) => c[1]).sort(), ['t1', 't2'])
})

test('PQ6 isError results and other tools are ignored', async () => {
  const { calls, releaser } = setup()
  await releaser.observe('a1', ACQUIRE, {}, { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'granted', token: 'x' }) }] })
  await releaser.observe('a1', 'mcp__playwright__browser_click', {}, granted('y'))
  await releaser.observe('a1', 'mcp__other__queue_acquire', {}, granted('z'))
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [])
})

test('PQ7 garbage result text is ignored and never throws', async () => {
  const { releaser } = setup()
  for (const r of [text('not json'), text('null'), text('[1]'), text({ status: 'granted' }), text({ status: 'granted', token: 5 }), { isError: false }, undefined, null, { content: 'str' }]) {
    await releaser.observe('a1', ACQUIRE, {}, r)
  }
  await releaser.observe(undefined, ACQUIRE, {}, granted('t'))
  await releaser.releaseAgent('a1')
})

test('PQ8 a failing release is logged, not thrown, and the rest are still released', async () => {
  const { calls, logs, releaser } = setup({ failRelease: true })
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  await releaser.observe('a1', ACQUIRE, {}, granted('t2'))
  await assert.doesNotReject(releaser.releaseAgent('a1'))
  assert.equal(calls.length, 2)
  assert.ok(logs.some(([lvl]) => lvl === 'warn'))
})

test('PQ9 a missing queue package degrades to a no-op, logged once', async () => {
  let n = 0
  const { logs, releaser } = setup({ queueFactory: async () => { n++; throw new Error('Cannot find module') } })
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  await releaser.releaseAgent('a1')
  await releaser.observe('a1', ACQUIRE, {}, granted('t2'))
  await releaser.releaseAgent('a1')
  assert.equal(logs.filter(([lvl]) => lvl === 'warn').length, 1)
  assert.equal(n, 1, 'factory tried once')
})

test('PQ10 disabled is a no-op and never creates the queue', async () => {
  let created = 0
  const { calls, releaser } = setup({ queueFactory: async () => { created++; return { release() {}, cancel() {} } }, extra: { enabled: false } })
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  await releaser.releaseAgent('a1')
  assert.equal(created, 0)
  assert.deepEqual(calls, [])
})

test('PQ11 the queue is created lazily, only on first recorded use', async () => {
  let created = 0
  const { releaser } = setup({ queueFactory: async () => { created++; return { release() {}, cancel() {} } } })
  await releaser.releaseAgent('nobody')
  await releaser.observe('a1', 'Read', {}, text('x'))
  assert.equal(created, 0)
  await releaser.observe('a1', ACQUIRE, {}, granted('t'))
  await releaser.releaseAgent('a1')
  assert.equal(created, 1)
})

test('PQ12 the result may carry the text only in value.content (PTC / structured shape)', async () => {
  const { calls, releaser } = setup()
  await releaser.observe('a1', ACQUIRE, {}, { isError: false, value: { content: [{ type: 'text', text: JSON.stringify({ status: 'granted', token: 'tv' }) }] } })
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [['release', 'tv']])
})

test('PQ13 dispose clears recordings; later releaseAgent does nothing', async () => {
  const { calls, releaser } = setup()
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  releaser.dispose()
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [])
})

test('PQ13b dispose releases held tokens and cancels tickets when the queue already exists', async () => {
  const { calls, releaser } = setup()
  await releaser.observe('a0', ACQUIRE, {}, granted('t0'))
  await releaser.releaseAgent('a0') // creates the queue
  calls.length = 0
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  await releaser.observe('a2', ACQUIRE, {}, text({ status: 'waiting', ticket: 'k2' }))
  releaser.dispose()
  assert.deepEqual(calls, [['release', 't1'], ['cancel', 'k2']])
  await releaser.releaseAgent('a1')
  assert.equal(calls.length, 2, 'cleared after dispose')
})

test('PQ13c dispose never creates the queue and survives a throwing release', async () => {
  let created = 0
  const a = setup({ queueFactory: async () => { created++; return { release() {}, cancel() {} } } })
  await a.releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  a.releaser.dispose()
  assert.equal(created, 0)
  const b = setup({ failRelease: true })
  await b.releaser.observe('a0', ACQUIRE, {}, granted('t0'))
  await b.releaser.releaseAgent('a0')
  await b.releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  assert.doesNotThrow(() => b.releaser.dispose())
})

test('PQ14 integration: the real queue hands the lease on after releaseAgent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwq-hook-'))
  try {
    const { createQueue } = await import('../../dsh-playwright-queue/lib/index.js')
    const q = createQueue({ dir })
    const releaser = createQueueReleaser({ queueFactory: async () => createQueue({ dir }), logger: { warn() {}, info() {} } })
    const { ticket } = q.enqueue({ holder: 'sess-1', pid: process.pid })
    const r = q.poll(ticket)
    assert.equal(r.status, 'granted')
    await releaser.observe('agent-1', ACQUIRE, {}, granted(r.token))
    const other = q.enqueue({ holder: 'sess-2', pid: process.pid })
    assert.equal(q.poll(other.ticket).status, 'waiting')
    await releaser.releaseAgent('agent-1')
    assert.equal(q.poll(other.ticket).status, 'granted')
    // a waiting ticket is cancelled when its agent ends
    const third = q.enqueue({ holder: 'sess-3', pid: process.pid })
    await releaser.observe('agent-3', ACQUIRE, {}, text({ status: 'waiting', ticket: third.ticket }))
    await releaser.releaseAgent('agent-3')
    assert.equal(q.poll(third.ticket).status, 'unknown')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('PQ15 turn-stopping releases only after the grace period', async () => {
  const { calls, releaser } = setup({ extra: { releaseGraceMs: 40 } })
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  releaser.scheduleRelease('a1')
  await sleep(10)
  assert.deepEqual(calls, [])
  await sleep(120)
  assert.deepEqual(calls, [['release', 't1']])
})

test('PQ16 observe for the agent cancels a pending release', async () => {
  const { calls, releaser } = setup({ extra: { releaseGraceMs: 40 } })
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  releaser.scheduleRelease('a1')
  await releaser.observe('a1', 'mcp__playwright__browser_click', {}, text('x'))
  await sleep(120)
  assert.deepEqual(calls, [])
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [['release', 't1']])
})

test('PQ17 noteActive cancels a pending release', async () => {
  const { calls, releaser } = setup({ extra: { releaseGraceMs: 40 } })
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  releaser.scheduleRelease('a1')
  releaser.noteActive('a1')
  await sleep(120)
  assert.deepEqual(calls, [])
})

test('PQ18 disposed and subagent-end release immediately, cancelling the pending timer', async () => {
  const { calls, releaser } = setup({ extra: { releaseGraceMs: 10000 } })
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  releaser.scheduleRelease('a1')
  await releaser.releaseAgent('a1', { disposed: true })
  assert.deepEqual(calls, [['release', 't1']])
  await releaser.observe('s1', ACQUIRE, {}, granted('t2'))
  await releaser.releaseAgent('s1')
  assert.deepEqual(calls, [['release', 't1'], ['release', 't2']])
})

test('PQ19 releaseGraceMs 0 releases immediately', async () => {
  const { calls, releaser } = setup({ extra: { releaseGraceMs: 0 } })
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  releaser.scheduleRelease('a1')
  await sleep(30)
  assert.deepEqual(calls, [['release', 't1']])
})

test('PQ20 a second turn-stopping does not stack timers', async () => {
  const real = globalThis.setTimeout
  let count = 0
  globalThis.setTimeout = (...a) => { count++; return real(...a) }
  try {
    const { releaser } = setup({ extra: { releaseGraceMs: 1000 } })
    await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
    releaser.scheduleRelease('a1')
    releaser.scheduleRelease('a1')
    assert.equal(count, 1)
    releaser.dispose()
  } finally { globalThis.setTimeout = real }
})

test('PQ21 dispose clears pending timers and still releases recorded tokens', async () => {
  const { calls, releaser } = setup({ extra: { releaseGraceMs: 40 } })
  await releaser.observe('a0', ACQUIRE, {}, granted('t0'))
  await releaser.releaseAgent('a0')
  calls.length = 0
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  releaser.scheduleRelease('a1')
  releaser.dispose()
  assert.deepEqual(calls, [['release', 't1']])
  await sleep(120)
  assert.equal(calls.length, 1, 'timer did not fire again')
})

test('PQ22 a transient queue-open failure is retried after the backoff; one warn per streak; recording continues meanwhile', async () => {
  let clock = 1000
  let n = 0
  const calls = []
  const { logs, releaser } = setup({
    queueFactory: async () => { n++; if (n <= 2) throw new Error('locked'); return { release: (t) => calls.push(['release', t]), cancel() {} } },
    extra: { now: () => clock, retryMs: 500 },
  })
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  await releaser.releaseAgent('a1') // fails (n=1)
  await releaser.observe('a1', ACQUIRE, {}, granted('t2')) // still recorded while unavailable
  clock += 100
  await releaser.releaseAgent('a1') // inside backoff: no factory call
  assert.equal(n, 1)
  clock += 600
  await releaser.releaseAgent('a1') // retry fails (n=2), same streak: no second warn
  assert.equal(n, 2)
  assert.equal(logs.filter(([l]) => l === 'warn').length, 1)
  clock += 600
  await releaser.releaseAgent('a1') // succeeds
  assert.deepEqual(calls.map((c) => c[1]).sort(), ['t1', 't2'])
})

test('PQ23 serverName builds the acquire/release tool names', async () => {
  const { calls, releaser } = setup({ extra: { serverName: 'pw2' } })
  await releaser.observe('a1', 'mcp__playwright__queue_acquire', {}, granted('no'))
  await releaser.observe('a1', 'mcp__pw2__queue_acquire', {}, granted('yes'))
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [['release', 'yes']])
})

test('PQ24 observe after disposed is ignored (no re-created entry)', async () => {
  const { calls, releaser } = setup()
  await releaser.releaseAgent('a1', { disposed: true })
  await releaser.observe('a1', ACQUIRE, {}, granted('late'))
  await releaser.releaseAgent('a1')
  releaser.dispose()
  assert.deepEqual(calls, [])
})

test('PQ25 subagent-end tombstones the id: a late queue_acquire result is ignored', async () => {
  const { calls, releaser } = setup()
  await releaser.releaseAgent('s1', { ended: true })
  await releaser.observe('s1', ACQUIRE, {}, granted('late'))
  await releaser.releaseAgent('s1')
  releaser.dispose()
  assert.deepEqual(calls, [])
})

test('PQ26 results longer than 4096 chars are not JSON-parsed', async () => {
  const { calls, releaser } = setup()
  const pad = ' '.repeat(4100)
  await releaser.observe('a1', ACQUIRE, {}, text(JSON.stringify({ status: 'granted', token: 'big' }) + pad))
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [])
})

test('PQ27 tokens and tickets longer than 256 chars are rejected', async () => {
  const { calls, releaser } = setup()
  await releaser.observe('a1', ACQUIRE, {}, granted('t'.repeat(257)))
  await releaser.observe('a1', ACQUIRE, {}, text({ status: 'waiting', ticket: 'k'.repeat(257) }))
  await releaser.observe('a1', ACQUIRE, {}, granted('t'.repeat(256)))
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [['release', 't'.repeat(256)]])
})

test('PQ28 per-agent caps: 64 tokens (ignore new), 64 tickets (drop oldest)', async () => {
  const { calls, releaser } = setup()
  for (let i = 0; i < 70; i++) await releaser.observe('a1', ACQUIRE, {}, granted('tok' + i))
  for (let i = 0; i < 70; i++) await releaser.observe('a1', ACQUIRE, {}, text({ status: 'waiting', ticket: 'tk' + i }))
  await releaser.releaseAgent('a1')
  const rel = calls.filter((c) => c[0] === 'release').map((c) => c[1])
  const can = calls.filter((c) => c[0] === 'cancel').map((c) => c[1])
  assert.equal(rel.length, 64); assert.ok(rel.includes('tok0') && !rel.includes('tok64'))
  assert.equal(can.length, 64); assert.ok(!can.includes('tk0') && can.includes('tk69'))
})

test('PQ29 held map is capped at 500 agents', async () => {
  const { calls, releaser } = setup()
  for (let i = 0; i < 505; i++) await releaser.observe('a' + i, ACQUIRE, {}, granted('t' + i))
  releaser.dispose() // queue not yet opened: nothing released, but also check via releaseAgent
  for (let i = 0; i < 505; i++) await releaser.observe('b' + i, ACQUIRE, {}, granted('u' + i))
  for (let i = 0; i < 505; i++) await releaser.releaseAgent('b' + i)
  assert.equal(calls.length, 500)
})

test('PQ30 an ended agent is pruned when the queue cannot be opened', async () => {
  let clock = 0, n = 0
  const queue = { release: (t) => { calls.push(t) }, cancel() {} }
  const calls = []
  const { releaser } = setup({
    queueFactory: async () => { n++; if (n === 1) throw new Error('down'); return queue },
    extra: { now: () => clock, retryMs: 500 },
  })
  await releaser.observe('a1', ACQUIRE, {}, granted('t1'))
  await releaser.releaseAgent('a1', { ended: true }) // fails to open; ended -> pruned
  clock += 600
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [])
})

test('PQ31 noteCreated re-enables recording for a disposed id', async () => {
  const { calls, releaser } = setup()
  await releaser.releaseAgent('a1', { disposed: true })
  await releaser.observe('a1', ACQUIRE, {}, granted('tokA'))
  await releaser.releaseAgent('a1')
  assert.equal(calls.length, 0, 'ignored while tombstoned')
  releaser.noteCreated('a1')
  await releaser.observe('a1', ACQUIRE, {}, granted('tokB'))
  await releaser.releaseAgent('a1')
  assert.deepEqual(calls, [['release', 'tokB']])
})

test('PQ32 noteCreated keeps an ended (subagent) id ignored and never throws', async () => {
  const { calls, releaser } = setup()
  await releaser.releaseAgent('s1', { ended: true })
  releaser.noteCreated('s1')
  releaser.noteCreated(undefined)
  await releaser.observe('s1', ACQUIRE, {}, granted('tokS'))
  await releaser.releaseAgent('s1')
  assert.equal(calls.length, 0)
})
