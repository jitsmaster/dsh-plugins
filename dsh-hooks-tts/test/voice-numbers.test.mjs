import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNumbers } from '../voice/numbers.js'

const dir = () => mkdtempSync(join(tmpdir(), 'numbers-'))
const at = (iso) => () => new Date(iso)

test('a session keeps its number and new sessions count up from one', () => {
  const n = createNumbers(dir(), at('2026-10-09T10:00:00'))
  assert.equal(n.numberFor('a'), 1)
  assert.equal(n.numberFor('b'), 2)
  assert.equal(n.numberFor('a'), 1)
})

test('numbers survive a restart on the same day', () => {
  const d = dir()
  createNumbers(d, at('2026-10-09T10:00:00')).numberFor('a')
  createNumbers(d, at('2026-10-09T10:00:00')).numberFor('b')
  const again = createNumbers(d, at('2026-10-09T18:00:00'))
  assert.equal(again.numberFor('a'), 1)
  assert.equal(again.numberFor('b'), 2)
  assert.equal(again.numberFor('c'), 3)
})

test('numbers start again the next local day', () => {
  let now = new Date('2026-10-09T23:59:00')
  const n = createNumbers(dir(), () => now)
  n.numberFor('a')
  n.numberFor('b')
  now = new Date('2026-10-10T00:01:00')
  assert.equal(n.numberFor('b'), 1)
  assert.equal(n.sessionFor(2), undefined)
})

test('sessionFor finds the session behind a number', () => {
  const n = createNumbers(dir(), at('2026-10-09T10:00:00'))
  n.numberFor('a')
  n.numberFor('b')
  assert.equal(n.sessionFor(2), 'b')
  assert.equal(n.sessionFor(9), undefined)
})

test('a corrupt state file or an unwritable folder does not break numbering', () => {
  const d = dir()
  writeFileSync(join(d, 'voice-numbers.json'), '{not json')
  assert.equal(createNumbers(d, at('2026-10-09T10:00:00')).numberFor('a'), 1)
  const missing = join(d, 'no', 'such', 'folder')
  const n = createNumbers(missing, at('2026-10-09T10:00:00'))
  assert.equal(n.numberFor('a'), 1)
  assert.equal(n.numberFor('b'), 2)
})

test('session ids that look like object keys are ordinary ids', () => {
  const d = dir()
  const n = createNumbers(d, at('2026-10-09T10:00:00'))
  assert.equal(n.numberFor('constructor'), 1)
  assert.equal(n.numberFor('__proto__'), 2)
  assert.equal(n.numberFor('toString'), 3)
  assert.equal(createNumbers(d, at('2026-10-09T11:00:00')).numberFor('constructor'), 1)
})

test('a state file with a non-numeric counter is ignored', () => {
  const d = dir()
  writeFileSync(join(d, 'voice-numbers.json'), JSON.stringify({ date: '2026-10-09', next: 'x', ids: { a: 'y' } }))
  assert.equal(createNumbers(d, at('2026-10-09T10:00:00')).numberFor('b'), 1)
})
