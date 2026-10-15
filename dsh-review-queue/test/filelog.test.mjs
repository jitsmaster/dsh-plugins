import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileLog } from '../filelog.js'
import { apply } from '../index.js'

// A small append-only log file so a silent failure (the todo workspace suggestion) can be traced afterwards.
test('createFileLog appends one timestamped line per call, keeps a multi-line message on one line, and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rqlog-'))
  try {
    const file = join(dir, 'review-queue.log')
    const log = createFileLog(file, { now: () => Date.UTC(2026, 9, 14, 12, 0, 0) })
    log('review-queue: first')
    log('second\nline two')
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.length, 2)
    assert.match(lines[0], /^2026-10-14T12:00:00\.000Z review-queue: first$/)
    assert.ok(lines[1].includes('second') && lines[1].includes('line two'))
    createFileLog(join(dir, 'no', 'such', 'dir', 'x.log'))('still fine')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('createFileLog keeps the file small: past the size cap the old log is moved to .old and a fresh one starts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rqlog-'))
  try {
    const file = join(dir, 'review-queue.log')
    const log = createFileLog(file, { maxBytes: 200 })
    for (let i = 0; i < 10; i++) log('line number ' + i + ' ' + 'z'.repeat(30))
    assert.ok(readFileSync(file, 'utf8').length < 600, 'the live file stays near the cap')
    assert.ok(existsSync(file + '.old'))
    writeFileSync(file, '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('apply writes the review queue log lines (the same ones ctx.logger gets) to review-queue.log in the state dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  try {
    const infos = []
    const ctx = {
      on() {}, effect() {}, inject() {}, provide() {},
      get: (name) => (name === 'workspaceRegistry' ? { list: () => [{ id: 'w1', title: 'Alpha', path: 'D:/a', sessionIds: [] }], archivedSessionIds: [] } : undefined),
      logger: { warn() {}, info: (line) => infos.push(line) },
    }
    const queue = apply(ctx, { hub: false, stateDir: dir })
    queue.addTodo('Make the website header sticky')
    await queue.todoIdle()
    const text = readFileSync(join(dir, 'review-queue.log'), 'utf8')
    assert.match(text, /review-queue: todo: no workspace suggestion/)
    assert.ok(infos.some((l) => /no workspace suggestion/.test(l)), 'ctx.logger still gets it')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
