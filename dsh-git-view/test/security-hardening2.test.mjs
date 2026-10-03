import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, copyFileSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, readCommit, readDiff, repoInfo } from '../git.js'
import { findGit, gitExecutable, isUncOrDevicePath, setGitPath } from '../gitpath.js'
import { createLimiter, BusyError } from '../limiter.js'
import { createSessionRegistry, MAX_SESSION_ID, MAX_STORED_SESSIONS, candidatePaths } from '../sessions.js'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let tmp, repo, blob

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-view-h2-')))
  repo = join(tmp, 'repo'); mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@e.com'); sh(repo, 'config', 'user.name', 'T'); sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init')
  blob = sh(repo, 'rev-parse', 'HEAD:a.txt').trim()
})
after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* windows locks */ } })

test('a git.exe planted in the repo directory is never executed', { skip: process.platform !== 'win32' }, async () => {
  const planted = join(repo, 'git.exe')
  copyFileSync(process.execPath, planted) // node.exe cannot act as git: running it would fail the call
  try {
    const found = findGit({ path: `.;;${repo};${process.env.PATH}`, cwd: repo })
    assert.ok(found.toLowerCase() !== planted.toLowerCase(), 'planted exe must not be resolved')
    assert.ok(found.toLowerCase() === 'git' || found.toLowerCase().endsWith('git.exe'))
    assert.equal(gitExecutable().toLowerCase().startsWith(repo.toLowerCase()), false)
    const r = await git(repo, ['rev-parse', '--git-dir'])
    assert.equal(r.code, 0, r.stderr)
  } finally { rmSync(planted, { force: true }) }
})

test('findGit ignores relative and empty PATH entries; gitPath override wins', () => {
  assert.equal(findGit({ path: '.;bin;;rel', cwd: tmp, isWin: true }), 'git')
  setGitPath('relative/git')
  assert.notEqual(gitExecutable(), 'relative/git', 'relative override is ignored')
  setGitPath(process.execPath)
  assert.equal(gitExecutable(), process.execPath)
  setGitPath(undefined)
})

test('UNC / device paths are rejected lexically', async () => {
  for (const p of ['\\\\host\\share', '//host/share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x']) assert.equal(isUncOrDevicePath(p), true, p)
  assert.equal(isUncOrDevicePath('C:\\x'), false)
  assert.equal(await repoInfo('\\\\10.255.255.1\\share'), undefined)
  assert.deepEqual(candidatePaths({ workdir: '\\\\host\\s', file_path: '//h/x', command: 'cd \\\\?\\x' }, repo), [])
  const reg = createSessionRegistry({ stateDir: join(tmp, 'st-unc'), workspacePaths: () => ['\\\\host\\ws'] })
  assert.equal((await reg.resolve('u1', { cwdHint: '\\\\host\\ws\\x' })).ok, false)
  reg.seen('u2', '\\\\host\\share')
  assert.equal((await reg.resolve('u2')).ok, false, 'UNC cwd never stored')
})

test('observe only probes paths inside a known root', async () => {
  const outside = join(tmp, 'elsewhere'); mkdirSync(outside); sh(outside, 'init', '-q')
  const wt = join(tmp, 'wt'); sh(repo, 'worktree', 'add', '-q', '-b', 'feat', wt)
  const reg = createSessionRegistry({ stateDir: join(tmp, 'st-obs') })
  reg.seen('o1', repo)
  await reg.observe('o1', { workdir: outside })
  assert.equal((await reg.resolve('o1')).source, 'cwd')
  await reg.observe('o1', { workdir: wt })
  assert.equal((await reg.resolve('o1')).source, 'recorded')
})

test('session ids are bounded, charset-checked and the store is capped', async () => {
  const reg = createSessionRegistry({ stateDir: join(tmp, 'st-cap') })
  reg.seen('x'.repeat(MAX_SESSION_ID + 1), repo)
  reg.seen('bad id/..', repo)
  assert.equal((await reg.resolve('x'.repeat(MAX_SESSION_ID + 1))).ok, false)
  assert.equal((await reg.resolve('bad id/..')).ok, false)
  reg.seen('relative-cwd', 'some/relative')
  assert.equal((await reg.resolve('relative-cwd')).ok, false)
  for (let i = 0; i < MAX_STORED_SESSIONS + 20; i++) reg.seen(`s${i}`, repo)
  await new Promise(res => setTimeout(res, 350))
  const reloaded = createSessionRegistry({ stateDir: join(tmp, 'st-cap') })
  assert.equal((await reloaded.resolve('s0')).ok, false, 'oldest evicted')
  assert.equal((await reloaded.resolve(`s${MAX_STORED_SESSIONS + 19}`)).ok, true)
})

test('limiter caps concurrency and rejects beyond the queue', async () => {
  const lim = createLimiter(2, 3)
  let running = 0, peak = 0
  const releases = []
  const task = () => new Promise((done) => { running++; peak = Math.max(peak, running); releases.push(() => { running--; done() }) })
  const ok = [1, 2, 3, 4, 5].map(() => lim.run(task))
  await assert.rejects(lim.run(task), BusyError)
  assert.equal(lim.saturated(), true)
  let settled = false
  const all = Promise.all(ok).then(() => { settled = true })
  while (!settled) { releases.splice(0).forEach(f => f()); await new Promise(r => setTimeout(r, 5)) }
  await all
  assert.equal(peak, 2)
  assert.equal(lim.saturated(), false)
})

test('--literal-pathspecs: a magic pathspec is just a missing file', async () => {
  const r = await readDiff(repo, { scope: 'unstaged', path: ':(top)a.txt' })
  assert.equal(r.ok, true)
  const ls = await git(repo, ['ls-files', '--', '*.txt'])
  assert.equal(ls.stdout.trim(), '', 'globs are not expanded')
})

test('readCommit refuses a blob id', async () => {
  assert.equal((await readCommit(repo, blob)).ok, false)
  const head = sh(repo, 'rev-parse', 'HEAD').trim()
  assert.equal((await readCommit(repo, head)).ok, true)
})

test('hard-linked untracked files are not read', async () => {
  const outside = join(tmp, 'hl-outside.txt'); writeFileSync(outside, 'HARDLINKED SECRET\n')
  try { linkSync(outside, join(repo, 'hl.txt')) } catch { return } // hard links unavailable
  const r = await readDiff(repo, { scope: 'untracked', path: 'hl.txt' })
  assert.doesNotMatch(JSON.stringify(r), /SECRET/)
})
