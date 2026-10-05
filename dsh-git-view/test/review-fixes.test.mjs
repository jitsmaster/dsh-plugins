import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { buildGitEnv, escapesRoot, git, mimeFor, readStatus, readSide, repoInfo, safeRelPath } from '../git.js'
import { memo } from '../server.js'
import { apply } from '../index.js'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let tmp, repo

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-view-rf-')))
  repo = join(tmp, 'repo'); mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@e.com'); sh(repo, 'config', 'user.name', 'T'); sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init')
})
after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* windows locks */ } })

test('git children get an allow-listed environment: secrets and inherited GIT_* are dropped', async () => {
  const env = buildGitEnv({ PATH: '/bin', Path: 'C:\\bin', SystemRoot: 'C:\\Windows', HOME: '/h', LC_ALL: 'C', LANG: 'en', ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86',
    SECRET_X: 'hunter2', GITHUB_TOKEN: 't', GIT_DIR: '/evil', GIT_EXTERNAL_DIFF: 'x', NODE_OPTIONS: '--require x' })
  assert.deepEqual(Object.keys(env).filter(k => /SECRET|TOKEN|NODE_OPTIONS|GIT_DIR|GIT_EXTERNAL/.test(k)), [])
  for (const k of ['PATH', 'SystemRoot', 'HOME', 'LC_ALL', 'LANG', 'ProgramFiles', 'ProgramFiles(x86)']) assert.ok(k in env, k)
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  // And git itself still works with that environment while a secret is set in the host process.
  process.env.SECRET_X = 'hunter2'
  try {
    const r = await git(repo, ['rev-parse', '--show-toplevel'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal((await repoInfo(repo)).root, repo)
  } finally { delete process.env.SECRET_X }
})

test('`..foo` is a legal name, `..` and `../x` escape', () => {
  assert.equal(escapesRoot('..'), true)
  assert.equal(escapesRoot('../x'), true)
  assert.equal(escapesRoot('..' + sep + 'x'), true)
  assert.equal(escapesRoot('..foo'), false)
  assert.equal(escapesRoot('..foo/bar'), false)
  assert.equal(safeRelPath(repo, '..foo'), '..foo')
  assert.equal(safeRelPath(repo, '..foo/bar.txt'), '..foo/bar.txt')
  assert.equal(safeRelPath(repo, '../x'), undefined)
  assert.equal(safeRelPath(repo, 'sub/../../x'), undefined)
})

test('mimeFor does not treat inherited Object members as image types', () => {
  for (const name of ['x.constructor', 'x.toString', 'x.__proto__', 'x.hasOwnProperty', 'constructor']) assert.equal(mimeFor(name), undefined, name)
  assert.equal(mimeFor('a/B.PNG'), 'image/png')
})

test('readBlob of a constructor "image" is refused', async () => {
  const r = await readSide(repo, { scope: 'staged', path: 'a.constructor', side: 'new' })
  assert.deepEqual([r.ok, r.error], [false, 'not a previewable image'])
})

test('readStatus reuses the caller\'s repo info for its own root, and reports busy as busy', async () => {
  const home = await repoInfo(repo)
  const s = await readStatus(repo, { home })
  assert.equal(s.ok, true)
  assert.equal(s.root, repo)
  // a busy repo lookup is not "not a git repository"
  const b = await readStatus(join(tmp, 'nowhere'), { home: { busy: true, root: join(tmp, 'nowhere') } })
  assert.equal(b.ok, false)
  assert.equal(b.busy, true)
  assert.doesNotMatch(b.error, /not a git repository/)
})

test('memo never keeps a busy answer: the next call asks again', async () => {
  let n = 0
  const call = memo(async () => (++n === 1 ? { ok: false, busy: true } : { ok: true, n }))
  assert.equal((await call('k')).busy, true)
  assert.equal((await call('k')).ok, true)
  assert.equal((await call('k')).n, 2, 'a good answer is memoised')
})

test('plugin load survives an unusable stateDir and a throwing agent/created handler', async () => {
  const blocker = join(tmp, 'file-not-dir'); writeFileSync(blocker, 'x')
  const handlers = {}
  const warnings = []
  let stop
  const ctx = { on: (n, f) => { handlers[n] = f }, effect: (f) => { stop = f() }, logger: { warn: (m) => warnings.push(m) } }
  assert.doesNotThrow(() => apply(ctx, { stateDir: join(blocker, 'sub'), port: 38091 }))
  try {
    assert.ok(warnings.some(w => /state directory unusable/.test(w)), warnings.join('|'))
    assert.doesNotThrow(() => handlers['agent/created']({ agent: { get id() { throw new Error('boom') } } }))
    assert.ok(warnings.some(w => /agent\/created failed/.test(w)))
  } finally { stop?.() }
})
