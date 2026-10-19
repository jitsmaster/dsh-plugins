import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// RED tests: the new files of the todo draft / tune work are part of the package: listed in the test script and, for todo-tune.js, in "files".
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('the new test files are in the package.json test script', () => {
  const listed = pkg.scripts.test.replace(/^node --test\s+/, '').split(/\s+/)
  for (const f of ['client-todo-draft', 'client-todo-tune', 'mobile-todo-draft', 'todo-tune', 'todo-tune-server', 'agent-proxy-tune', 'plugin-todo-tune.integration', 'todo-tune-wiring']) assert.ok(listed.includes('test/' + f + '.test.mjs'), f)
})

test('todo-tune.js is published with the package and the helpers are not test files', () => {
  assert.ok(pkg.files.includes('todo-tune.js'))
  assert.ok(!pkg.scripts.test.includes('client-todo-helpers') && !pkg.scripts.test.includes('todo-tune-helpers'), 'helpers are imported, not run')
})

test('index.js documents and reads the promptTunePath setting', () => {
  const index = readFileSync(join(ROOT, 'index.js'), 'utf8')
  assert.match(index, /promptTunePath/)
  assert.match(index, /createTuner/)
})
