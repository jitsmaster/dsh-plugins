import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const listPath = join(root, 'scripts', 'test-files.json')
const readList = () => JSON.parse(readFileSync(listPath, 'utf8'))

test('scripts.test is short (Windows cmd limit is 8191) and delegates to the runner', () => {
  assert.ok(pkg.scripts.test.length < 1000)
  assert.ok(pkg.scripts.test.startsWith('node scripts/run-tests.mjs'))
})

test('scripts/test-files.json is a list of unique, existing test files', () => {
  const list = readList()
  assert.ok(Array.isArray(list))
  assert.equal(new Set(list).size, list.length)
  for (const f of list) {
    assert.equal(typeof f, 'string')
    assert.ok(f.startsWith('test/') && f.endsWith('.test.mjs'), f)
    assert.ok(existsSync(join(root, f)), f)
  }
})

test('the list includes this file and package-files, and keeps the known-failing tests out', () => {
  const list = readList()
  assert.ok(list.includes('test/run-tests-script.test.mjs'))
  assert.ok(list.includes('test/package-files.test.mjs'))
  assert.ok(!list.includes('test/client-ui-command.test.mjs'))
  assert.ok(!list.includes('test/mobile-todo-effort.test.mjs'))
})

function run(body, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-'))
  const spec = join(dir, 'x.test.mjs')
  writeFileSync(spec, "import { test } from 'node:test'\n" + body)
  const list = join(dir, 'list.json')
  writeFileSync(list, JSON.stringify([spec]))
  return spawnSync(process.execPath, [join(root, 'scripts', 'run-tests.mjs'), ...extra], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined, RUN_TESTS_FILES_OVERRIDE: list } })
}

test('the runner propagates exit 0 from a passing test file, from any cwd', () => {
  const r = run("test('ok', () => {})")
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(!/too long/i.test(r.stdout + r.stderr))
})

test('the runner propagates a failing exit code', () => {
  const r = run("test('bad', () => { throw new Error('x') })")
  assert.notEqual(r.status, 0)
})

test('extra args go before the files', () => {
  const r = run("test('ok', () => {})", ['--test-name-pattern=__no_such_test__'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(!/# pass 1/.test(r.stdout))
})
