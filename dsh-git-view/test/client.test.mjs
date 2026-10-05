import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/** Evaluate the client bundle the way DSH does, with a stub `react`. */
function loadClient() {
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } } }, console, URLSearchParams, TextEncoder, TextDecoder, location: { hostname: '127.0.0.1' } }
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  const stubReact = { createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useMemo() {}, useCallback() {} }
  const mod = registered.factory((name) => { assert.equal(name, 'react'); return stubReact })
  return { registered, mod }
}

const { registered, mod } = loadClient()
// The bundle runs in its own vm realm; clone results so deepStrictEqual compares plain main-realm values.
const T = Object.fromEntries(Object.entries(mod.__test).map(([k, v]) => [k, typeof v === 'function' ? (...a) => { const r = v(...a); return r === undefined ? r : structuredClone(r) } : v]))

test('the bundle registers under the plugin id and exports the DSH client contract', () => {
  assert.equal(registered.id, 'dsh-git-view')
  assert.deepEqual(Array.from(mod.inject), ['slots', 'sidebarRightTabs'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.GitTab, 'function')
})

const SAMPLE = [
  'diff --git a/src/a.txt b/src/a.txt',
  'index 111..222 100644',
  '--- a/src/a.txt',
  '+++ b/src/a.txt',
  '@@ -1,4 +1,5 @@ function x()',
  ' one',
  '-two',
  '+TWO',
  '+extra',
  ' three',
  ' four',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+n1',
  '+n2',
  '\\ No newline at end of file',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/old.txt b/moved.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to moved.txt',
  '',
].join('\n')

test('parseUnifiedDiff reads files, statuses, hunks, counts and line numbers', () => {
  const files = T.parseUnifiedDiff(SAMPLE)
  assert.deepEqual(files.map(f => [f.path, f.status, f.binary]), [['src/a.txt', 'M', false], ['new.txt', 'A', false], ['img.png', 'M', true], ['moved.txt', 'R', false]])
  const a = files[0]
  assert.deepEqual([a.added, a.deleted], [2, 1])
  assert.equal(a.hunks[0].section, 'function x()')
  assert.deepEqual(a.hunks[0].lines.map(l => [l.t, l.o, l.n]), [['ctx', 1, 1], ['del', 2, undefined], ['add', undefined, 2], ['add', undefined, 3], ['ctx', 3, 4], ['ctx', 4, 5]])
  assert.equal(files[3].oldPath, 'old.txt')
  assert.deepEqual(T.parseUnifiedDiff(''), [])
})

test('parseUnifiedDiff keeps spaces in paths and survives "+++"-looking content', () => {
  const p = ['diff --git a/a b.txt b/a b.txt', '--- a/a b.txt', '+++ b/a b.txt', '@@ -1 +1 @@', '-x', '+++ y', ''].join('\n')
  const [f] = T.parseUnifiedDiff(p)
  assert.equal(f.path, 'a b.txt')
  assert.equal(f.hunks[0].lines[1].text, '++ y', 'content lines after the first hunk are never header lines')
})

test('parseUnifiedDiff understands combined (conflict) diffs', () => {
  const p = ['diff --cc f.txt', 'index a,b..c', '--- a/f.txt', '+++ b/f.txt', '@@@ -1,3 -1,3 +1,7 @@@', '  base', '++<<<<<<< ours', ' +mine', '++=======', '  tail', ''].join('\n')
  const [f] = T.parseUnifiedDiff(p)
  assert.equal(f.combined, true)
  assert.equal(f.path, 'f.txt')
  assert.deepEqual(f.hunks[0].lines.map(l => l.t), ['ctx', 'add', 'add', 'add', 'ctx'])
  assert.equal(f.hunks[0].lines[1].text, '<<<<<<< ours')
})

test('intraline highlights only the changed middle and ignores unrelated lines', () => {
  const r = T.intraline('const a = foo(1)', 'const a = bar(1)')
  assert.deepEqual(r.a, ['const a = ', 'foo', '(1)'])
  assert.deepEqual(r.b, ['const a = ', 'bar', '(1)'])
  assert.equal(T.intraline('same', 'same'), undefined)
  assert.equal(T.intraline('completely different', 'xyz 123 !!!!!!!!'), undefined)
})

const ctx = (n) => ({ t: 'ctx', text: 'c' + n, o: n, n })
test('segmentHunk folds long unchanged runs but keeps context next to changes', () => {
  const lines = [...Array.from({ length: 20 }, (_, i) => ctx(i + 1)), { t: 'add', text: 'x', n: 21 }, ...Array.from({ length: 20 }, (_, i) => ctx(i + 22))]
  const segs = T.segmentHunk(lines, 'k')
  const folds = segs.filter(s => s.kind === 'fold')
  assert.equal(folds.length, 2)
  assert.equal(folds[0].lines.length, 17, 'leading run keeps the last 3 lines')
  assert.equal(folds[1].lines.length, 17, 'trailing run keeps the first 3 lines')
  assert.equal(segs.filter(s => s.kind === 'line').length, 3 + 1 + 3)
  const small = T.segmentHunk([ctx(1), { t: 'del', text: 'd', o: 2 }, ctx(3)], 'k')
  assert.equal(small.some(s => s.kind === 'fold'), false)
})

test('pairRows lines up removed and added lines side by side', () => {
  const items = [
    { kind: 'line', line: ctx(1) },
    { kind: 'line', line: { t: 'del', text: 'a', o: 2 } }, { kind: 'line', line: { t: 'del', text: 'b', o: 3 } },
    { kind: 'line', line: { t: 'add', text: 'A', n: 2 } },
    { kind: 'line', line: { t: 'add', text: 'only-add', n: 3 } }, { kind: 'line', line: { t: 'add', text: 'x', n: 4 } },
  ]
  const rows = T.pairRows(items)
  assert.equal(rows.length, 4)
  assert.equal(rows[0].ctx, true)
  assert.deepEqual([rows[1].l.text, rows[1].r.text], ['a', 'A'])
  assert.deepEqual([rows[2].l.text, rows[2].r.text], ['b', 'only-add'])
  assert.equal(rows[3].l, undefined)
  assert.equal(rows[3].r.text, 'x')
})

test('buildTree compacts single-child directory chains and sorts naturally', () => {
  const tree = T.buildTree([{ path: 'a/b/c/f10.txt' }, { path: 'a/b/c/f2.txt' }, { path: 'root.txt' }, { path: 'z/one.txt' }, { path: 'z/sub/two.txt' }])
  assert.deepEqual(tree.map(n => n.type + ':' + n.name), ['dir:a/b/c', 'dir:z', 'file:root.txt'])
  assert.deepEqual(tree[0].children.map(n => n.name), ['f2.txt', 'f10.txt'])
  assert.equal(tree[1].count, 2)
  assert.equal(tree[1].children[0].name, 'sub')
})

test('filePlaceholder explains too-large, symlink and error entries instead of "No textual changes"', () => {
  assert.equal(T.filePlaceholder({ tooLarge: true }), 'File too large to diff')
  assert.match(T.filePlaceholder({ symlink: true }), /symbolic link/i)
  assert.equal(T.filePlaceholder({ error: 'invalid path' }), 'invalid path')
  assert.equal(T.filePlaceholder({ tooLarge: true, error: 'x' }), 'File too large to diff')
  assert.equal(T.filePlaceholder({ hunks: [] }), undefined)
})

test('relTime and cleanRef format display strings', () => {
  assert.equal(T.relTime(Date.now() - 5_000), 'just now')
  assert.equal(T.relTime(Date.now() - 3 * 3_600_000), '3h ago')
  assert.equal(T.cleanRef('refs/remotes/origin/main'), 'origin/main')
  assert.equal(T.cleanRef('tag: v1'), 'tag: v1')
})

test('parseUnifiedDiff strips the trailing TAB git adds to ---/+++ paths with spaces', () => {
  const patch = ['diff --git a/my file.txt b/my file.txt', 'index 1..2 100644', '--- a/my file.txt\t', '+++ b/my file.txt\t', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
  const [f] = T.parseUnifiedDiff(patch)
  assert.equal(f.oldPath, 'my file.txt')
  assert.equal(f.newPath, 'my file.txt')
  assert.equal(f.path, 'my file.txt')
})

test('parseUnifiedDiff handles quoted a/ b/ headers', () => {
  const patch = ['diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"', 'index 1..2 100644', '--- "a/we\\"ird.txt"', '+++ "b/we\\"ird.txt"', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
  const [f] = T.parseUnifiedDiff(patch)
  assert.equal(f.oldPath, 'we"ird.txt')
  assert.equal(f.newPath, 'we"ird.txt')
  const tabbed = ['diff --git "a/x y.txt" "b/x y.txt"', '--- "a/x y.txt"\t', '+++ "b/x y.txt"\t', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
  assert.equal(T.parseUnifiedDiff(tabbed)[0].path, 'x y.txt')
})
