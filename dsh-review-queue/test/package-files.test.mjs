import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// package.json "files" is what an installed plugin contains: a top-level module that index.js (or anything it imports) loads must be listed, or the plugin breaks once published.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const listed = new Set(pkg.files)
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|(?:^|\n)\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/g

/** Every module reachable from the entry through relative imports (paths relative to the package, forward slashes). */
function closure(entry) {
  const seen = new Set()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(join(root, file), 'utf8')
    for (const m of text.matchAll(IMPORT)) {
      const target = relative(root, join(root, dirname(file), m[1] ?? m[2])).split(sep).join('/')
      if (target.endsWith('.js')) walk(target)
    }
  }
  walk(entry)
  return [...seen]
}
const covered = (file) => listed.has(file) || listed.has(file.split('/')[0])

test('every module index.js loads is part of the published files (a top-level module by name, a folder by its name)', () => {
  const missing = closure('index.js').filter((f) => !covered(f))
  assert.deepEqual(missing, [])
})

test('todo.js, which service.js imports, is listed', () => {
  assert.ok(closure('service.js').includes('todo.js'), 'service.js reaches todo.js')
  assert.ok(listed.has('todo.js'))
})

test('every top-level module of the plugin is listed, so a new one cannot be forgotten', () => {
  const tops = readdirSync(root).filter((f) => f.endsWith('.js'))
  assert.deepEqual(tops.filter((f) => !listed.has(f)), [])
})

test('the entry modules of the follow-up feature and the modules they import are listed', () => {
  for (const entry of ['service.js', 'todo.js', 'todo-follow-up.js', 'follow-up.js', 'follow-up-shared.js', 'hub/follow-up.js']) {
    assert.deepEqual(closure(entry).filter((f) => !covered(f)), [], entry)
  }
})

test('hub/routing.js reaches neither the summariser, the speech text nor the todo service: the hub bundle takes isSentFollowUp from the leaf module', () => {
  const reached = closure('hub/routing.js')
  for (const heavy of ['summary.js', 'speech.js', 'actionable.js', 'todo.js', 'todo-follow-up.js', 'thread.js']) assert.ok(!reached.includes(heavy), 'hub/routing.js reaches ' + heavy)
  assert.ok(reached.includes('follow-up-shared.js'))
})
