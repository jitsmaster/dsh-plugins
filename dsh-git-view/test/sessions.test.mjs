import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionRegistry, candidatePaths } from '../sessions.js'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let tmp, repo, wt, other, state

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-view-s-')))
  repo = join(tmp, 'repo'); mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@e.com'); sh(repo, 'config', 'user.name', 'T'); sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init')
  wt = join(tmp, 'wt'); sh(repo, 'worktree', 'add', '-q', '-b', 'feat', wt)
  other = join(tmp, 'other'); mkdirSync(other)
  sh(other, 'init', '-q', '-b', 'main')
  state = join(tmp, 'state')
})
after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* windows locks */ } })

test('candidatePaths finds workdir, cd targets, git -C and absolute paths', () => {
  const c = candidatePaths({ workdir: 'sub', command: 'cd D:\\x\\wt && git -C "D:/y/z" status; cat C:\\a\\b.txt' }, 'D:\\base')
  assert.ok(c.some(p => p.endsWith('sub')))
  assert.ok(c.includes('D:\\x\\wt'))
  assert.ok(c.includes('D:/y/z'))
  assert.ok(c.some(p => p.startsWith('C:\\a')))
})

test('an unknown session without a registered workspace is refused', async () => {
  const reg = createSessionRegistry({ stateDir: state })
  const r = await reg.resolve('nope', { cwdHint: repo })
  assert.equal(r.ok, false)
})

test('the browser cwd hint is honoured only inside a registered workspace', async () => {
  const reg = createSessionRegistry({ stateDir: state, workspacePaths: () => [repo] })
  assert.equal((await reg.resolve('s-other', { cwdHint: other })).ok, false)
  const r = await reg.resolve('s-hint', { cwdHint: repo })
  assert.equal(r.ok, true)
  assert.equal(r.root, repo)
})

test('a session in the main tree shows the main tree until it works in a linked worktree', async () => {
  const reg = createSessionRegistry({ stateDir: join(tmp, 'state2') })
  reg.seen('s1', repo)
  let r = await reg.resolve('s1')
  assert.equal(r.source, 'cwd')
  assert.equal(r.root, repo)

  await reg.observe('s1', { command: `git -C "${wt}" status` })
  r = await reg.resolve('s1')
  assert.equal(r.source, 'recorded')
  assert.equal(r.root, wt)
  assert.equal(r.worktrees.length, 2)
})

test('touching a different repository never changes the target', async () => {
  const reg = createSessionRegistry({ stateDir: join(tmp, 'state3') })
  reg.seen('s2', repo)
  await reg.observe('s2', { workdir: other })
  assert.equal((await reg.resolve('s2')).source, 'cwd')
})

test('the no-worktree-list path validates the recorded worktree like the snapshot does', async () => {
  const dir = join(tmp, 'state4')
  mkdirSync(dir, { recursive: true })
  const rec = (root) => ({ cwd: repo, worktree: { root, at: 'x' } })
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ good: rec(wt), foreign: rec(other), plain: rec(tmp) }))
  const reg = createSessionRegistry({ stateDir: dir })
  for (const opts of [{ worktrees: true }, { worktrees: false }]) {
    assert.equal((await reg.resolve('good', opts)).root, wt, JSON.stringify(opts))
    for (const id of ['foreign', 'plain']) {
      const r = await reg.resolve(id, opts)
      assert.deepEqual([r.root, r.source], [repo, 'cwd'], `${id} ${JSON.stringify(opts)}`)
    }
  }
})

test('a busy git answer is reported as busy, not as "not a git repository"', async () => {
  const dir = join(tmp, 'state4b')
  const reg = createSessionRegistry({ stateDir: dir, deps: { repoInfo: async () => ({ busy: true }) } })
  reg.seen('b1', repo)
  const r = await reg.resolve('b1')
  assert.deepEqual([r.ok, r.busy], [false, true])
  assert.doesNotMatch(r.error, /not a git repository/)
})

test('recorded worktrees survive a host restart', async () => {
  const dir = join(tmp, 'state5')
  const a = createSessionRegistry({ stateDir: dir })
  a.seen('s4', repo)
  await a.observe('s4', { workdir: wt })
  await new Promise(r => setTimeout(r, 400)) // debounce flush
  const b = createSessionRegistry({ stateDir: dir })
  const r = await b.resolve('s4')
  assert.equal(r.source, 'recorded')
  assert.equal(r.root, wt)
})

test('session ids like __proto__ are plain keys and persist without poisoning lookups', async () => {
  const dir = join(tmp, 'state7')
  const a = createSessionRegistry({ stateDir: dir })
  a.seen('__proto__', repo)
  a.seen('constructor', repo)
  assert.equal((await a.resolve('other-unknown')).ok, false)
  assert.equal(({}).cwd, undefined, 'Object.prototype untouched')
  await new Promise(r => setTimeout(r, 400)) // debounce flush
  const b = createSessionRegistry({ stateDir: dir })
  assert.equal((await b.resolve('__proto__')).ok, true)
  assert.equal((await b.resolve('toString')).ok, false)
})

test('a sessions.json that is not an object is tolerated', async () => {
  for (const [i, content] of ['null', '[1,2]', '"str"', '42', '{"x":5}'].entries()) {
    const dir = join(tmp, 'state8-' + i)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sessions.json'), content)
    const reg = createSessionRegistry({ stateDir: dir })
    reg.seen('s', repo)
    assert.equal((await reg.resolve('s')).ok, true, content)
  }
})

test('a session whose folder is not a git repository reports that', async () => {
  const reg = createSessionRegistry({ stateDir: join(tmp, 'state6') })
  const plain = join(tmp, 'plain'); mkdirSync(plain)
  reg.seen('s5', plain)
  const r = await reg.resolve('s5')
  assert.equal(r.ok, false)
  assert.match(r.error, /not a git repository/)
})

test('observe clears a recorded worktree when a tool call works in the home main tree', async () => {
  const reg = createSessionRegistry({ stateDir: join(tmp, 'state9') })
  reg.seen('s9', repo)
  await reg.observe('s9', { workdir: wt })
  assert.equal((await reg.resolve('s9')).source, 'recorded')
  // A merely mentioned path (file_path / absolute path in a command) must not clear it.
  await reg.observe('s9', { file_path: join(repo, 'a.txt'), command: `cat ${join(repo, 'a.txt')}` })
  assert.equal((await reg.resolve('s9')).source, 'recorded')
  await reg.observe('s9', { command: `git -C "${repo}" status` })
  const r = await reg.resolve('s9')
  assert.equal(r.source, 'cwd')
  assert.equal(r.root, repo)
  await reg.observe('s9', { workdir: wt })
  assert.equal((await reg.resolve('s9')).source, 'recorded', 'can be re-recorded')
  await reg.observe('s9', { workdir: repo })
  assert.equal((await reg.resolve('s9')).source, 'cwd')
})
