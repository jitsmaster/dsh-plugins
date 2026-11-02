// Phase 2 of the AI triage plan: the triage log (JSONL, redacted before writing, rotated at a size, pruned by age).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTriageLog, redact, redactDeep, LOG_RETENTION_MS, LOG_MAX_BYTES } from '../triage-log.js'

const dir = () => mkdtempSync(join(tmpdir(), 'rq-triage-'))

test('the spec limits: 90 days, 5 MB', () => {
  assert.equal(LOG_RETENTION_MS, 90 * 24 * 3600 * 1000)
  assert.equal(LOG_MAX_BYTES, 5 * 1024 * 1024)
})

test('redact removes the usual secrets and keeps ordinary text', () => {
  const cases = [
    ['Authorization: Bearer abcdefghijklmnop12345', /abcdefghijkl/],
    ['export API_KEY=supersecretvalue', /supersecretvalue/],
    ['password: hunter2hunter2', /hunter2/],
    ['token sk-ABCDEFGHIJKLMNOPQRSTUV used', /ABCDEFGHIJKL/],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', /abcdefghijklmnop/],
    ['blob ' + 'A1b2'.repeat(12), /A1b2A1b2A1b2A1b2/],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', /MIIEow/],
  ]
  for (const [text, leak] of cases) {
    const out = redact(text)
    assert.ok(!leak.test(out), text + ' -> ' + out)
    assert.ok(out.includes('[redacted]'), text)
  }
  assert.equal(redact('git status in the workspace'), 'git status in the workspace')
})

test('redactDeep reaches nested strings and caps long ones', () => {
  const r = redactDeep({ a: { b: ['token=abc123def456'] }, long: 'x'.repeat(5000), n: 3 })
  assert.equal(r.a.b[0], '[redacted]')
  assert.ok(r.long.length < 2100)
  assert.equal(r.n, 3)
})

test('append writes one stamped JSON line per entry, redacted, and read gives them back in order', () => {
  const d = dir()
  try {
    const log = createTriageLog(join(d, 'triage.jsonl'), { now: () => 1000 })
    assert.equal(log.append({ itemId: 'i1', verdict: 'ask', answer: 'password=letmein99' }), true)
    log.append({ itemId: 'i2', verdict: 'handle' })
    const text = readFileSync(join(d, 'triage.jsonl'), 'utf8')
    assert.equal(text.trim().split('\n').length, 2)
    assert.ok(!text.includes('letmein99'))
    const all = log.read()
    assert.deepEqual(all.map((e) => e.itemId), ['i1', 'i2'])
    assert.equal(all[0].at, 1000)
    assert.deepEqual(log.read((e) => e.verdict === 'handle').map((e) => e.itemId), ['i2'])
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('rotation: past the size the old file moves to .old and read still sees both', () => {
  const d = dir()
  try {
    const file = join(d, 'triage.jsonl')
    const log = createTriageLog(file, { maxBytes: 200 })
    for (let i = 0; i < 12; i++) log.append({ itemId: 'i' + i, note: 'padding padding padding' })
    assert.ok(existsSync(file + '.old'))
    const ids = log.read().map((e) => e.itemId)
    assert.equal(ids.at(-1), 'i11')
    assert.ok(readFileSync(file, 'utf8').length < 600)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('prune drops entries past the retention and keeps newer ones', () => {
  const d = dir()
  try {
    const file = join(d, 'triage.jsonl')
    let t = 0
    const log = createTriageLog(file, { now: () => t, retentionMs: 1000 })
    t = 100; log.append({ itemId: 'old' })
    t = 5000; log.append({ itemId: 'new' })
    t = 5500
    assert.equal(log.prune(), 1)
    assert.deepEqual(log.read().map((e) => e.itemId), ['new'])
    assert.equal(log.prune(), 0)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('never throws: a missing folder, a garbled file', () => {
  const d = dir()
  try {
    assert.equal(createTriageLog(join(d, 'no', 'such', 'dir', 'x.jsonl')).append({ a: 1 }), false)
    assert.deepEqual(createTriageLog(join(d, 'no', 'such', 'dir', 'x.jsonl')).read(), [])
    const file = join(d, 'bad.jsonl')
    writeFileSync(file, 'not json\n{"at":1,"ok":true}\n[1]\n')
    assert.deepEqual(createTriageLog(file).read().map((e) => e.ok), [true])
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('review fix: a path is not a secret keyword, a real pat= credential still is', () => {
  assert.equal(redact('cat D:/w/src/some/long/path/to/a/file/that/goes/on/and/on.js'), 'cat D:/w/src/some/long/path/to/a/file/that/goes/on/and/on.js')
  assert.equal(redact('path: D:/w'), 'path: D:/w')
  assert.ok(redact('pat=abcdef123456').includes('[redacted]'))
  assert.ok(redact('AZURE_DEVOPS_PAT: abcdef123456').includes('[redacted]'))
})
