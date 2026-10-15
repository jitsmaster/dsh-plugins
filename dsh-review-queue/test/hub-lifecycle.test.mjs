import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createHub } from '../hub/hub.js'
import { raw, postJson, tmpDir } from './hub-helpers.mjs'

const P = '/review-queue'
async function startHub(t, { dir = tmpDir(t), ...over } = {}) {
  const logs = []
  const hub = createHub({ stateDir: dir, port: 0, tickMs: 0, log: (l) => logs.push(l), ...over })
  await hub.start()
  t.after(() => hub.stop())
  return { hub, dir, logs, port: hub.port }
}
const feed = (hub, over = {}, owner = 'A1') => hub.store.applyOp({ op: 'add', item: { type: 'completed', sessionId: 's1', sessionTitle: 'One', payload: { reply: 'r' }, ...over } }, { owner }).id
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// ---- hub.json, hub.lock, singleton ---------------------------------------------------------------------------------------------

test('hub.json is written after listen with pid, port, hubId, version, protocol and startedAt', async (t) => {
  const now = 7_000_000_000_000
  const { hub, dir, port } = await startHub(t, { now: () => now })
  const info = readJson(join(dir, 'hub.json'))
  assert.deepEqual(Object.keys(info).sort(), ['hubId', 'pid', 'port', 'protocol', 'startedAt', 'version'])
  assert.equal(info.pid, process.pid)
  assert.equal(info.port, port)
  assert.equal(info.hubId, hub.hubId)
  assert.equal(info.startedAt, now)
  assert.equal(typeof info.protocol, 'number')
  const health = (await raw({ port, path: '/hub/v1/health' })).json
  assert.equal(health.hubId, info.hubId, 'what a launcher reads in hub.json is what the port answers')
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0)
})

test('every start has its own hubId', async (t) => {
  const a = await startHub(t)
  const b = await startHub(t)
  assert.notEqual(a.hub.hubId, b.hub.hubId)
})

test('a clean stop removes hub.json when it names this pid', async (t) => {
  const { hub, dir } = await startHub(t)
  await hub.stop()
  assert.equal(existsSync(join(dir, 'hub.json')), false)
  await hub.stop()
})

test('a clean stop leaves a hub.json that names another pid (a newer hub took over)', async (t) => {
  const { hub, dir } = await startHub(t)
  const other = { pid: process.pid + 1, port: 1, hubId: 'other', version: 'x', protocol: 1, startedAt: 1 }
  writeFileSync(join(dir, 'hub.json'), JSON.stringify(other))
  await hub.stop()
  assert.deepEqual(readJson(join(dir, 'hub.json')), other)
})

test('the pid is injectable and a missing or garbled hub.json at stop is not an error', async (t) => {
  const { hub, dir } = await startHub(t, { pid: 4242 })
  assert.equal(readJson(join(dir, 'hub.json')).pid, 4242)
  writeFileSync(join(dir, 'hub.json'), '{garbled')
  await assert.doesNotReject(hub.stop())
  assert.equal(readFileSync(join(dir, 'hub.json'), 'utf8'), '{garbled')
})

test('hub.lock left by the launcher is removed once the hub is listening', async (t) => {
  const dir = tmpDir(t)
  writeFileSync(join(dir, 'hub.lock'), JSON.stringify({ pid: 1, ts: 1 }))
  await startHub(t, { dir })
  assert.equal(existsSync(join(dir, 'hub.lock')), false)
})

test('a busy port rejects the start with EADDRINUSE and leaves the running hub and its files alone', async (t) => {
  const first = await startHub(t)
  const before = readFileSync(join(first.dir, 'hub.json'), 'utf8')
  const second = createHub({ stateDir: first.dir, port: first.port, tickMs: 0, log: () => {} })
  await assert.rejects(second.start(), (e) => e.code === 'EADDRINUSE')
  assert.equal(readFileSync(join(first.dir, 'hub.json'), 'utf8'), before)
  assert.equal((await raw({ port: first.port, path: '/hub/v1/health' })).json.hubId, first.hub.hubId)
  await second.stop()
  assert.equal(readFileSync(join(first.dir, 'hub.json'), 'utf8'), before, 'the loser must not remove it either')
})

test('a bind failure happens before any state is touched: no hub folder, no import', async (t) => {
  const dir = tmpDir(t)
  const blocker = createServer((req, res) => res.end('x'))
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r))
  t.after(() => blocker.close())
  writeFileSync(join(dir, 'queue.json'), JSON.stringify({ v: 1, seq: 1, items: [{ id: 'c1', type: 'completed', seq: 1, status: 'open', createdAt: 1 }] }))
  const hub = createHub({ stateDir: dir, port: blocker.address().port, tickMs: 0, log: () => {} })
  await assert.rejects(hub.start(), (e) => e.code === 'EADDRINUSE')
  assert.equal(existsSync(join(dir, 'hub')), false)
  assert.equal(existsSync(join(dir, 'hub.json')), false)
})

// ---- state, persistence, migration ---------------------------------------------------------------------------------------------

test('items fed in survive a clean stop and a new hub on the same folder (flush on shutdown)', async (t) => {
  const dir = tmpDir(t)
  const a = await startHub(t, { dir })
  const id = feed(a.hub, { summary: 'Did X.' })
  await postJson(a.port, P + '/v1/reviewed', { id: feed(a.hub, { sessionId: 'two' }) })
  await a.hub.stop()
  assert.ok(existsSync(join(dir, 'hub', 'queue.json')))
  const b = await startHub(t, { dir })
  const snap = (await raw({ port: b.port, path: P + '/v1/snapshot' })).json
  assert.deepEqual(snap.open.map((i) => i.id), [id])
  assert.equal(snap.resolved.length, 1)
  assert.equal(snap.snapshotId.split(':')[0], a.hub.store.epoch, 'the epoch survives, so a poll across a restart is not confused')
})

test('the first start writes hub/queue.json even when empty, so the legacy import cannot run twice', async (t) => {
  const { dir } = await startHub(t)
  assert.equal(readJson(join(dir, 'hub', 'queue.json')).v, 2)
})

test('the first start imports the legacy queue.json and vapid.json; the old files stay as they were', async (t) => {
  const dir = tmpDir(t)
  const legacy = JSON.stringify({ v: 1, seq: 3, items: [
    { id: 'q1', seq: 1, type: 'question', status: 'open', createdAt: 1000, sessionId: 'sq', payload: { questions: [{ question: 'Which?', options: [] }] } },
    { id: 'c2', seq: 2, type: 'completed', status: 'open', createdAt: 2000, sessionId: 'sc', summary: 'Did X.', payload: { reply: 'r' } },
  ] })
  writeFileSync(join(dir, 'queue.json'), legacy)
  writeFileSync(join(dir, 'vapid.json'), '{"publicKey":"P"}')
  const { port, logs } = await startHub(t, { dir })
  const snap = (await raw({ port, path: P + '/v1/snapshot' })).json
  assert.deepEqual(snap.open.map((i) => i.id), ['c2'], 'the question ended, the completed item is an open orphan')
  assert.deepEqual(snap.resolved.map((i) => [i.id, i.resolution.kind]), [['q1', 'session-ended']])
  assert.equal(readFileSync(join(dir, 'queue.json'), 'utf8'), legacy)
  assert.equal(readFileSync(join(dir, 'hub', 'vapid.json'), 'utf8'), '{"publicKey":"P"}')
  assert.ok(logs.some((l) => /imported/.test(l)))
})

test('a second start does not import again, even when the legacy file changed', async (t) => {
  const dir = tmpDir(t)
  writeFileSync(join(dir, 'queue.json'), JSON.stringify({ v: 1, seq: 1, items: [{ id: 'c1', seq: 1, type: 'completed', status: 'open', createdAt: 1, sessionId: 's' }] }))
  const a = await startHub(t, { dir })
  await a.hub.stop()
  writeFileSync(join(dir, 'queue.json'), JSON.stringify({ v: 1, seq: 2, items: [{ id: 'c9', seq: 2, type: 'completed', status: 'open', createdAt: 2, sessionId: 's9' }] }))
  const b = await startHub(t, { dir })
  assert.deepEqual(b.hub.store.list().map((i) => i.id), ['c1'])
})

test('a corrupt hub/queue.json is recovered from the .bak at start', async (t) => {
  const dir = tmpDir(t)
  const a = await startHub(t, { dir })
  feed(a.hub, { sessionId: 'one' })
  a.hub.store.flush()
  feed(a.hub, { sessionId: 'two' })
  await a.hub.stop()
  const file = join(dir, 'hub', 'queue.json')
  writeFileSync(file, readFileSync(file, 'utf8').slice(0, 40))
  const b = await startHub(t, { dir })
  assert.equal(b.hub.store.loadedFrom, 'bak')
  assert.ok(b.hub.store.list().length >= 1)
})

test('hub.config.json is read at start; a broken one is logged and the hub starts anyway', async (t) => {
  const dir = tmpDir(t)
  writeFileSync(join(dir, 'hub.config.json'), '{broken')
  const { hub, logs } = await startHub(t, { dir })
  assert.equal(hub.config.publicHost, undefined)
  assert.ok(logs.some((l) => /hub\.config\.json/.test(l)))
})

// ---- idle exit and housekeeping ------------------------------------------------------------------------------------------------

test('idle exit: no request for idleExitMs calls onIdle once; health probes do not count, other requests do', async (t) => {
  let now = 9_000_000_000_000
  let idle = 0
  const { port, hub } = await startHub(t, { now: () => now, idleExitMs: 1000, onIdle: () => { idle++ } })
  now += 999
  hub.tick()
  assert.equal(idle, 0)
  await raw({ port, path: '/hub/v1/health' })
  now += 2
  hub.tick()
  assert.equal(idle, 1, 'the health probe did not reset the clock')
  hub.tick()
  assert.equal(idle, 1, 'only once')
})

test('a real request resets the idle clock', async (t) => {
  let now = 9_000_000_000_000
  let idle = 0
  const { port, hub } = await startHub(t, { now: () => now, idleExitMs: 1000, onIdle: () => { idle++ } })
  now += 900
  await raw({ port, path: P + '/v1/snapshot' })
  now += 900
  hub.tick()
  assert.equal(idle, 0)
  now += 200
  hub.tick()
  assert.equal(idle, 1)
})

test('without idleExitMs the hub never calls onIdle', async (t) => {
  let now = 9_000_000_000_000
  let idle = 0
  const { hub } = await startHub(t, { now: () => now, idleExitMs: 0, onIdle: () => { idle++ } })
  now += 400 * 3600 * 1000
  hub.tick()
  assert.equal(idle, 0)
})

test('tick prunes resolved items past the retention', async (t) => {
  let now = 9_000_000_000_000
  const { hub } = await startHub(t, { now: () => now, retentionMs: 1000 })
  const id = feed(hub)
  hub.store.applyOp({ op: 'resolve', id, resolution: { kind: 'reviewed' } }, { owner: 'A1' })
  now += 1500
  hub.tick()
  assert.equal(hub.store.get(id), undefined)
})

test('the idle default is 12 hours and the periodic tick starts and stops with the hub', async (t) => {
  const { hub } = await startHub(t, { tickMs: 5 })
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(hub.ticks >= 2, 'the interval ran: ' + hub.ticks)
  await hub.stop()
  const after = hub.ticks
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(hub.ticks, after, 'no tick after stop')
  assert.equal(hub.idleExitMs, 12 * 3600 * 1000)
})

// ---- logging -------------------------------------------------------------------------------------------------------------------

test('the log holds no item text, reply, title, port or request detail', async (t) => {
  const { hub, port, logs } = await startHub(t)
  const id = feed(hub, { sessionTitle: 'TITLE-SECRET', summary: 'SUMMARY-SECRET', payload: { reply: 'REPLY-SECRET' } })
  await postJson(port, P + '/v1/reviewed', { id })
  await postJson(port, P + '/v1/answer', { id: 'x', answers: ['ANSWER-SECRET'] })
  await raw({ port, path: P + '/v1/snapshot', headers: { authorization: 'Bearer rqd_TOKEN-SECRET' } })
  await hub.stop()
  const text = logs.join('\n')
  assert.ok(text.length > 0)
  assert.doesNotMatch(text, /SECRET/)
  assert.equal(text.includes(String(port)), false)
})

test('without an injected log the hub logs to hub/hub.log', async (t) => {
  const dir = tmpDir(t)
  const hub = createHub({ stateDir: dir, port: 0, tickMs: 0 })
  await hub.start()
  await hub.stop()
  assert.match(readFileSync(join(dir, 'hub', 'hub.log'), 'utf8'), /started/)
  assert.equal(readFileSync(join(dir, 'hub', 'hub.log'), 'utf8').includes(String(hub.port)), false)
})
