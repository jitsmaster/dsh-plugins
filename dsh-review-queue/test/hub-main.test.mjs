// Process-level: spawn node hub/main.js with a temp state dir and a random port (never the real state, never port 47615).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort, raw, tmpDir, waitFor } from './hub-helpers.mjs'

const MAIN = fileURLToPath(new URL('../hub/main.js', import.meta.url))
const children = new Set()
after(() => { for (const c of children) c.kill() })

function spawnHub(args) {
  const env = { ...process.env }
  delete env.DSH_RQ_HUB_PORT; delete env.DSH_RQ_HUB_IDLE_MS; delete env.DSH_HOME
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env })
  children.add(child)
  const out = { stderr: '', stdout: '' }
  child.stderr.on('data', (d) => { out.stderr += d })
  child.stdout.on('data', (d) => { out.stdout += d })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  return { child, out, exited }
}
const readHubJson = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'hub.json'), 'utf8')) } catch { return undefined } }
const health = (port) => raw({ port, path: '/hub/v1/health' }).then((r) => r.json, () => undefined)
const cmd = (dir, port, ...extra) => ['--state-dir', dir, '--port', String(port), ...extra]

test('starts, publishes hub.json once it listens, and a shutdown message ends it cleanly: exit 0, hub.json gone, queue flushed', async (t) => {
  const dir = tmpDir(t)
  const port = await freePort()
  const hub = spawnHub(cmd(dir, port))
  const info = await waitFor(() => readHubJson(dir), 10_000, 'hub.json')
  assert.equal(info.pid, hub.child.pid)
  assert.equal(info.port, port)
  assert.equal((await health(port)).hubId, info.hubId)
  hub.child.send({ type: 'shutdown' })
  assert.deepEqual(await hub.exited, { code: 0, signal: null })
  assert.equal(existsSync(join(dir, 'hub.json')), false)
  assert.equal(JSON.parse(readFileSync(join(dir, 'hub', 'queue.json'), 'utf8')).v, 2)
})

test('a second hub on the same state dir and port exits 0 and leaves the first one untouched', async (t) => {
  const dir = tmpDir(t)
  const port = await freePort()
  const first = spawnHub(cmd(dir, port))
  const info = await waitFor(() => readHubJson(dir), 10_000, 'hub.json')
  const second = spawnHub(cmd(dir, port))
  assert.deepEqual(await second.exited, { code: 0, signal: null })
  assert.deepEqual(readHubJson(dir), info)
  assert.equal((await health(port)).hubId, info.hubId)
  first.child.send({ type: 'shutdown' })
  assert.equal((await first.exited).code, 0)
})

test('a foreign program on the port: exit 2, no hub.json, the other program keeps its port', async (t) => {
  const dir = tmpDir(t)
  const foreign = createServer((req, res) => res.end('hello'))
  await new Promise((r) => foreign.listen(0, '127.0.0.1', r))
  t.after(() => foreign.close())
  const hub = spawnHub(cmd(dir, foreign.address().port))
  assert.equal((await hub.exited).code, 2)
  assert.match(hub.out.stderr, /another program/)
  assert.equal(existsSync(join(dir, 'hub.json')), false)
  assert.equal((await raw({ port: foreign.address().port, path: '/' })).text, 'hello')
})

test('a program that only imitates the health answer (other hubId) is not taken for the hub', async (t) => {
  const dir = tmpDir(t)
  const fake = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, service: 'dsh-review-queue-hub', hubId: 'forged' })) })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  t.after(() => fake.close())
  writeFileSync(join(dir, 'hub.json'), JSON.stringify({ pid: 1, port: fake.address().port, hubId: 'real', version: 'x', protocol: 1, startedAt: 1 }))
  const hub = spawnHub(cmd(dir, fake.address().port))
  assert.equal((await hub.exited).code, 2)
})

test('a stale hub.json of a dead hub is replaced by the new one', async (t) => {
  const dir = tmpDir(t)
  const port = await freePort()
  writeFileSync(join(dir, 'hub.json'), JSON.stringify({ pid: 999999, port: 1, hubId: 'dead', version: 'x', protocol: 1, startedAt: 1 }))
  const hub = spawnHub(cmd(dir, port))
  const info = await waitFor(() => { const i = readHubJson(dir); return i && i.hubId !== 'dead' ? i : undefined }, 10_000, 'new hub.json')
  assert.equal(info.pid, hub.child.pid)
  hub.child.send({ type: 'shutdown' })
  assert.equal((await hub.exited).code, 0)
})

test('--idle-exit-ms ends an unused hub by itself, cleanly', async (t) => {
  const dir = tmpDir(t)
  const hub = spawnHub(cmd(dir, await freePort(), '--idle-exit-ms', '400'))
  await waitFor(() => readHubJson(dir), 10_000, 'hub.json')
  assert.deepEqual(await hub.exited, { code: 0, signal: null })
  assert.equal(existsSync(join(dir, 'hub.json')), false)
})

test('SIGTERM shuts down cleanly (signals are only deliverable on POSIX)', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tmpDir(t)
  const hub = spawnHub(cmd(dir, await freePort()))
  await waitFor(() => readHubJson(dir), 10_000, 'hub.json')
  hub.child.kill('SIGTERM')
  assert.equal((await hub.exited).code, 0)
  assert.equal(existsSync(join(dir, 'hub.json')), false)
})

test('a bad --port is refused with a message and exit 1; nothing is written', async (t) => {
  const dir = tmpDir(t)
  for (const bad of ['abc', '0x10', '70000', '-1', '']) {
    const hub = spawnHub(cmd(dir, bad))
    assert.equal((await hub.exited).code, 1, bad)
    assert.match(hub.out.stderr, /port/i)
  }
  assert.equal(existsSync(join(dir, 'hub.json')), false)
})

test('the port comes from --port, else DSH_RQ_HUB_PORT, else hub.config.json; the log has no port', async (t) => {
  const dir = tmpDir(t)
  const port = await freePort()
  writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ hubPort: port }))
  const hub = spawnHub(['--state-dir', dir])
  const info = await waitFor(() => readHubJson(dir), 10_000, 'hub.json')
  assert.equal(info.port, port)
  hub.child.send({ type: 'shutdown' })
  assert.equal((await hub.exited).code, 0)
  const log = readFileSync(join(dir, 'hub', 'hub.log'), 'utf8')
  assert.match(log, /started/)
  assert.equal(log.includes(String(port)), false)
  assert.equal(hub.out.stdout.includes(String(port)), false)
})
