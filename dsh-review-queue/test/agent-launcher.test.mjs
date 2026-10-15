// ensureHub (docs/hub.md 8.1, 8.2, 10): every side effect is injected (files, spawn, health probe, clock, pid check), so the lock race, a
// stale lock, a foreign program on the port, a failed spawn, the upgrade rules and the retry policy run in memory. Never binds or probes 47615.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DEFAULT_HUB_PORT, createLauncher, createReconnector, hubPortOf, retryDelayMs } from '../agent/launcher.js'

const DIR = 'S:/state'
const PORT = 41234
const MAIN = 'S:/plugin/hub/main.js'
const LOCK = DIR + '/hub.lock'
const JSON_FILE = DIR + '/hub.json'
const SECRET = 'S'.repeat(43)

/** One fake machine: a clock that only sleep() moves, an in-memory folder, fake hubs that come up some time after a spawn. */
function makeWorld({ hubDelayMs = 600, existing } = {}) {
  const w = { t: 1_000_000, files: new Map(), spawns: [], posts: [], sleeps: [], alive: new Set([111, 222, 333]), pending: undefined, hub: undefined, probed: [], spawnImpl: undefined, hubGone: true, exits: [] }
  w.files.set(DIR + '/hub.secret', SECRET + '\n')
  const publish = (h) => {
    w.hub = h
    w.files.set(JSON_FILE, JSON.stringify({ pid: h.pid, port: PORT, hubId: h.hubId, version: 'v', protocol: h.protocol, startedAt: w.t }))
    w.files.delete(LOCK)
  }
  if (existing) publish(existing)
  const settle = () => { if (w.pending && w.t >= w.pending.at) { const p = w.pending; w.pending = undefined; publish(p.hub) } }
  const key = (f) => f.replaceAll('\\', '/') // join() writes backslashes on Windows
  w.fs = {
    readText: (f) => w.files.get(key(f)),
    writeExclusive: (f, text) => { if (w.files.has(key(f))) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); w.files.set(key(f), text) },
    remove: (f) => { w.files.delete(key(f)) },
    mkdir: () => {},
    openLog: () => 99,
    closeLog: () => {},
  }
  w.probe = async (port) => { w.probed.push(port); settle(); return w.hub && port === PORT ? { ok: true, service: 'dsh-review-queue-hub', hubId: w.hub.hubId, protocol: w.hub.protocol, version: 'v' } : undefined }
  w.sleep = async (ms) => { w.sleeps.push(ms); w.t += ms; settle(); await new Promise((r) => setImmediate(r)) }
  w.spawn = (exe, args, opts) => {
    w.spawns.push({ exe, args, opts })
    if (w.spawnImpl) return w.spawnImpl(exe, args, opts)
    const child = new EventEmitter()
    child.pid = 4242
    child.unref = () => {}
    w.pending = { at: w.t + hubDelayMs, hub: { pid: 4242, hubId: 'H' + w.spawns.length, protocol: w.nextProtocol ?? 1 } }
    return child
  }
  w.post = async (port, path, body, secret) => {
    w.posts.push({ port, path, body, secret })
    if (w.postImpl) return w.postImpl()
    // a hub that obeys: it is gone at once
    w.hub = undefined
    w.files.delete(JSON_FILE)
    return { status: 200 }
  }
  w.pidAlive = (pid) => w.alive.has(pid)
  w.now = () => w.t
  return w
}

const launcherOf = (w, over = {}) => createLauncher({
  stateDir: DIR, port: PORT, hubMain: MAIN, protocol: 1, minHubProtocol: 1,
  fs: w.fs, spawn: w.spawn, probe: w.probe, post: w.post, sleep: w.sleep, now: w.now, pidAlive: w.pidAlive, pid: 111,
  nodeExe: () => ({ exe: 'C:/node/node.exe', env: {} }), env: { PATH: 'C:/node', SystemRoot: 'C:/Windows', SECRET_TOKEN: 'leak-me', USERPROFILE: 'C:/Users/u' }, log: (l) => (w.logs ??= []).push(l),
  ...over,
})
const lockText = (pid, ts) => JSON.stringify({ pid, ts })

test('the default hub port is 47615 and comes from config, else env, else the default (never probed here)', () => {
  assert.equal(DEFAULT_HUB_PORT, 47615)
  assert.equal(hubPortOf({ hubPort: 41000, env: { DSH_RQ_HUB_PORT: '42000' } }), 41000)
  assert.equal(hubPortOf({ env: { DSH_RQ_HUB_PORT: '42000' } }), 42000)
  assert.equal(hubPortOf({ env: {} }), 47615)
  assert.equal(hubPortOf({ hubPort: 'abc', env: { DSH_RQ_HUB_PORT: '99999' } }), 47615)
})

test('a running hub that hub.json names and health confirms is used as is: nothing spawned, no lock', async () => {
  const w = makeWorld({ existing: { pid: 777, hubId: 'H0', protocol: 1 } })
  const r = await launcherOf(w).ensureHub()
  assert.deepEqual([r.mode, r.info.hubId, r.info.port, r.baseUrl, r.spawned], ['hub', 'H0', PORT, 'http://127.0.0.1:' + PORT, false])
  assert.deepEqual(w.spawns, [])
  assert.equal(w.files.has(LOCK), false)
})

test('no hub: one detached hidden hub process on this state dir and port, health polled every 150 ms, lock gone', async () => {
  const w = makeWorld()
  const r = await launcherOf(w).ensureHub()
  assert.deepEqual([r.mode, r.info.hubId, r.spawned], ['hub', 'H1', true])
  assert.equal(w.spawns.length, 1)
  const { exe, args, opts } = w.spawns[0]
  assert.equal(exe, 'C:/node/node.exe')
  assert.deepEqual(args, [MAIN, '--state-dir', DIR, '--port', String(PORT)])
  assert.equal(opts.detached, true)
  assert.equal(opts.windowsHide, true)
  assert.deepEqual(opts.stdio, ['ignore', 99, 99])
  assert.deepEqual(w.sleeps.filter((ms) => ms !== 150), [])
  assert.ok(w.sleeps.length >= 3 && w.sleeps.length <= 6)
  assert.equal(w.files.has(LOCK), false)
})

test('the hub child gets a minimal environment: no stray variables, the ones node needs, and what nodeExe asks for', async () => {
  const w = makeWorld()
  await launcherOf(w, { nodeExe: () => ({ exe: 'C:/e/electron.exe', env: { ELECTRON_RUN_AS_NODE: '1' } }) }).ensureHub()
  const env = w.spawns[0].opts.env
  assert.equal(w.spawns[0].exe, 'C:/e/electron.exe')
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.SystemRoot, 'C:/Windows')
  assert.equal(env.USERPROFILE, 'C:/Users/u')
  assert.equal(env.SECRET_TOKEN, undefined)
})

test('three launchers racing: exactly one spawn, all three get the same hub', async () => {
  const w = makeWorld({ hubDelayMs: 900 })
  const results = await Promise.all([111, 222, 333].map((pid) => launcherOf(w, { pid }).ensureHub()))
  assert.equal(w.spawns.length, 1)
  assert.deepEqual(results.map((r) => [r.mode, r.info.hubId]), [['hub', 'H1'], ['hub', 'H1'], ['hub', 'H1']])
  assert.equal(w.files.has(LOCK), false)
})

test('one launcher called twice at once shares the attempt', async () => {
  const w = makeWorld()
  const l = launcherOf(w)
  const [a, b] = await Promise.all([l.ensureHub(), l.ensureHub()])
  assert.equal(w.spawns.length, 1)
  assert.equal(a, b)
})

test('a lock of a dead process is stale: removed, and this launcher spawns', async () => {
  const w = makeWorld()
  w.files.set(LOCK, lockText(999, w.t - 1000))
  const r = await launcherOf(w).ensureHub()
  assert.equal(r.mode, 'hub')
  assert.equal(w.spawns.length, 1)
})

test('a lock older than 30 s is stale even when its pid is alive (pid reuse, a hung launcher)', async () => {
  const w = makeWorld()
  w.files.set(LOCK, lockText(222, w.t - 31_000))
  const r = await launcherOf(w).ensureHub()
  assert.equal(r.mode, 'hub')
  assert.equal(w.spawns.length, 1)
})

test('a fresh lock of a live launcher: wait for its hub, do not spawn; its lock stays until its hub removes it', async () => {
  const w = makeWorld()
  w.files.set(LOCK, lockText(222, w.t - 500))
  w.pending = { at: w.t + 2000, hub: { pid: 5, hubId: 'HX', protocol: 1 } }
  const r = await launcherOf(w).ensureHub()
  assert.deepEqual([r.mode, r.info.hubId, r.spawned], ['hub', 'HX', false])
  assert.deepEqual(w.spawns, [])
})

test('a fresh lock whose hub never comes: gives up after 10 s with a reason, spawns nothing, leaves the foreign lock', async () => {
  const w = makeWorld()
  w.files.set(LOCK, lockText(222, w.t - 100))
  const started = w.t
  const r = await launcherOf(w).ensureHub()
  assert.deepEqual([r.mode, r.status], ['standalone', 'unavailable'])
  assert.match(r.reason, /another app/)
  assert.ok(w.t - started >= 10_000 && w.t - started < 11_000)
  assert.deepEqual(w.spawns, [])
  assert.equal(w.files.has(LOCK), true)
})

test('a foreign program on the port: the hub child exits 2, so unavailable at once with the reason and the lock removed', async () => {
  const w = makeWorld()
  w.spawnImpl = () => { const c = new EventEmitter(); c.pid = 4242; c.unref = () => {}; setImmediate(() => c.emit('exit', 2, null)); return c }
  const started = w.t
  const r = await launcherOf(w).ensureHub()
  assert.deepEqual([r.mode, r.status], ['standalone', 'unavailable'])
  assert.match(r.reason, /port.*another program/)
  assert.ok(w.t - started < 2000)
  assert.equal(w.files.has(LOCK), false)
})

test('a program that only imitates the health answer (another hubId than hub.json) is not taken for the hub', async () => {
  const w = makeWorld({ existing: { pid: 777, hubId: 'FORGED', protocol: 1 } })
  w.files.set(JSON_FILE, JSON.stringify({ pid: 5, port: PORT, hubId: 'REAL', version: 'v', protocol: 1, startedAt: 1 }))
  w.spawnImpl = () => { const c = new EventEmitter(); c.pid = 4242; c.unref = () => {}; setImmediate(() => c.emit('exit', 2, null)); return c }
  const r = await launcherOf(w).ensureHub()
  assert.equal(w.spawns.length, 1, 'it tried to start a hub of its own')
  assert.deepEqual([r.mode, r.status], ['standalone', 'unavailable'])
})

test('a spawn that throws, or fails a moment later, is unavailable with the reason and the lock removed', async () => {
  const thrown = makeWorld()
  thrown.spawnImpl = () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }
  const a = await launcherOf(thrown).ensureHub()
  assert.deepEqual([a.mode, a.status], ['standalone', 'unavailable'])
  assert.match(a.reason, /ENOENT/)
  assert.equal(thrown.files.has(LOCK), false)
  const late = makeWorld()
  late.spawnImpl = () => { const c = new EventEmitter(); c.pid = undefined; c.unref = () => {}; setImmediate(() => c.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))); return c }
  const b = await launcherOf(late).ensureHub()
  assert.match(b.reason, /EACCES/)
  assert.equal(late.files.has(LOCK), false)
})

test('a hub that never answers: unavailable after 10 s, lock removed', async () => {
  const w = makeWorld({ hubDelayMs: 60_000 })
  const started = w.t
  const r = await launcherOf(w).ensureHub()
  assert.deepEqual([r.mode, r.status], ['standalone', 'unavailable'])
  assert.match(r.reason, /did not answer within 10 s/)
  assert.ok(w.t - started >= 10_000 && w.t - started < 11_000)
  assert.equal(w.files.has(LOCK), false)
})

test('no node to run the hub with: unavailable with that reason, nothing spawned, lock removed', async () => {
  const w = makeWorld()
  const r = await launcherOf(w, { nodeExe: () => ({ error: 'node was not found' }) }).ensureHub()
  assert.deepEqual([r.mode, r.status, r.reason], ['standalone', 'unavailable', 'node was not found'])
  assert.deepEqual(w.spawns, [])
  assert.equal(w.files.has(LOCK), false)
})

test('a strictly newer plugin protocol restarts the older hub with the agent secret, waits, and starts a new one', async () => {
  const w = makeWorld({ existing: { pid: 777, hubId: 'OLD', protocol: 1 } })
  w.nextProtocol = 2
  const r = await launcherOf(w, { protocol: 2, minHubProtocol: 2 }).ensureHub()
  assert.deepEqual(w.posts, [{ port: PORT, path: '/hub/v1/shutdown', body: { reason: 'upgrade', hubId: 'OLD' }, secret: SECRET }])
  assert.equal(w.spawns.length, 1)
  assert.deepEqual([r.mode, r.info.hubId, r.info.protocol], ['hub', 'H1', 2])
})

test('never a downgrade: a hub of the same or a newer protocol than the plugin needs is left alone', async () => {
  for (const hubProtocol of [2, 3]) {
    const w = makeWorld({ existing: { pid: 777, hubId: 'H0', protocol: hubProtocol } })
    const r = await launcherOf(w, { protocol: 3, minHubProtocol: 2 }).ensureHub()
    assert.deepEqual([r.mode, r.info.hubId], ['hub', 'H0'])
    assert.deepEqual([w.posts, w.spawns], [[], []])
  }
})

test('an older agent against a newer hub (it would get 426): standalone with the restart-DSH notice, hub untouched', async () => {
  const w = makeWorld({ existing: { pid: 777, hubId: 'NEW', protocol: 3 } })
  const r = await launcherOf(w, { protocol: 1, minHubProtocol: 1 }).ensureHub()
  assert.deepEqual([r.mode, r.status, r.notice], ['standalone', 'hub-newer', 'hub is newer, restart DSH'])
  assert.deepEqual([w.posts, w.spawns], [[], []])
})

test('an upgrade that does not work (the hub refuses, stays up, or the secret is missing) ends standalone and does not loop', async () => {
  const refuse = makeWorld({ existing: { pid: 777, hubId: 'OLD', protocol: 1 } })
  refuse.postImpl = async () => ({ status: 401 })
  const a = await launcherOf(refuse, { protocol: 2, minHubProtocol: 2 }).ensureHub()
  assert.deepEqual([a.mode, a.status], ['standalone', 'unavailable'])
  assert.match(a.reason, /could not restart/)
  assert.equal(refuse.posts.length, 1)
  assert.deepEqual(refuse.spawns, [])
  const nosecret = makeWorld({ existing: { pid: 777, hubId: 'OLD', protocol: 1 } })
  nosecret.files.delete(DIR + '/hub.secret')
  const b = await launcherOf(nosecret, { protocol: 2, minHubProtocol: 2 }).ensureHub()
  assert.equal(b.mode, 'standalone')
  assert.deepEqual(nosecret.posts, [])
  const stale = makeWorld({ existing: { pid: 777, hubId: 'OLD', protocol: 1 } })
  stale.nextProtocol = 1 // the new hub is still the old build
  const c = await launcherOf(stale, { protocol: 2, minHubProtocol: 2 }).ensureHub()
  assert.deepEqual([c.mode, c.status], ['standalone', 'unavailable'])
  assert.equal(stale.posts.length, 1)
  assert.equal(stale.spawns.length, 1)
})

test('nothing the launcher logs holds the secret or the environment', async () => {
  const w = makeWorld({ existing: { pid: 777, hubId: 'OLD', protocol: 1 } })
  w.nextProtocol = 2
  await launcherOf(w, { protocol: 2, minHubProtocol: 2 }).ensureHub()
  const text = (w.logs ?? []).join('\n')
  assert.ok(text.length > 0)
  for (const needle of [SECRET, 'leak-me', 'Bearer']) assert.equal(text.includes(needle), false)
})

test('retry policy: first retry after 60 s, doubling, capped at 10 min', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => retryDelayMs(n)), [60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000])
  assert.deepEqual([0, 1, 2].map((n) => retryDelayMs(n, { min: 40, max: 100 })), [40, 80, 100])
})

function fakeTimers() {
  const t = { now: 0, jobs: [] }
  t.setTimeout = (fn, ms) => { const j = { fn, at: t.now + ms }; t.jobs.push(j); return j }
  t.clearTimeout = (j) => { t.jobs = t.jobs.filter((x) => x !== j) }
  t.advance = async (ms) => { const end = t.now + ms; for (;;) { const j = t.jobs.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!j) break; t.jobs = t.jobs.filter((x) => x !== j); t.now = j.at; j.fn(); await new Promise((r) => setImmediate(r)) } t.now = end }
  return t
}

test('the reconnector tries again after 60 s, 120 s, ... while the hub is unavailable, stops when it is found, and can be kicked or stopped', async () => {
  const timers = fakeTimers()
  const results = []
  const answers = [{ mode: 'standalone', status: 'unavailable', reason: 'x' }, { mode: 'standalone', status: 'unavailable', reason: 'x' }, { mode: 'hub', info: {} }]
  const rc = createReconnector({ ensureHub: async () => answers.shift() ?? { mode: 'hub', info: {} }, onResult: (r) => results.push(r.mode), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
  await rc.run()
  assert.deepEqual(results, ['standalone'])
  await timers.advance(59_999)
  assert.equal(results.length, 1)
  await timers.advance(1)
  assert.equal(results.length, 2)
  await timers.advance(119_999)
  assert.equal(results.length, 2)
  await timers.advance(1)
  assert.deepEqual(results, ['standalone', 'standalone', 'hub'])
  await timers.advance(10 * 60_000)
  assert.equal(results.length, 3, 'no more attempts once the hub is found')
  rc.stop()
})

test('a kick (the hub was lost) resets the backoff and tries at once; stop cancels the pending retry', async () => {
  const timers = fakeTimers()
  let calls = 0
  const rc = createReconnector({ ensureHub: async () => { calls++; return { mode: 'standalone', status: 'unavailable', reason: 'x' } }, onResult: () => {}, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, retryMs: { min: 100, max: 400 } })
  await rc.run()
  await timers.advance(100)
  await timers.advance(200)
  assert.equal(calls, 3)
  rc.kick()
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 4)
  await timers.advance(99)
  assert.equal(calls, 4, 'the backoff started over at the minimum')
  await timers.advance(1)
  assert.equal(calls, 5)
  rc.stop()
  await timers.advance(10_000)
  assert.equal(calls, 5)
})
