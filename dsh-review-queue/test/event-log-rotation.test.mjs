// Review fixes for event-log.js: a failed rotation must not stop the log, and the size is tracked in memory (no stat per event).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventLog } from '../event-log.js'

const ev = (i) => ({ kind: 'tiered', itemId: 'item-' + i, type: 'completed', tier: 3 })

test('a failed rotation (the .old name is blocked) truncates and the log keeps working', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evlog-'))
  const file = join(dir, 'queue-events.jsonl')
  mkdirSync(file + '.old') // renaming over a directory fails
  const log = createEventLog(file, { maxBytes: 300 })
  for (let i = 0; i < 20; i++) log.record(ev(i))
  assert.equal(log.record(ev(99)), true)
  assert.ok(statSync(file).size <= 600, 'file stays bounded')
  assert.match(readFileSync(file, 'utf8'), /item-99/)
})

test('a normal rotation still moves the full file to .old and starts fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evlog-'))
  const file = join(dir, 'queue-events.jsonl')
  const log = createEventLog(file, { maxBytes: 300 })
  for (let i = 0; i < 20; i++) log.record(ev(i))
  const all = log.read()
  assert.ok(all.length >= 2)
  assert.equal(all.at(-1).itemId, 'item-19')
  assert.ok(statSync(file + '.old').size > 0)
})
