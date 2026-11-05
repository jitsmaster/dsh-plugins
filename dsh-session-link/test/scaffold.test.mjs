import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../index.js'

test('the plugin has a name, injects tools and exports apply', () => {
  assert.equal(plugin.name, 'session-link')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
})

test('package.json points at the patch and lists every runtime file', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  for (const f of ['index.js', 'match.js', 'envelope.js', 'sessions.js', 'send.js', 'guards.js', 'result.js', 'cordis.patch.yml', 'README.md']) assert.ok(pkg.files.includes(f), f)
})

test('package.json also lists starter.js, added with the start_session tool', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('starter.js'))
})

test('package.json also lists archiver.js, added with the archive_self tool', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('archiver.js'))
})
