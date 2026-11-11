import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installAiUsage } from '../ai-usage/index.js'
import { recordSpawn } from '../spawned.js'

const T = new Date(2026, 10, 11, 10).getTime()
const day = '2026-11-11'
const call = (name, args) => ({ type: 'tool-call', id: 'c' + Math.random(), name, arguments: JSON.stringify(args) })
const msg = (o, blocks = []) => ({ type: 'assistant/message', time: T, data: { usage: { inputTokens: 1, outputTokens: o }, message: { content: blocks } } })

function harness() {
  const handlers = {}
  const stateDir = mkdtempSync(join(tmpdir(), 'aiu-state-'))
  const vault = mkdtempSync(join(tmpdir(), 'aiu-vault-'))
  const ctx = { logger: { warn() {}, info() {} }, get: () => undefined, on: (n, f) => { handlers[n] = f } }
  const svc = installAiUsage(ctx, { aiUsageVaultDir: vault }, stateDir)
  const agent = (id, cwd) => ({ id, session: { header: { cwd } } })
  return { handlers, stateDir, vault, svc, agent }
}

test('events from a created agent are accounted and written on turn stop', () => {
  const h = harness()
  const a = h.agent('s1', 'D:\\dev\\ai\\dsh-plugins')
  h.handlers['agent/created']({ agent: a })
  h.handlers['session/event'](a.session, msg(5))
  h.handlers['agent/turn-stopping']({ agent: a })
  const note = join(h.vault, 'AI usage', '2026-11 November 2026', day + '.md')
  assert.ok(existsSync(note))
  assert.match(readFileSync(note, 'utf8'), /session s1/)
  assert.ok(existsSync(join(h.stateDir, 'ai-usage', 'ledger.jsonl')))
})

test('a spawned continuation joins the chain of its source', () => {
  const h = harness()
  const a = h.agent('a', 'D:\\dev\\ai\\dsh-plugins'); const b = h.agent('b', 'D:\\dev\\ai\\dsh-plugins')
  h.handlers['agent/created']({ agent: a }); h.handlers['agent/created']({ agent: b })
  h.handlers['session/event'](a.session, msg(10))
  recordSpawn('a', 'b')
  h.handlers['session/event'](b.session, msg(20))
  assert.equal(h.svc.tracker.chain('a').totals.output, 30)
})

test('the ledger is replayed on startup', () => {
  const h = harness()
  const a = h.agent('s', 'D:\\dev\\ai\\dsh-plugins')
  h.handlers['agent/created']({ agent: a })
  h.handlers['session/event'](a.session, msg(7))
  const again = installAiUsage({ logger: { warn() {} }, get: () => undefined, on() {} }, { aiUsageVaultDir: h.vault }, h.stateDir)
  assert.equal(again.tracker.sessions()[0].totals.output, 7)
})

test('an event from an unknown session and a failing write never throw', () => {
  const h = harness()
  h.handlers['session/event']({}, msg(1))
  const bad = installAiUsage({ logger: { warn() {} }, get: () => undefined, on: (n, f) => { h[n] = f } }, { aiUsageVaultDir: '\0:bad' }, h.stateDir)
  const a = h.agent('x', 'D:\\dev\\dsh'); h['agent/created']({ agent: a }); h['session/event'](a.session, msg(1))
  h['agent/turn-stopping']({ agent: a })
  assert.ok(bad.tracker)
})
