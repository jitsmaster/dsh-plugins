import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionRegistry, candidatePaths } from '../sessions.js'
import { createLimiter, AbortedError } from '../limiter.js'

const makeDeps = (extra = {}) => {
  const calls = { repoInfo: [], listWorktrees: 0 }
  return {
    calls,
    deps: {
      repoInfo: async (p) => { calls.repoInfo.push(p); return undefined },
      listWorktrees: async () => { calls.listWorktrees++; return [] },
      busy: () => false,
      ...extra,
    },
  }
}

test('observe with no paths spawns no git', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gv-perf-')))
  try {
    const { calls, deps } = makeDeps()
    const reg = createSessionRegistry({ stateDir: join(dir, 's'), deps })
    reg.seen('p1', dir)
    await reg.observe('p1', { command: 'ls -la' })
    await reg.observe('p1', {})
    assert.equal(calls.repoInfo.length, 0)
    assert.equal(calls.listWorktrees, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('repeated observe calls within the TTL reuse the cached repo info', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gv-perf-')))
  try {
    const { calls, deps } = makeDeps({ repoInfo: async (p) => { calls.repoInfo.push(p); return { root: dir, commonDir: join(dir, '.git'), linked: false } } })
    const reg = createSessionRegistry({ stateDir: join(dir, 's'), deps })
    reg.seen('p2', dir)
    for (let i = 0; i < 5; i++) await reg.observe('p2', { workdir: dir })
    // one lookup of the session cwd, then one per probed path; the cwd lookup itself is cached.
    assert.equal(calls.repoInfo.filter(p => p === dir).length, 1 + 5, 'cwd looked up once + one probe per call')
    assert.equal(calls.listWorktrees, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('observe is skipped while the git queue is busy', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gv-perf-')))
  try {
    const { calls, deps } = makeDeps({ busy: () => true })
    const reg = createSessionRegistry({ stateDir: join(dir, 's'), deps })
    reg.seen('p3', dir)
    await reg.observe('p3', { workdir: dir })
    assert.equal(calls.repoInfo.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('candidatePaths stops collecting at 16 entries', () => {
  const cmd = Array.from({ length: 40 }, (_, i) => `cat C:\\d${i}\\f`).join(' && ')
  assert.ok(candidatePaths({ command: cmd }, 'C:\\base').length <= 8)
})

test('limiter skips queued jobs whose signal aborted, without running them', async () => {
  const lim = createLimiter(1, 8)
  let release
  const first = lim.run(() => new Promise(r => { release = r }))
  const ac = new AbortController()
  let ran = false
  const second = lim.run(async () => { ran = true }, ac.signal)
  ac.abort()
  await assert.rejects(second, AbortedError)
  assert.equal(lim.stats().queued, 0)
  release(); await first
  assert.equal(ran, false)
})
