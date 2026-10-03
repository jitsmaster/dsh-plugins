import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseStatusV2, parseNumstat, parseNameStatus, readStatus, readBranchCompare, readDiff, readSide,
  repoInfo, listWorktrees, readCommit, safeRef, safeRelPath, defaultBaseRef, readHistory,
} from '../git.js'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let tmp, repo, wt

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-view-')))
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@example.com')
  sh(repo, 'config', 'user.name', 'T')
  sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'old name.txt'), 'rename me\nline2\nline3\nline4\n')
  writeFileSync(join(repo, 'del.txt'), 'bye\n')
  sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init')
  // a feature branch in a linked worktree with two commits
  wt = join(tmp, 'wt')
  sh(repo, 'worktree', 'add', '-q', '-b', 'feature/x', wt)
  writeFileSync(join(wt, 'feat.txt'), 'f1\nf2\n')
  sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'feat: add feat')
  writeFileSync(join(wt, 'a.txt'), 'one\nTWO\nthree\nfour\n')
  sh(wt, 'commit', '-qam', 'feat: edit a')
})

after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* windows locks */ } })

test('parseStatusV2 handles ordinary, rename, untracked and unmerged records', () => {
  const raw = [
    '# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 h1 h2 dir/with space.txt',
    '2 R. N... 100644 100644 100644 h1 h2 R100 new.txt', 'old.txt',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt',
    '? loose.txt', '',
  ].join('\0')
  const { branch, entries } = parseStatusV2(raw)
  assert.deepEqual([branch.head, branch.upstream, branch.ahead, branch.behind], ['main', 'origin/main', 2, 1])
  assert.equal(entries[0].path, 'dir/with space.txt')
  assert.deepEqual([entries[0].index, entries[0].worktree], ['', 'M'])
  assert.deepEqual([entries[1].path, entries[1].origPath, entries[1].index], ['new.txt', 'old.txt', 'R'])
  assert.equal(entries[2].conflict, 'UU')
  assert.equal(entries[3].untracked, true)
})

test('parseNumstat reads plain, binary and rename rows', () => {
  const raw = ['3\t1\ta.txt', '-\t-\timg.png', '0\t0\t', 'old.txt', 'new.txt', ''].join('\0')
  const m = parseNumstat(raw)
  assert.deepEqual(m.get('a.txt'), { added: 3, deleted: 1, binary: false })
  assert.equal(m.get('img.png').binary, true)
  assert.ok(m.has('new.txt'))
})

test('parseNameStatus pairs rename paths', () => {
  const f = parseNameStatus(['M', 'a.txt', 'R100', 'old.txt', 'new.txt', 'A', 'b.txt', ''].join('\0'))
  assert.deepEqual(f.map(x => [x.status, x.path, x.origPath]), [['M', 'a.txt', undefined], ['R', 'new.txt', 'old.txt'], ['A', 'b.txt', undefined]])
})

test('repoInfo distinguishes the main tree from a linked worktree', async () => {
  const main = await repoInfo(repo)
  const linked = await repoInfo(wt)
  assert.equal(main.linked, false)
  assert.equal(linked.linked, true)
  assert.equal(linked.root, wt)
  assert.equal(await repoInfo(tmp), undefined)
})

test('listWorktrees returns main first plus the linked tree with its branch', async () => {
  const list = await listWorktrees(repo)
  assert.equal(list.length, 2)
  assert.equal(list[0].main, true)
  assert.equal(list[0].path, repo)
  assert.equal(list[1].branch, 'feature/x')
})

test('readStatus on a clean linked worktree reports branch and nothing pending', async () => {
  const s = await readStatus(wt)
  assert.equal(s.ok, true)
  assert.equal(s.linked, true)
  assert.equal(s.branch.name, 'feature/x')
  assert.deepEqual([s.staged.length, s.changes.length, s.untracked.length, s.conflicts.length], [0, 0, 0, 0])
})

test('readStatus separates staged, unstaged and untracked with line stats', async () => {
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n') // unstaged +2
  writeFileSync(join(repo, 'staged.txt'), 's1\ns2\ns3\n')
  sh(repo, 'add', 'staged.txt')
  writeFileSync(join(repo, 'new file.txt'), 'x\ny\n') // untracked, with a space
  mkdirSync(join(repo, 'sub'))
  writeFileSync(join(repo, 'sub', 'bin.dat'), Buffer.from([1, 2, 0, 3]))
  renameSync(join(repo, 'old name.txt'), join(repo, 'renamed.txt'))
  sh(repo, 'add', '-A', 'renamed.txt', 'old name.txt')
  rmSyncSafe(join(repo, 'del.txt'))

  const s = await readStatus(repo)
  assert.equal(s.ok, true)
  assert.equal(s.branch.name, 'main')
  const staged = Object.fromEntries(s.staged.map(f => [f.path, f]))
  assert.equal(staged['staged.txt'].status, 'A')
  assert.equal(staged['staged.txt'].stats.added, 3)
  assert.equal(staged['renamed.txt'].status, 'R')
  assert.equal(staged['renamed.txt'].origPath, 'old name.txt')
  const changes = Object.fromEntries(s.changes.map(f => [f.path, f]))
  assert.equal(changes['a.txt'].status, 'M')
  assert.deepEqual([changes['a.txt'].stats.added, changes['a.txt'].stats.deleted], [2, 0])
  assert.equal(changes['del.txt'].status, 'D')
  const untracked = Object.fromEntries(s.untracked.map(f => [f.path, f]))
  assert.equal(untracked['new file.txt'].stats.added, 2)
  assert.equal(untracked['sub/bin.dat'].stats.binary, true)
})

function rmSyncSafe(p) { rmSync(p, { force: true }) }

test('readDiff returns unified patches per scope and synthesizes untracked patches', async () => {
  const unstaged = await readDiff(repo, { scope: 'unstaged', path: 'a.txt' })
  assert.match(unstaged.patch, /^diff --git a\/a\.txt b\/a\.txt/m)
  assert.match(unstaged.patch, /^\+five$/m)
  const staged = await readDiff(repo, { scope: 'staged', path: 'staged.txt' })
  assert.match(staged.patch, /new file mode/)
  const untracked = await readDiff(repo, { scope: 'untracked', path: 'new file.txt' })
  assert.match(untracked.patch, /^@@ -0,0 \+1,2 @@$/m)
  assert.match(untracked.patch, /^\+x$/m)
  const bin = await readDiff(repo, { scope: 'untracked', path: 'sub/bin.dat' })
  assert.equal(bin.binary, true)
  const all = await readDiff(repo, { scope: 'all' })
  assert.match(all.patch, /a\.txt/)
  const full = await readDiff(repo, { scope: 'unstaged', path: 'a.txt', context: 100000 })
  assert.match(full.patch, /^ one$/m)
})

test('readDiff refuses paths that escape the repository', async () => {
  for (const p of ['../x', '..\\x', '/etc/passwd', 'C:\\Windows\\win.ini', 'a\0b', '']) {
    const r = await readDiff(repo, { scope: 'unstaged', path: p })
    assert.equal(r.ok, false, `accepted ${JSON.stringify(p)}`)
  }
  assert.equal(safeRelPath(repo, 'sub/../a.txt'), 'a.txt')
})

test('branch compare lists commits and files that are only on the feature branch', async () => {
  assert.equal(await defaultBaseRef(wt, 'feature/x'), 'main')
  const c = await readBranchCompare(wt, 'feature/x')
  assert.equal(c.ok, true)
  assert.equal(c.baseRef, 'main')
  assert.equal(c.ahead, 2)
  assert.equal(c.behind, 0)
  assert.deepEqual(c.commits.map(x => x.subject), ['feat: edit a', 'feat: add feat'])
  assert.deepEqual(c.files.map(f => [f.path, f.status]).sort(), [['a.txt', 'M'], ['feat.txt', 'A']])
  const diff = await readDiff(wt, { scope: 'branch', base: 'main', path: 'a.txt' })
  assert.match(diff.patch, /^\+TWO$/m)
})

test('readCommit lists the files of one commit and its diff', async () => {
  const sha = sh(wt, 'rev-parse', 'HEAD').trim()
  const c = await readCommit(wt, sha)
  assert.equal(c.ok, true)
  assert.equal(c.files[0].path, 'a.txt')
  const d = await readDiff(wt, { scope: 'commit', sha, path: 'a.txt' })
  assert.match(d.patch, /^-two$/m)
  assert.equal((await readCommit(wt, '--oops')).ok, false)
})

test('readHistory returns commits newest first with refs and parents', async () => {
  const h = await readHistory(wt, 10)
  assert.equal(h.ok, true)
  assert.deepEqual(h.commits.slice(0, 3).map(c => c.subject), ['feat: edit a', 'feat: add feat', 'init'])
  assert.equal(h.commits[0].head, true)
  assert.ok(h.commits[0].refs.includes('feature/x'))
  assert.equal(h.commits[0].parents.length, 1)
  assert.equal(h.hasUpstream, false)
  const one = await readHistory(wt, 1)
  assert.equal(one.commits.length, 1)
  assert.equal(one.hasMore, true)
})

test('ignoreWs hides whitespace-only edits', async () => {
  writeFileSync(join(wt, 'feat.txt'), 'f1  \nf2\n')
  const normal = await readDiff(wt, { scope: 'unstaged', path: 'feat.txt' })
  const quiet = await readDiff(wt, { scope: 'unstaged', path: 'feat.txt', ignoreWs: true })
  assert.match(normal.patch, /^\+f1  $/m)
  assert.equal(quiet.patch, '')
  sh(wt, 'checkout', '--', 'feat.txt')
})

test('merge conflicts show up as conflicts with an operation in progress', async () => {
  const c = join(tmp, 'conf')
  mkdirSync(c)
  sh(c, 'init', '-q', '-b', 'main')
  sh(c, 'config', 'user.email', 't@example.com'); sh(c, 'config', 'user.name', 'T'); sh(c, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(c, 'f.txt'), 'base\n'); sh(c, 'add', '.'); sh(c, 'commit', '-qm', 'base')
  sh(c, 'checkout', '-qb', 'other')
  writeFileSync(join(c, 'f.txt'), 'other\n'); sh(c, 'commit', '-qam', 'other')
  sh(c, 'checkout', '-q', 'main')
  writeFileSync(join(c, 'f.txt'), 'main\n'); sh(c, 'commit', '-qam', 'main')
  try { sh(c, 'merge', 'other') } catch { /* conflict expected */ }
  const s = await readStatus(c)
  assert.equal(s.operation, 'merge')
  assert.equal(s.conflicts.length, 1)
  assert.equal(s.conflicts[0].code, 'UU')
})

test('readSide reads image bytes from the index, HEAD and the working tree', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  writeFileSync(join(repo, 'pic.png'), png)
  const fresh = await readSide(repo, { scope: 'untracked', path: 'pic.png', side: 'new' })
  assert.deepEqual(fresh.data, png)
  assert.equal((await readSide(repo, { scope: 'untracked', path: 'pic.png', side: 'old' })).missing, true)
  assert.equal((await readSide(repo, { scope: 'unstaged', path: 'a.txt', side: 'new' })).ok, false, 'non-image refused')
})

test('safeRef rejects option-like and range-like refs', () => {
  for (const r of ['-x', '--output=f', 'a..b', 'a b', 'a:b', 'a~1', '']) assert.equal(safeRef(r), false, r)
  for (const r of ['main', 'origin/main', 'feature/x-1', 'v1.2.3']) assert.equal(safeRef(r), true, r)
})
