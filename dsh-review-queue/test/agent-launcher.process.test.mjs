// Process-level: the real launcher spawns the real hub (node hub/main.js, detached) on a temp state dir and a random port (never 47615),
// and every hub it started is shut down and verified dead afterwards.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createLauncher } from '../agent/launcher.js'
import { tmpdir } from 'node:os'
import { freePort, raw, waitFor } from './hub-helpers.mjs'

const pids = new Set() // every hub process this file saw, killed at the end whatever happens
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const hubPid = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'hub.json'), 'utf8')).pid } catch { return undefined } }
const secretOf = (dir) => readFileSync(join(dir, 'hub.secret'), 'utf8').trim()

const killAll = () => { for (const pid of pids) if (alive(pid)) { try { process.kill(pid) } catch { /* already gone */ } } }
after(killAll)
const track = (result) => { if (result?.info?.pid) pids.add(result.info.pid); return result }

const launcherIn = (dir, port, over = {}) => createLauncher({ stateDir: dir, port, env: process.env, ...over })
async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-hub-test-'))
  const port = await freePort()
  t.after(async () => {
    const pid = hubPid(dir)
    if (pid) pids.add(pid)
    if (pid && alive(pid)) await raw({ port, method: 'POST', path: '/hub/v1/shutdown', headers: { authorization: 'Bearer ' + secretOf(dir), 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
    for (const p of pids) await waitFor(() => !alive(p), 8000, 'hub process ' + p + ' gone').catch(() => killAll())
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, port }
}

test('ensureHub starts a real hub once, a second call finds it, the lock is gone and the child log exists', async (t) => {
  const { dir, port } = await setup(t)
  const first = track(await launcherIn(dir, port).ensureHub())
  assert.deepEqual([first.mode, first.spawned, first.info.port], ['hub', true, port])
  assert.equal(first.info.pid, hubPid(dir))
  assert.ok(alive(first.info.pid))
  assert.equal(existsSync(join(dir, 'hub.lock')), false)
  assert.ok(existsSync(join(dir, 'hub-process.log')))
  const second = track(await launcherIn(dir, port).ensureHub())
  assert.deepEqual([second.mode, second.spawned, second.info.hubId], ['hub', false, first.info.hubId])
})

test('three launchers racing for real: one hub process, all three connected to it', async (t) => {
  const { dir, port } = await setup(t)
  const results = (await Promise.all([1, 2, 3].map(() => launcherIn(dir, port).ensureHub()))).map(track)
  assert.deepEqual(results.map((r) => r.mode), ['hub', 'hub', 'hub'])
  assert.equal(new Set(results.map((r) => r.info.hubId)).size, 1)
  assert.equal(new Set(results.map((r) => r.info.pid)).size, 1)
  assert.equal(results.filter((r) => r.spawned).length <= 1, true)
})

test('a newer plugin protocol really restarts the hub: the old process is gone, a new one runs (and a hub still too old does not loop)', async (t) => {
  const { dir, port } = await setup(t)
  const old = track(await launcherIn(dir, port).ensureHub())
  const next = await launcherIn(dir, port, { minHubProtocol: 99, protocol: 99 }).ensureHub()
  assert.deepEqual([next.mode, next.status], ['standalone', 'unavailable'])
  await waitFor(() => !alive(old.info.pid), 8000, 'old hub gone')
  const now = await waitFor(() => hubPid(dir) && hubPid(dir) !== old.info.pid, 8000, 'new hub.json')
  assert.ok(now)
  assert.ok(alive(hubPid(dir)))
})
