// Slice 0.8: the replay of stored cards through the tier matrix (read-only; used to fix the severity bands).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replay, factsFromLog, loadItems } from '../scripts/tier-replay.mjs'

const H = 3600 * 1000
const item = (id, type, createdAt, resolvedAt) => ({ id, type, status: resolvedAt ? 'resolved' : 'open', createdAt, resolvedAt })

test('factsFromLog reads needs-user and risk flags from a triage row', () => {
  assert.deepEqual(factsFromLog(undefined), {})
  assert.equal(factsFromLog({ reasons: ['needs-user'] }).needsUser, true)
  assert.deepEqual(factsFromLog({ judgment: { reversible: false, touches_outside_workspace: false } }).riskFlags, ['irreversible'])
  assert.deepEqual(factsFromLog({ judgment: { reversible: true, touches_outside_workspace: true } }).riskFlags, ['outside-workspace'])
  assert.equal(factsFromLog({ judgment: { reversible: true, touches_outside_workspace: false } }).riskFlags, undefined)
})

test('replay counts items per tier and reports waits and risky ranks', () => {
  const items = [
    item('a', 'permission', 0, 2 * H),
    item('b', 'completed', 1 * H, 2 * H),
    item('c', 'completed', 2 * H, 6 * H),
    item('d', 'completed', 3 * H, 3 * H + 1000),
  ]
  const log = [{ itemId: 'c', judgment: { reversible: false, touches_outside_workspace: false, needs_decision: false } }]
  const r = replay({ items, log })
  assert.equal(r.total, 4)
  assert.equal(r.byTier[0].count, 1) // permission without safe facts: High and blocked
  assert.equal(r.byTier[1].count, 1) // c: irreversible flag makes it High, free
  assert.equal(r.byTier[3].count, 2)
  assert.equal(r.byTier[3].medianWaitMs, (1 * H + 1000) / 2)
  assert.equal(r.risky.length, 1)
  assert.equal(r.risky[0].id, 'c')
  assert.equal(r.risky[0].oldestFirstRank, 3)
  assert.equal(r.risky[0].tierRank, 2) // behind only the P0 permission
})

test('replay of nothing is empty, not an error', () => {
  const r = replay({ items: [], log: [] })
  assert.equal(r.total, 0)
  assert.deepEqual(r.risky, [])
})

test('loadItems reads queue.json of a normal install and survives a missing local dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tier-replay-'))
  writeFileSync(join(dir, 'queue.json'), JSON.stringify({ v: 1, items: [{ id: 'q1', type: 'completed', createdAt: 1 }] }))
  assert.deepEqual(loadItems(dir).map((i) => i.id), ['q1'])
  mkdirSync(join(dir, 'local'))
  writeFileSync(join(dir, 'local', 'a.json'), JSON.stringify({ items: [{ id: 'q1' }, { id: 'q2', type: 'question', createdAt: 2 }] }))
  assert.deepEqual(loadItems(dir).map((i) => i.id), ['q1', 'q2'])
  assert.deepEqual(loadItems(join(dir, 'nope')), [])
})
