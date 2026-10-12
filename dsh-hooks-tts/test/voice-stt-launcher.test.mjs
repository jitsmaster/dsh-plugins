import assert from 'node:assert/strict'
import test from 'node:test'
import { createSttLauncher } from '../voice/stt-launcher.js'

function make(extra = {}) {
  const spawned = []
  const files = new Map()
  let t = 100000
  const l = createSttLauncher({
    dir: 'D:/stt',
    configFile: 'config.example.toml',
    port: 8890,
    probe: async () => false,
    exists: () => true,
    spawnDetached: (cmd, args, opts) => { spawned.push([cmd, args, opts]) },
    readLock: () => files.get('lock'),
    writeLock: (v) => files.set('lock', v),
    now: () => t,
    startupGraceMs: 120000,
    ...extra,
  })
  return { l, spawned, advance: (ms) => { t += ms }, files }
}

test('spawns the daemon with the venv python when the health probe fails', async () => {
  const h = make()
  assert.equal(await h.l.ensure(), 'started')
  assert.equal(h.spawned.length, 1)
  const [cmd, args, opts] = h.spawned[0]
  assert.match(cmd, /\.venv[\\/]Scripts[\\/]python\.exe$/)
  assert.deepEqual(args, ['-m', 'stt', 'serve', '--config', 'config.example.toml'])
  assert.equal(opts.cwd, 'D:/stt')
})

test('does nothing when the service already answers', async () => {
  const h = make({ probe: async () => true })
  assert.equal(await h.l.ensure(), 'running')
  assert.equal(h.spawned.length, 0)
})

test('does not respawn while a recent start is still loading models', async () => {
  const h = make()
  await h.l.ensure()
  h.advance(30000)
  assert.equal(await h.l.ensure(), 'starting')
  assert.equal(h.spawned.length, 1)
  h.advance(100000)
  assert.equal(await h.l.ensure(), 'started')
  assert.equal(h.spawned.length, 2)
})

test('a start recorded by another host process also counts', async () => {
  const h = make()
  h.files.set('lock', 100000 - 10000)
  assert.equal(await h.l.ensure(), 'starting')
  assert.equal(h.spawned.length, 0)
})

test('a missing STT install is reported, not spawned', async () => {
  const h = make({ exists: () => false })
  assert.equal(await h.l.ensure(), 'unavailable')
  assert.equal(h.spawned.length, 0)
})

test('a spawn failure is reported and retried after the grace period only', async () => {
  const h = make({ spawnDetached: () => { throw new Error('EACCES') } })
  assert.equal(await h.l.ensure(), 'failed')
  assert.match(h.l.lastError(), /EACCES/)
  assert.equal(await h.l.ensure(), 'starting')
})
