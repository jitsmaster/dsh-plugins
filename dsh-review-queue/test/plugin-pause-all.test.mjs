import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewQueuePlugin } from '../index.js'

// Wiring in index.js: Pause all cancels the running sessions through the session controller, writes paused-by-user.json next to the queue file,
// quits through the desktop, and a NEW plugin (the restart) lists those sessions as paused, with the Resume prompt available.
function host({ sessions }) {
  const cancelled = []
  const prompts = []
  const cleanups = []
  const controller = {
    list: async () => ({ items: sessions.map((s) => ({ ...s })) }),
    cancel: async ({ sessionId }) => { cancelled.push(sessionId); sessions.find((s) => s.sessionId === sessionId).running = false; return { accepted: true } },
    prompt: async (r) => { prompts.push(r) },
  }
  const ctx = {
    on() {}, get: (name) => ({ sessionController: controller, sessionQuery: { readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', value: { title: { title: 'Title of ' + id } } })) } })[name],
    effect: (fn) => { const off = fn(); if (typeof off === 'function') cleanups.push(off) }, provide() {}, logger: { warn() {}, info() {} },
    inject: (_n, fn) => fn({ effect: (f) => f(), connection: { admit: () => ({}) }, webServer: { port: 1, register() {} } }),
  }
  return { ctx, cancelled, prompts, stop: async () => { for (const off of cleanups.splice(0)) await off() } }
}
const fakeDesktop = (canQuit = true) => { const d = { quits: 0, canQuit: async () => canQuit, quitSoon: () => { d.quits++ } }; return d }

test('Pause all pauses the running sessions, records them, quits; after the restart they are paused items that can be resumed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const desktop = fakeDesktop()
  const h = host({ sessions: [{ sessionId: 's1', running: true, cwd: 'D:/w/one' }, { sessionId: 's2', running: false }, { sessionId: 's3', running: true, cwd: 'D:/w/three' }] })
  const plugin = createReviewQueuePlugin(h.ctx, { hub: false, stateDir: dir, taskbarBadge: false, desktop, pausedScan: async () => ({ ok: true, candidates: [] }), pausedStartMs: 3_600_000 })
  t.after(h.stop)
  assert.deepEqual(await plugin.queue.pauseAll(), { ok: true, paused: 2, quitting: true })
  assert.deepEqual(h.cancelled.sort(), ['s1', 's3'])
  assert.equal(desktop.quits, 1)
  assert.ok(existsSync(join(dir, 'paused-by-user.json')))
  const first = plugin.store.list({ status: 'open' }).filter((i) => i.type === 'paused')
  assert.deepEqual(first.map((i) => [i.sessionId, i.sessionTitle]).sort(), [['s1', 'Title of s1'], ['s3', 'Title of s3']])
  assert.match(first[0].payload.reason, /Pause all and quit/)

  // the restart: a new plugin on the same state directory
  const h2 = host({ sessions: [] })
  const again = createReviewQueuePlugin(h2.ctx, { hub: false, stateDir: dir, taskbarBadge: false, desktop: fakeDesktop(), pausedScan: async () => ({ ok: true, candidates: [] }), pausedStartMs: 3_600_000 })
  t.after(h2.stop)
  await again.queue.scanPaused()
  const open = again.store.list({ status: 'open' }).filter((i) => i.type === 'paused')
  assert.deepEqual(open.map((i) => i.sessionId).sort(), ['s1', 's3'])
  assert.deepEqual(await again.queue.resumePaused(open[0].id), { ok: true })
  assert.equal(h2.prompts.length, 1)
  await again.queue.scanPaused()
  assert.deepEqual(again.store.list({ status: 'open' }).filter((i) => i.type === 'paused').map((i) => i.sessionId), [open[1].sessionId], 'the resumed session does not come back')
})

test('with no desktop to close nothing is paused and nothing is recorded', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host({ sessions: [{ sessionId: 's1', running: true }] })
  const plugin = createReviewQueuePlugin(h.ctx, { hub: false, stateDir: dir, taskbarBadge: false, desktop: fakeDesktop(false), pausedScan: async () => ({ ok: true, candidates: [] }), pausedStartMs: 3_600_000 })
  t.after(h.stop)
  assert.deepEqual(await plugin.queue.pauseAll(), { ok: false, error: 'no-desktop' })
  assert.deepEqual(h.cancelled, [])
  assert.ok(!existsSync(join(dir, 'paused-by-user.json')))
})
