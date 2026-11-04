// RED: triage-log.js gets a read-only entries({ since, until }) so the AI report can count observe-mode proposals without reading the file itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTriageLog } from '../triage-log.js'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-log-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let clock = 0
  const log = createTriageLog(join(dir, 'triage-log.jsonl'), { now: () => clock })
  return { log, at: (n) => { clock = n }, file: join(dir, 'triage-log.jsonl') }
}

test('entries({ since }) returns the entries stamped at or after since, oldest first', (t) => {
  const { log, at } = setup(t)
  at(100); log.append({ itemId: 'a' }); at(200); log.append({ itemId: 'b' }); at(300); log.append({ itemId: 'c' })
  assert.deepEqual(log.entries({ since: 200 }).map((e) => e.itemId), ['b', 'c'])
})

test('entries({ since, until }) leaves until out (exclusive)', (t) => {
  const { log, at } = setup(t)
  at(100); log.append({ itemId: 'a' }); at(200); log.append({ itemId: 'b' }); at(300); log.append({ itemId: 'c' })
  assert.deepEqual(log.entries({ since: 100, until: 300 }).map((e) => e.itemId), ['a', 'b'])
})

test('entries() without arguments returns everything, and a missing file gives an empty list', (t) => {
  const { log, at } = setup(t)
  assert.deepEqual(log.entries(), [])
  at(5); log.append({ itemId: 'a' })
  assert.equal(log.entries().length, 1)
})

test('entries() skips unreadable lines and does not write', (t) => {
  const { log, at, file } = setup(t)
  at(100); log.append({ itemId: 'a' })
  writeFileSync(file, 'not json\n', { flag: 'a' })
  assert.deepEqual(log.entries({ since: 0 }).map((e) => e.itemId), ['a'])
})
