import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOrCreateSecret, secretMatches } from '../hub/secret.js'
import { PROTOCOL } from '../hub/protocol.js'
import { createHub, PROTOCOL as HUB_PROTOCOL } from '../hub/hub.js'
import { tmpDir } from './hub-helpers.mjs'

test('the protocol constant starts at 1 and is the hub one', () => {
  assert.equal(PROTOCOL, 1)
  assert.equal(HUB_PROTOCOL, PROTOCOL)
  assert.equal(createHub({ stateDir: 'x' }).protocol, PROTOCOL)
})

test('a missing hub.secret is created: 32 random bytes as base64url, different every time', (t) => {
  const a = tmpDir(t)
  const b = tmpDir(t)
  const one = loadOrCreateSecret(a)
  assert.match(one, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(readFileSync(join(a, 'hub.secret'), 'utf8').trim(), one)
  assert.notEqual(loadOrCreateSecret(b), one)
})

test('an existing hub.secret is reused and never rotated', (t) => {
  const dir = tmpDir(t)
  const first = loadOrCreateSecret(dir)
  assert.equal(loadOrCreateSecret(dir), first)
  writeFileSync(join(dir, 'hub.secret'), 'x'.repeat(43) + '\r\n')
  assert.equal(loadOrCreateSecret(dir), 'x'.repeat(43))
})

test('an empty or garbled hub.secret is replaced by a fresh one', (t) => {
  const dir = tmpDir(t)
  writeFileSync(join(dir, 'hub.secret'), '  \n')
  const fresh = loadOrCreateSecret(dir)
  assert.match(fresh, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(readFileSync(join(dir, 'hub.secret'), 'utf8').trim(), fresh)
})

test('secretMatches compares in constant time and is false for anything that is not the same string', () => {
  const s = 'a'.repeat(43)
  assert.equal(secretMatches(s, s), true)
  assert.equal(secretMatches(s, 'a'.repeat(42) + 'b'), false)
  assert.equal(secretMatches(s, 'a'.repeat(42)), false)
  assert.equal(secretMatches(s, ''), false)
  assert.equal(secretMatches(s, undefined), false)
  assert.equal(secretMatches(s, 42), false)
})
