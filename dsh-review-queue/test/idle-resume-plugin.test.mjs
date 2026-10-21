import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewQueuePlugin } from '../index.js'
import { IDLE_RESUME_PROMPT } from '../idle-resume.js'

// Wiring in index.js: the idle check runs at startup (idleStartMs) and then every idleCheckMs; it is off in a test run unless config.idleResume is
// true (or idleDeps is given), and off with idleResume: false or env DSH_RQ_IDLE_RESUME=0. A resumed session closes its paused card; a session the model
// is unsure about becomes a paused card (kinds ['idle']) that the paused scan does not close and that Resume / Dismiss handle like any other.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ID = (n) => '00000000-0000-4000-8000-00000000000' + n
const MIN = 60_000

function host({ items = [], services = {} } = {}) {
  const cleanups = []
  const prompts = []
  const lists = { n: 0 }
  const ctx = {
    on() {},
    get: (name) => ({ sessionController: { list: async () => { lists.n++; return { items } }, prompt: async (r) => { prompts.push(r) } }, ...services })[name],
    effect: (fn) => { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    provide() {},
    logger: { warn() {}, info() {} },
    inject: (_n, fn) => fn({ effect: (f) => f(), connection: { admit: () => ({}) }, webServer: { port: 1, register() {} } }),
  }
  return { ctx, prompts, lists, stop: async () => { for (const off of cleanups.splice(0)) await off() } }
}
const idleItem = (n, over = {}) => ({ sessionId: ID(n), updatedAt: Date.now() - 45 * MIN, running: false, blank: false, cwd: 'D:/w', ...over })
const finishedLog = { records: [{ type: 'session', id: 'x', cwd: 'D:/w' }, { type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }], torn: false }
const base = (dir) => ({ hub: false, stateDir: dir, taskbarBadge: false, paused: false, idleStartMs: 5, idleCheckMs: 0 })
const tmp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'rq-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }

test('off in a test run by default: the sessions are never listed', async (t) => {
  const h = host({ items: [idleItem(1)] })
  createReviewQueuePlugin(h.ctx, { hub: false, stateDir: tmp(t), taskbarBadge: false, paused: false })
  t.after(h.stop)
  await sleep(60)
  assert.equal(h.lists.n, 0)
})

test('off with idleResume: false even when deps are given', async (t) => {
  const h = host({ items: [idleItem(1)] })
  createReviewQueuePlugin(h.ctx, { ...base(tmp(t)), idleResume: false, idleDeps: { readLog: async () => finishedLog, judge: async () => ({ verdict: 'resume' }) } })
  t.after(h.stop)
  await sleep(60)
  assert.equal(h.lists.n, 0)
})

test('on: an idle session the model says needs resuming is prompted at startup, without asking', async (t) => {
  const h = host({ items: [idleItem(1)] })
  const plugin = createReviewQueuePlugin(h.ctx, { ...base(tmp(t)), idleResume: true, idleDeps: { readLog: async () => finishedLog, judge: async () => ({ verdict: 'resume', reason: 'step left' }) } })
  t.after(h.stop)
  for (let i = 0; i < 50 && !h.prompts.length; i++) await sleep(10)
  assert.equal(h.prompts.length, 1)
  assert.equal(h.prompts[0].sessionId, ID(1))
  assert.equal(h.prompts[0].content[0].text, IDLE_RESUME_PROMPT)
  assert.equal(plugin.store.list({ status: 'open' }).length, 0, 'no card: the user was not asked')
})

test('the idle minutes are configurable (idleMinutes): a session idle for 20 minutes is looked at with idleMinutes: 15 and not with the default', async (t) => {
  const judged = []
  const judge = async (c) => { judged.push(c.sessionId); return { verdict: 'done' } }
  const a = host({ items: [idleItem(1, { updatedAt: Date.now() - 20 * MIN })] })
  createReviewQueuePlugin(a.ctx, { ...base(tmp(t)), idleResume: true, idleDeps: { readLog: async () => finishedLog, judge } })
  t.after(a.stop)
  await sleep(60)
  assert.deepEqual(judged, [])
  const b = host({ items: [idleItem(2, { updatedAt: Date.now() - 20 * MIN })] })
  createReviewQueuePlugin(b.ctx, { ...base(tmp(t)), idleResume: true, idleMinutes: 15, idleDeps: { readLog: async () => finishedLog, judge } })
  t.after(b.stop)
  for (let i = 0; i < 50 && !judged.length; i++) await sleep(10)
  assert.deepEqual(judged, [ID(2)])
})

test('an unsure verdict becomes a paused card (kinds idle) with the reason; the paused scan does not close it; Resume prompts the session', async (t) => {
  const h = host({ items: [idleItem(1)] })
  const plugin = createReviewQueuePlugin(h.ctx, { ...base(tmp(t)), paused: true, pausedScan: async () => ({ ok: true, candidates: [] }), pausedStartMs: 3_600_000, idleResume: true, idleDeps: { readLog: async () => finishedLog, judge: async () => ({ verdict: 'unsure', reason: 'asks which option' }) } })
  t.after(h.stop)
  const open = () => plugin.store.list({ status: 'open' }).filter((i) => i.type === 'paused')
  for (let i = 0; i < 50 && !open().length; i++) await sleep(10)
  assert.equal(open().length, 1)
  const card = open()[0]
  assert.equal(card.sessionId, ID(1))
  assert.deepEqual(card.payload.kinds, ['idle'])
  assert.match(card.payload.reason, /idle/i)
  assert.match(card.payload.reason, /asks which option/)
  await plugin.local.scanPaused()
  assert.equal(open().length, 1, 'the scan leaves an idle card alone')
  assert.deepEqual(await plugin.queue.resumePaused(card.id), { ok: true })
  assert.equal(h.prompts.length, 1)
  assert.equal(open().length, 0)
})

test('a resumed session closes its open paused card', async (t) => {
  const h = host({ items: [idleItem(1)] })
  const dir = tmp(t)
  const plugin = createReviewQueuePlugin(h.ctx, { ...base(dir), paused: true, pausedScan: async () => ({ ok: true, candidates: [] }), pausedStartMs: 3_600_000, idleResume: true, idleStartMs: 3_600_000, idleDeps: { readLog: async () => finishedLog, judge: async () => ({ verdict: 'resume', reason: 'r' }) } })
  t.after(h.stop)
  plugin.store.add({ type: 'paused', sessionId: ID(1), sessionTitle: 'T', workspace: 'D:/w', payload: { lastWrite: 1000, kinds: ['open-turn'], reason: 'cut', turn: 1, danglingCalls: [], pending: 0, lastUser: '', lastAssistant: '' } })
  const r = await plugin.idle.check()
  assert.equal(r.resumed.length, 1)
  assert.equal(plugin.store.list({ status: 'open' }).filter((i) => i.type === 'paused').length, 0)
})

test('the check repeats every idleCheckMs and stops with the plugin', async (t) => {
  const h = host({ items: [] })
  createReviewQueuePlugin(h.ctx, { ...base(tmp(t)), idleCheckMs: 30, idleResume: true, idleDeps: { readLog: async () => finishedLog, judge: async () => ({ verdict: 'done' }) } })
  await sleep(150)
  assert.ok(h.lists.n >= 3, 'lists: ' + h.lists.n)
  await h.stop()
  const seen = h.lists.n
  await sleep(100)
  assert.equal(h.lists.n, seen)
})
