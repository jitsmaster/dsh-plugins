import assert from 'node:assert/strict'
import test from 'node:test'
import { createUsageTracker } from '../ai-usage/tracker.js'

const usage = (i, o, cr = 0, cw = 0, rs = 0) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw, reasoningTokens: rs })
const msg = (u, blocks = [], time = 1000) => ({ type: 'assistant/message', time, data: { usage: u, message: { content: blocks } } })
const call = (name, args, id = 'c' + Math.random()) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
const text = (t) => ({ type: 'text', text: t })

const tally = (t, s) => t.sessions().find(x => x.id === s)

test('plain messages are code and totals split input/output with cache', () => {
  const t = createUsageTracker()
  t.observe('s1', msg(usage(10, 5, 100, 20, 2)))
  t.observe('s1', msg(usage(1, 1)))
  const s = tally(t, 's1')
  assert.equal(s.totals.input, 10 + 100 + 20 + 1)
  assert.equal(s.totals.output, 6)
  assert.equal(s.totals.cacheRead, 100)
  assert.equal(s.totals.cacheWrite, 20)
  assert.equal(s.totals.reasoning, 2)
  assert.equal(s.totals.messages, 2)
  assert.equal(s.byCategory.code.output, 6)
})

test('review skill loaded in the turn makes later messages review until turn/end', () => {
  const t = createUsageTracker()
  t.observe('s1', msg(usage(1, 1), [call('skill', { name: 'code-review' })]))
  t.observe('s1', msg(usage(1, 10)))
  assert.equal(tally(t, 's1').byCategory.review.output, 10)
  t.observe('s1', { type: 'turn/end' })
  t.observe('s1', msg(usage(1, 7)))
  assert.equal(tally(t, 's1').byCategory.code.output, 8)
  assert.equal(tally(t, 's1').bySkill['code-review'].output, 10)
})

test('other skill counts as skill, neutral orchestrator skills do not switch context', () => {
  const t = createUsageTracker()
  t.observe('s1', msg(usage(1, 1), [call('skill', { name: 'modes-sparc' })]))
  t.observe('s1', msg(usage(1, 4)))
  assert.equal(tally(t, 's1').byCategory.code.output, 5)
  t.observe('s1', msg(usage(1, 1), [call('skill', { name: 'obsidian-vault' })]))
  t.observe('s1', msg(usage(1, 6)))
  assert.equal(tally(t, 's1').byCategory.skill.output, 6)
})

test('edits inside an other-skill context are code; inside a review context stay review', () => {
  const t = createUsageTracker()
  t.observe('s1', msg(usage(1, 1), [call('skill', { name: 'obsidian-vault' })]))
  t.observe('s1', msg(usage(1, 3), [call('edit', { file_path: 'a' })]))
  assert.equal(tally(t, 's1').byCategory.code.output, 4) // the skill-loading message (1) plus the edit message (3)
  t.observe('s2', msg(usage(1, 1), [call('skill', { name: 'code-review' })]))
  t.observe('s2', msg(usage(1, 3), [call('edit', { file_path: 'a' })]))
  assert.equal(tally(t, 's2').byCategory.review.output, 3)
})

test('ticket session is detected by an ADO skill; ids split per message, shared otherwise', () => {
  const t = createUsageTracker()
  t.observe('s1', msg(usage(1, 1), [call('skill', { name: 'ado-ticket-to-implementation' })]))
  t.observe('s1', msg(usage(1, 5), [text('working on AB#26018')]))
  t.observe('s1', msg(usage(1, 7), [text('AB#26018 and AB#26022')]))
  const s = tally(t, 's1')
  assert.equal(s.kind, 'ticket')
  assert.equal(s.byTicket['26018'].output, 5)
  assert.equal(s.byTicket.shared.output, 8)
  assert.deepEqual([...s.tickets].sort(), ['26018', '26022'])
})

test('dsh sessions are detected by cwd; others are untracked', () => {
  const t = createUsageTracker()
  t.meta('a', { cwd: 'D:\\dev\\ai\\dsh-plugins', title: 'x' })
  t.meta('b', { cwd: 'D:\\dev\\CTnP-Final', title: 'y' })
  t.observe('a', msg(usage(1, 1)))
  t.observe('b', msg(usage(1, 1)))
  assert.equal(tally(t, 'a').kind, 'dsh')
  assert.equal(tally(t, 'b').kind, 'untracked')
})

test('chains accumulate: root of a resume chain and chain totals', () => {
  const t = createUsageTracker()
  t.observe('a', msg(usage(1, 10)))
  t.link('a', 'b')
  t.link('b', 'c')
  t.observe('b', msg(usage(1, 20)))
  t.observe('c', msg(usage(1, 30)))
  assert.equal(t.rootOf('c'), 'a')
  const chain = t.chain('a')
  assert.deepEqual(chain.members.sort(), ['a', 'b', 'c'])
  assert.equal(chain.totals.output, 60)
})

test('link cycles do not hang', () => {
  const t = createUsageTracker()
  t.link('a', 'b'); t.link('b', 'a')
  assert.ok(['a', 'b'].includes(t.rootOf('a')))
})

test('subagent runs: call counted, usage taken from result meta when present', () => {
  const t = createUsageTracker()
  t.observe('s1', msg(usage(1, 1), [call('subagent_claude_code', {}, 'k1')]))
  t.observe('s1', { type: 'tool/result', time: 5, data: { message: { source: { callId: 'k1' } }, meta: { usage: { inputTokens: 100, outputTokens: 50 } } } })
  const s = tally(t, 's1')
  assert.equal(s.subagentCalls, 1)
  assert.equal(s.byCategory.subagent.output, 50)
  assert.equal(s.byCategory.subagent.input, 100)
})

test('delegated runs are listed by name and kind, review detected from the prompt', () => {
  const t = createUsageTracker()
  t.observe('s1', msg(usage(1, 1), [
    call('subagent_claude_code', { name: 'review1-pitfall', description: 'AI pitfall review', prompt: 'Skill(modes:ai-pitfall-review)' }, 'k1'),
    call('subagent_claude_code', { name: 'lows-fix', description: 'Fix lows', prompt: 'edit files' }, 'k2'),
  ]))
  const runs = tally(t, 's1').runs
  assert.deepEqual(runs.map(r => [r.name, r.kind]), [['review1-pitfall', 'review'], ['lows-fix', 'other']])
  const b = createUsageTracker()
  const recs = []; t.onRecord = (r) => recs.push(r)
  t.observe('s2', msg(usage(1, 1), [call('subagent_claude_code', { name: 'x', prompt: 'code-review' }, 'k3')]))
  for (const r of recs) b.apply(r)
  assert.equal(tally(b, 's2').runs.length, 1)
})

test('records replay to the same state (ledger is the source of truth)', () => {
  const a = createUsageTracker(); const recs = []
  a.onRecord = (r) => recs.push(r)
  a.meta('s', { cwd: '/dsh', title: 't' })
  a.link('p', 's')
  a.observe('s', msg(usage(2, 3, 4, 5, 6)))
  const b = createUsageTracker()
  for (const r of recs) b.apply(r)
  assert.deepEqual(tally(b, 's').totals, tally(a, 's').totals)
  assert.equal(b.rootOf('s'), 'p')
})

test('garbage events and bad usage never throw or count', () => {
  const t = createUsageTracker()
  t.observe('s', null); t.observe('s', {}); t.observe('s', msg({ inputTokens: -1, outputTokens: 'x' }))
  t.observe('s', msg(undefined))
  assert.equal(t.sessions().length, 0)
})

test('byDay splits usage by local date', () => {
  const t = createUsageTracker()
  t.observe('s', msg(usage(1, 4), [], new Date(2026, 10, 11, 10).getTime()))
  t.observe('s', msg(usage(1, 6), [], new Date(2026, 10, 12, 10).getTime()))
  assert.equal(tally(t, 's').byDay['2026-11-11'].output, 4)
  assert.equal(tally(t, 's').byDay['2026-11-12'].output, 6)
})
