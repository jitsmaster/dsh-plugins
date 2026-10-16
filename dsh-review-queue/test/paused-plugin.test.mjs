import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewQueuePlugin } from '../index.js'
import { RESUME_PROMPT, STALE_MS } from '../paused.js'

// Wiring in index.js: the scan runs at startup and once more after the quiet time, and on demand; it knows which sessions are live or archived;
// without a scan configured (every test run) the plugin never touches ~/.dsh/sessions.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cand = (id, over = {}) => ({ sessionId: id, cwd: 'D:/w', title: 'T ' + id, lastWrite: 1000, kinds: ['open-turn'], reason: 'Cut off in the middle of a turn', turn: 1, danglingCalls: [], pending: 0, lastUser: '', lastAssistant: '', ...over })

function host({ services = {} } = {}) {
  const handlers = {}
  const cleanups = []
  const prompts = []
  const ctx = {
    on: (n, f) => { (handlers[n] ??= []).push(f) },
    get: (name) => ({ sessionController: { prompt: async (r) => { prompts.push(r) } }, ...services })[name],
    effect: (fn) => { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    provide() {},
    logger: { warn() {}, info() {} },
    inject: (_n, fn) => fn({ effect: (f) => f(), connection: { admit: () => ({}) }, webServer: { port: 1, register() {} } }),
  }
  return { ctx, handlers, cleanups, prompts, stop: async () => { for (const off of cleanups.splice(0)) await off() } }
}
const open = (plugin) => plugin.store.list({ status: 'open' }).filter((i) => i.type === 'paused')

test('with no scan configured the plugin reads no session logs and scanPaused says so', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host()
  const plugin = createReviewQueuePlugin(h.ctx, { hub: false, stateDir: dir, taskbarBadge: false })
  t.after(h.stop)
  await sleep(30)
  assert.deepEqual(await plugin.queue.scanPaused(), { ok: false, error: 'no-scanner' })
})

test('a configured scan runs at startup, hands over the start time, the live sessions and the archived ones, and fills the list', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const calls = []
  const h = host({ services: { agents: { list: () => [{ id: 'live-1' }] }, workspaceRegistry: { list: () => [], archivedSessionIds: ['arch-1'] } } })
  const before = Date.now()
  const plugin = createReviewQueuePlugin(h.ctx, { hub: false, stateDir: dir, taskbarBadge: false, pausedScan: async (opts) => { calls.push(opts); return { ok: true, candidates: [cand('p1'), cand('p2')] } }, pausedStartMs: 5, pausedRescanMs: 0 })
  t.after(h.stop)
  await h.handlers['agent/turn-stopping'][0]({ agent: { id: 'seen-1', devTitle: 'x', session: { header: { cwd: 'D:/w' }, deriveMessages: () => [{ role: 'assistant', content: 'done' }] } } })
  for (let i = 0; i < 50 && !open(plugin).length; i++) await sleep(10)
  assert.equal(open(plugin).length, 2)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].startedAt >= before && calls[0].startedAt <= Date.now())
  assert.ok(calls[0].liveIds.has('live-1') && calls[0].liveIds.has('seen-1'))
  assert.ok(calls[0].skipIds.has('arch-1'))
  assert.match(calls[0].root.replace(/\\/g, '/'), /\/sessions$/)
})

test('a second scan runs after the quiet time, on demand too, and nothing runs after the plugin stopped', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let n = 0
  const h = host()
  const plugin = createReviewQueuePlugin(h.ctx, { hub: false, stateDir: dir, taskbarBadge: false, pausedScan: async () => { n++; return { ok: true, candidates: [] } }, pausedStartMs: 5, pausedRescanMs: 40 })
  await sleep(120)
  assert.equal(n, 2)
  await plugin.queue.scanPaused()
  assert.equal(n, 3)
  await h.stop()
  await sleep(100)
  assert.equal(n, 3)
})

test('Resume prompts the session; Dismiss is kept in paused-dismissed.json next to the queue file and survives a new plugin', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const config = { hub: false, stateDir: dir, taskbarBadge: false, pausedScan: async () => ({ ok: true, candidates: [cand('p1'), cand('p2')] }), pausedStartMs: 3_600_000 }
  const h = host()
  const plugin = createReviewQueuePlugin(h.ctx, config)
  t.after(h.stop)
  await plugin.queue.scanPaused()
  const [a, b] = open(plugin).map((i) => i.id)
  assert.deepEqual(await plugin.queue.resumePaused(a), { ok: true })
  assert.deepEqual([h.prompts[0].sessionId, h.prompts[0].content[0].text], ['p1', RESUME_PROMPT])
  assert.deepEqual(plugin.queue.dismissPaused(b), { ok: true })
  assert.ok(existsSync(join(dir, 'paused-dismissed.json')))
  assert.ok(JSON.parse(readFileSync(join(dir, 'paused-dismissed.json'), 'utf8')).items.p2)
  const h2 = host()
  const again = createReviewQueuePlugin(h2.ctx, config)
  t.after(h2.stop)
  assert.equal((await again.queue.scanPaused()).added, 0, 'neither the resumed nor the dismissed session comes back')
  assert.ok(STALE_MS > 0)
})
