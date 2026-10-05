import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGitEnv, readBranchCompare, readStatus, repoInfo, withGitSignal } from '../git.js'
import { gitExecutable, setGitPath, MISSING_RETRY_MS } from '../gitpath.js'
import { createSessionRegistry } from '../sessions.js'
import { startServer } from '../server.js'
import { apply } from '../index.js'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const PORT = 38085
const ORIGIN = 'http://127.0.0.1:3080'
let tmp, repo, wt

function init(dir) {
  mkdirSync(dir, { recursive: true })
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.email', 't@e.com'); sh(dir, 'config', 'user.name', 'T'); sh(dir, 'config', 'commit.gpgsign', 'false')
}

function call(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, agent: false, headers: { Origin: ORIGIN } }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => { let json; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not json */ } resolve({ status: res.statusCode, json }) })
    })
    req.on('error', reject)
    req.end()
  })
}

/** A signal that reads as "not aborted" for the first `n` checks and aborted afterwards: sheds a git run part-way through a call. */
const flipSignal = (n) => { let reads = 0; return { get aborted() { return reads++ >= n }, addEventListener() {}, removeEventListener() {} } }

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-view-rf2-')))
  repo = join(tmp, 'repo'); init(repo)
  writeFileSync(join(repo, 'a.txt'), 'one\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init')
  wt = join(tmp, 'wt'); sh(repo, 'worktree', 'add', '-q', '-b', 'feat', wt)
  writeFileSync(join(wt, 'a.txt'), 'one\ntwo\n'); sh(wt, 'commit', '-qam', 'feat')
})
after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* windows locks */ } })

// ---- 1. busy / aborted git inside a compare or status is never an answer ------------------------

test('readBranchCompare reports busy (never a false clean branch) however far into the call git is shed', async () => {
  const full = await readBranchCompare(wt, 'feat')
  assert.equal(full.ok, true)
  assert.equal(full.files.length, 1)
  let busy = 0
  for (let n = 0; n < 40; n += 2) {
    const r = await withGitSignal(flipSignal(n), () => readBranchCompare(wt, 'feat'))
    if (r.ok === false) { assert.equal(r.busy, true, `n=${n}: a shed run must be busy, got ${JSON.stringify(r)}`); assert.ok(r.error); busy++ } else assert.deepEqual(r, full, `n=${n}`)
  }
  assert.ok(busy > 5, 'the sweep must actually shed some runs')
})

test('readBranchCompare is busy when only the diff / rev-list calls are shed', async () => {
  // n chosen by sweep above covers it; this pins the pre-aborted case (every call shed).
  const r = await withGitSignal(flipSignal(0), () => readBranchCompare(wt, 'feat'))
  assert.deepEqual([r.ok, r.busy], [false, true])
  assert.doesNotMatch(r.error, /no base branch|no common ancestor/)
})

test('readStatus is busy rather than silently empty when only numstat / stash calls are shed', async () => {
  writeFileSync(join(wt, 'a.txt'), 'one\ntwo\nthree\n'); sh(wt, 'add', 'a.txt')
  writeFileSync(join(wt, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  const full = await readStatus(wt)
  assert.equal(full.ok, true)
  assert.equal(full.staged[0].stats.added, 1)
  let busy = 0
  for (let n = 0; n < 40; n += 2) {
    const r = await withGitSignal(flipSignal(n), () => readStatus(wt))
    if (r.ok === false) { assert.equal(r.busy, true, `n=${n}: ${JSON.stringify(r)}`); busy++ } else assert.deepEqual(r, full, `n=${n}: partial status leaked`)
  }
  assert.ok(busy > 5)
})

test('snapshot: a busy compare answers 429, is not cached, and leaves the remembered base alone', async () => {
  const real = createSessionRegistry({ stateDir: join(tmp, 'st-busy') })
  real.seen('sess', wt)
  const answers = [{ ok: false, busy: true, error: 'busy' }, { ok: true, baseRef: 'fake-base-xyz', mergeBase: 'x', ahead: 0, behind: 0, files: [] }, { ok: false, busy: true, error: 'busy' }]
  let calls = 0
  const handle = startServer({ registry: real, logger: { warn: () => {} }, port: PORT, webUrl: ORIGIN, deps: { readBranchCompare: async () => answers[calls++] } })
  await new Promise(r => handle.server.once('listening', r))
  try {
    assert.equal((await call('/v1/snapshot?session=sess')).status, 429)
    const ok = await call('/v1/snapshot?session=sess') // would be a cache hit if the busy answer had been memoised
    assert.equal(ok.status, 200)
    assert.equal(ok.json.compare.baseRef, 'fake-base-xyz')
    await sleep(900) // let the memoised answer expire
    assert.equal((await call('/v1/snapshot?session=sess')).status, 429)
    assert.equal(calls, 3)
    // The base recorded by the good snapshot survives the busy one (a deleted entry would fall back to the real 'main').
    const d = await call('/v1/diff?session=sess&scope=branch&path=a.txt')
    assert.match(d.json.error ?? '', /no common ancestor/, JSON.stringify(d.json))
  } finally { handle.close() }
})

// ---- 4. base ref is per branch ------------------------------------------------------------------

test('after a checkout the branch diff uses the new branch\'s base, not the previous branch\'s', async () => {
  const r2 = join(tmp, 'repo-base'); init(r2)
  writeFileSync(join(r2, 'a.txt'), 'one\n'); sh(r2, 'add', '.'); sh(r2, 'commit', '-qm', 'init')
  sh(r2, 'branch', 'develop') // develop stays behind main
  writeFileSync(join(r2, 'm.txt'), 'main only\n'); sh(r2, 'add', '.'); sh(r2, 'commit', '-qm', 'main moves')
  sh(r2, 'checkout', '-qb', 'feature')
  writeFileSync(join(r2, 'f.txt'), 'f\n'); sh(r2, 'add', '.'); sh(r2, 'commit', '-qm', 'feat')
  const reg = createSessionRegistry({ stateDir: join(tmp, 'st-base') })
  reg.seen('b', r2)
  const handle = startServer({ registry: reg, logger: { warn: () => {} }, port: PORT, webUrl: ORIGIN })
  await new Promise(r => handle.server.once('listening', r))
  try {
    assert.equal((await call('/v1/snapshot?session=b')).json.compare.baseRef, 'main')
    sh(r2, 'checkout', '-q', 'main') // on main the base can no longer be main: it is develop
    await sleep(900)
    const d = await call('/v1/diff?session=b&scope=branch&path=m.txt')
    assert.match(d.json.patch ?? '', /^\+main only$/m, `stale base reused: ${JSON.stringify(d.json)}`)
  } finally { handle.close() }
})

// ---- 2. nested repositories ---------------------------------------------------------------------

test('working in a nested repository under the main tree does not clear the recorded worktree', async () => {
  const reg = createSessionRegistry({ stateDir: join(tmp, 'st-nested') })
  reg.seen('n1', repo)
  await reg.observe('n1', { command: `git -C "${wt}" status` })
  assert.equal((await reg.resolve('n1')).source, 'recorded')
  const nested = join(repo, 'vendor', 'other-repo'); init(nested)
  writeFileSync(join(nested, 'x.txt'), 'x\n'); sh(nested, 'add', '.'); sh(nested, 'commit', '-qm', 'n')
  await reg.observe('n1', { workdir: nested })
  assert.equal((await reg.resolve('n1')).source, 'recorded', 'a nested repo is not the main tree')
  await reg.observe('n1', { workdir: repo }) // the real main tree still clears it
  assert.equal((await reg.resolve('n1')).source, 'cwd')
})

// ---- 3. missing git -----------------------------------------------------------------------------

test('buildGitEnv forwards XDG_CONFIG_HOME, PATHEXT and ComSpec', () => {
  const env = buildGitEnv({ XDG_CONFIG_HOME: '/x', PATHEXT: '.EXE', ComSpec: 'C:\\cmd.exe', SECRET_TOKEN: 's' })
  assert.equal(env.XDG_CONFIG_HOME, '/x'); assert.equal(env.PATHEXT, '.EXE'); assert.equal(env.ComSpec, 'C:\\cmd.exe')
  assert.equal(env.SECRET_TOKEN, undefined)
})

test('a missing git executable is looked up once per retry interval, not on every call', () => {
  setGitPath(undefined)
  let finds = 0, clock = 1000
  const deps = { find: () => { finds++; return undefined }, now: () => clock }
  assert.equal(gitExecutable(deps), undefined)
  assert.equal(gitExecutable(deps), undefined)
  assert.equal(gitExecutable(deps), undefined)
  assert.equal(finds, 1, 'PATH is not rescanned while the miss is cached')
  clock += MISSING_RETRY_MS + 1
  assert.equal(gitExecutable({ ...deps, find: () => { finds++; return 'C:\\git\\git.exe' } }), 'C:\\git\\git.exe', 'retried after the interval')
  assert.equal(finds, 2)
  setGitPath(undefined)
})

test('with no git, repoInfo / readStatus / resolve say so instead of "not a git repository"', async () => {
  const empty = join(tmp, 'empty-path'); mkdirSync(empty)
  const oldPath = process.env.PATH
  setGitPath(undefined)
  process.env.PATH = empty
  try {
    assert.deepEqual(await repoInfo(repo), { missing: true })
    const st = await readStatus(repo)
    assert.deepEqual([st.ok, st.error], [false, 'git executable not found'])
    const reg = createSessionRegistry({ stateDir: join(tmp, 'st-missing') })
    reg.seen('m', repo)
    const r = await reg.resolve('m')
    assert.deepEqual([r.ok, r.error], [false, 'git executable not found'])
  } finally { process.env.PATH = oldPath; setGitPath(undefined) }
  assert.ok((await repoInfo(repo)).root, 'git is found again once PATH is restored')
})

// ---- persist:false ------------------------------------------------------------------------------

test('persist:false keeps the registry in memory: nothing is written', async () => {
  const dir = join(tmp, 'never-created')
  const reg = createSessionRegistry({ stateDir: dir, persist: false })
  reg.seen('p1', repo)
  assert.equal((await reg.resolve('p1')).ok, true)
  await sleep(450)
  assert.equal(existsSync(dir), false)
})

test('plugin apply() with an unusable stateDir writes nothing into the host cwd', async () => {
  const cwd = join(tmp, 'host-cwd'); mkdirSync(cwd)
  const oldCwd = process.cwd()
  const handlers = {}, effects = []
  const ctx = { logger: { warn() {} }, on: (name, fn) => { handlers[name] = fn }, effect: (fn) => effects.push(fn()) }
  process.chdir(cwd)
  try {
    apply(ctx, { stateDir: 12345, port: 38086 })
    handlers['agent/created']({ agent: { id: 'a1', session: { header: { cwd: repo } } } })
    await sleep(450)
    assert.deepEqual(execFileSync(process.execPath, ['-e', 'console.log(require("fs").readdirSync(process.cwd()).length)'], { cwd }).toString().trim(), '0')
  } finally { effects.forEach(stop => stop?.()); process.chdir(oldCwd) }
})
