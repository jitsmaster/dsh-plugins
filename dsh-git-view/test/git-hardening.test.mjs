import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readStatus, readDiff, readSide, safeRelPath, MAX_COUNTED_UNTRACKED } from '../git.js'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let tmp, repo, outside

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-view-hard-')))
  repo = join(tmp, 'repo'); mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@e.com'); sh(repo, 'config', 'user.name', 'T'); sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, '.gitignore'), '.env\n')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init')
  outside = join(tmp, 'outside-secret.txt')
  writeFileSync(outside, 'TOP SECRET\n')
})
after(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* windows locks */ } })

/** Create a symlink, or return false when this account may not (Windows without developer mode). */
function trySymlink(target, link) {
  try { symlinkSync(target, link); return true } catch { return false }
}

test('untracked diff refuses gitignored files and anything under .git', async () => {
  writeFileSync(join(repo, '.env'), 'SECRET=1\n')
  writeFileSync(join(repo, 'plain.txt'), 'hello\n')
  const ignored = await readDiff(repo, { scope: 'untracked', path: '.env' })
  assert.equal(ignored.ok, false, 'gitignored file must be refused')
  assert.doesNotMatch(JSON.stringify(ignored), /SECRET/)
  const cfg = await readDiff(repo, { scope: 'untracked', path: '.git/config' })
  assert.equal(cfg.ok, false)
  assert.doesNotMatch(JSON.stringify(cfg), /\[core\]/)
  const tracked = await readDiff(repo, { scope: 'untracked', path: 'a.txt' })
  assert.equal(tracked.ok, false, 'tracked files are not untracked')
  const ok = await readDiff(repo, { scope: 'untracked', path: 'plain.txt' })
  assert.equal(ok.ok, true)
  assert.match(ok.patch, /^\+hello$/m)
})

test('untracked diff refuses dot-dot and .git segments in any form', async () => {
  for (const p of ['sub/../plain.txt', '.git/config', '.GIT/config', 'x/.git/config', '.git']) {
    assert.equal((await readDiff(repo, { scope: 'untracked', path: p })).ok, false, p)
  }
  assert.equal(safeRelPath(repo, '.git/config'), undefined)
  assert.equal(safeRelPath(repo, 'sub/.git/x'), undefined)
  assert.equal(safeRelPath(repo, '.gitignore'), '.gitignore', 'only a whole segment named .git is refused')
})

test('untracked image reads share the same untracked-only rule', async () => {
  writeFileSync(join(repo, 'secret.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  writeFileSync(join(repo, '.gitignore'), '.env\nsecret.png\n')
  const r = await readSide(repo, { scope: 'untracked', path: 'secret.png', side: 'new' })
  assert.equal(r.ok, false)
  writeFileSync(join(repo, '.gitignore'), '.env\n')
})

test('symlinks are never followed for untracked diffs or image reads', async (t) => {
  if (!trySymlink(outside, join(repo, 'link.txt'))) return t.skip('symlink creation not permitted')
  const png = join(tmp, 'outside.png')
  writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
  if (!trySymlink(png, join(repo, 'link.png'))) return t.skip('symlink creation not permitted')
  const d = await readDiff(repo, { scope: 'untracked', path: 'link.txt' })
  assert.equal(d.symlink, true)
  assert.equal(d.patch, '')
  assert.doesNotMatch(JSON.stringify(d), /TOP SECRET/)
  const b = await readSide(repo, { scope: 'untracked', path: 'link.png', side: 'new' })
  assert.equal(b.ok, false)
  assert.equal(b.data, undefined)
  const s = await readStatus(repo)
  const link = s.untracked.find(f => f.path === 'link.txt')
  assert.equal(link.stats, undefined, 'symlink targets are not read for line counts')
})

test('untracked line counts are capped after truncation and stay cheap', async () => {
  const many = join(tmp, 'many'); mkdirSync(many)
  sh(many, 'init', '-q', '-b', 'main')
  for (let i = 0; i < MAX_COUNTED_UNTRACKED + 50; i++) writeFileSync(join(many, `f${String(i).padStart(4, '0')}.txt`), 'x\ny\n')
  const s = await readStatus(many)
  assert.equal(s.untracked.length, MAX_COUNTED_UNTRACKED + 50)
  const counted = s.untracked.filter(f => f.stats).length
  assert.equal(counted, MAX_COUNTED_UNTRACKED)
  assert.equal(s.untracked[0].stats.added, 2)
  assert.equal(s.untracked[MAX_COUNTED_UNTRACKED].stats, undefined)
})

test('diff commands disable textconv and external diff drivers', async () => {
  const d = join(tmp, 'conv'); mkdirSync(d)
  sh(d, 'init', '-q', '-b', 'main')
  sh(d, 'config', 'user.email', 't@e.com'); sh(d, 'config', 'user.name', 'T'); sh(d, 'config', 'commit.gpgsign', 'false')
  const marker = join(tmp, 'textconv-ran')
  const script = join(tmp, 'conv.mjs').replace(/\\/g, '/')
  writeFileSync(script, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nconsole.log('CONVERTED')\n`)
  writeFileSync(join(d, '.gitattributes'), '*.txt diff=up\n')
  sh(d, 'config', 'diff.up.textconv', `node ${script}`)
  writeFileSync(join(d, 'a.txt'), 'one\n'); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'init')
  writeFileSync(join(d, 'a.txt'), 'two\n')
  const r = await readDiff(d, { scope: 'unstaged', path: 'a.txt' })
  assert.equal(r.ok, true)
  assert.match(r.patch, /^\+two$/m)
  assert.doesNotMatch(r.patch, /CONVERTED/)
  assert.equal(existsSync(marker), false, 'textconv program must not run')
})

// ---- review fixes ----

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

test('worktree image reads need a tracked or untracked-listed path and refuse ignored files', async () => {
  writeFileSync(join(repo, '.gitignore'), '.env\nign.png\n')
  writeFileSync(join(repo, 'ign.png'), PNG)
  for (const scope of ['unstaged', 'all']) {
    const r = await readSide(repo, { scope, path: 'ign.png', side: 'new' })
    assert.equal(r.data, undefined, `${scope}: ignored file must not be served`)
    assert.equal(r.ok, false)
  }
  writeFileSync(join(repo, 'tracked.png'), PNG); sh(repo, 'add', 'tracked.png'); sh(repo, 'commit', '-qm', 'png')
  writeFileSync(join(repo, 'tracked.png'), Buffer.concat([PNG, Buffer.from([1])]))
  const ok = await readSide(repo, { scope: 'unstaged', path: 'tracked.png', side: 'new' })
  assert.equal(ok.ok, true)
  assert.ok(ok.data && ok.data.length === 9)
  writeFileSync(join(repo, '.gitignore'), '.env\n')
})

test('image reads and untracked reads refuse paths through a directory junction/symlink', async (t) => {
  const outDir = join(tmp, 'outdir'); mkdirSync(outDir)
  writeFileSync(join(outDir, 'secret.png'), PNG)
  writeFileSync(join(outDir, 'note.txt'), 'TOP SECRET DIR\n')
  try { symlinkSync(outDir, join(repo, 'lnk'), 'junction') } catch { return t.skip('junction creation not permitted') }
  for (const scope of ['unstaged', 'all', 'untracked']) {
    const r = await readSide(repo, { scope, path: 'lnk/secret.png', side: 'new' })
    assert.equal(r.data, undefined, scope)
  }
  const d = await readDiff(repo, { scope: 'untracked', path: 'lnk/note.txt' })
  assert.doesNotMatch(JSON.stringify(d), /TOP SECRET DIR/)
  const s = await readStatus(repo)
  for (const f of s.untracked.filter(f => f.path.startsWith('lnk/'))) assert.equal(f.stats, undefined, 'no line count through a junction')
})

test('staged rename with an edit diffs as a rename when origPath is passed', async () => {
  const d = join(tmp, 'ren'); mkdirSync(d)
  sh(d, 'init', '-q', '-b', 'main')
  sh(d, 'config', 'user.email', 't@e.com'); sh(d, 'config', 'user.name', 'T'); sh(d, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(d, 'old.txt'), Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n')
  sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'init')
  sh(d, 'mv', 'old.txt', 'new.txt')
  writeFileSync(join(d, 'new.txt'), Array.from({ length: 20 }, (_, i) => i === 5 ? 'CHANGED' : `line ${i}`).join('\n') + '\n')
  sh(d, 'add', 'new.txt')
  const without = await readDiff(d, { scope: 'staged', path: 'new.txt' })
  assert.doesNotMatch(without.patch, /^rename from/m, 'baseline: new path alone shows an add')
  const withOrig = await readDiff(d, { scope: 'staged', path: 'new.txt', origPath: 'old.txt' })
  assert.equal(withOrig.ok, true)
  assert.match(withOrig.patch, /^rename from old\.txt$/m)
  assert.match(withOrig.patch, /^\+CHANGED$/m)
  assert.equal((await readDiff(d, { scope: 'staged', path: 'new.txt', origPath: '../x' })).ok, false)
  assert.equal((await readDiff(d, { scope: 'staged', path: 'new.txt', origPath: '.git/config' })).ok, false)
})

test('a status larger than the buffer reports a clear too-many-changes error', async () => {
  const d = join(tmp, 'big'); mkdirSync(d)
  sh(d, 'init', '-q', '-b', 'main')
  for (let i = 0; i < 50; i++) writeFileSync(join(d, `f${i}.txt`), 'x\n')
  const r = await readStatus(d, { maxBuffer: 200 })
  assert.equal(r.ok, false)
  assert.match(r.error, /too many changes/i)
})
