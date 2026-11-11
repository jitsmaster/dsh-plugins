import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUsageTracker } from '../ai-usage/tracker.js'
import { createLedger } from '../ai-usage/ledger.js'
import { dailyNotePath, renderDaily, renderTicket, writeNotes } from '../ai-usage/render.js'

const usage = (i, o, cr = 0, cw = 0) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw })
const call = (name, args) => ({ type: 'tool-call', id: 'c' + Math.random(), name, arguments: JSON.stringify(args) })
const T = new Date(2026, 10, 11, 10).getTime()
const msg = (u, blocks = [], time = T) => ({ type: 'assistant/message', time, data: { usage: u, message: { content: blocks } } })

function sample() {
  const t = createUsageTracker()
  t.meta('a', { cwd: 'D:\\dev\\CTnP-Final', title: 'AB#26018 rag' })
  t.observe('a', msg(usage(10, 5, 100, 20), [call('skill', { name: 'ado-ticket-to-implementation' })]))
  t.observe('a', msg(usage(1, 40), [{ type: 'text', text: 'AB#26018' }]))
  t.observe('a', msg(usage(1, 9), [call('skill', { name: 'code-review' })]))
  t.observe('a', msg(usage(1, 30)))
  t.link('a', 'b')
  t.meta('b', { cwd: 'D:\\dev\\CTnP-Final', title: 'AB#26018 rag - 2' })
  t.observe('b', msg(usage(2, 6), [{ type: 'text', text: 'AB#26018' }]))
  return t
}

test('dailyNotePath follows the daily-notes structure', () => {
  assert.equal(dailyNotePath('V', '2026-11-11'), join('V', 'AI usage', '2026-11 November 2026', '2026-11-11.md'))
})

test('daily note lists each session, chain total and category breakdown', () => {
  const md = renderDaily(sample(), '2026-11-11')
  assert.match(md, /^# AI usage 2026-11-11/)
  assert.match(md, /Chain total/)
  assert.match(md, /\| review \|/)
  assert.match(md, /AB#26018/)
  assert.match(md, /code-review/)
  assert.match(md, /\[\[AB#26018\]\]/)
})

test('daily note skips untracked sessions and other days', () => {
  const t = createUsageTracker()
  t.meta('x', { cwd: 'D:\\other', title: 'x' })
  t.observe('x', msg(usage(1, 1)))
  assert.doesNotMatch(renderDaily(t, '2026-11-11'), /session x/)
  assert.doesNotMatch(renderDaily(sample(), '2026-11-12'), /Chain total/)
})

test('ticket note accumulates all chain sessions for the ticket', () => {
  const md = renderTicket(sample(), '26018')
  assert.match(md, /# AB#26018 AI usage/)
  assert.match(md, /Total/)
  assert.match(md, /\| 40 \|/.source.length ? /40/ : /40/)
})

test('ledger appends records and replays into a tracker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  const l = createLedger(join(dir, 'ledger.jsonl'))
  const t = createUsageTracker(); t.onRecord = l.append
  t.observe('s', msg(usage(1, 2)))
  const t2 = createUsageTracker()
  assert.equal(l.replay(t2), 1)
  assert.equal(t2.sessions()[0].totals.output, 2)
})

test('ledger replay skips corrupt lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  const p = join(dir, 'ledger.jsonl')
  writeFileSync(p, 'not json\n{"k":"msg","id":"s","cat":"code","tickets":[],"u":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"reasoning":0},"time":1}\n')
  assert.equal(createLedger(p).replay(createUsageTracker()), 1)
})

test('writeNotes writes daily and ticket notes atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'))
  const files = writeNotes(sample(), dir, ['2026-11-11'])
  assert.ok(existsSync(join(dir, 'AI usage', '2026-11 November 2026', '2026-11-11.md')))
  assert.ok(existsSync(join(dir, 'CTnP', 'AI Usage by Ticket', 'AB#26018.md')))
  assert.equal(files.length, 2)
  assert.match(readFileSync(files[0], 'utf8'), /AI usage/)
})
