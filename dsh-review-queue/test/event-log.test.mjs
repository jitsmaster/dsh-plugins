// Slice 0 of review grouping and priority: a minimal append-only event log (tiered, resolved; later shown, acted). Ids, types, tiers, ranks and timestamps only, never card text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventLog } from '../event-log.js'
import { createStore } from '../store.js'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'rq-events-')), 'events.jsonl')

function withStore() {
  const rows = []
  let t = 1000
  let n = 0
  const events = { record: (e) => rows.push(e) }
  const store = createStore({ now: () => t++, uuid: () => 'i' + ++n, events })
  return { store, rows }
}

test('record keeps only the allowed fields and stamps the time', () => {
  const log = createEventLog(tmp(), { now: () => 42 })
  assert.equal(log.record({ kind: 'tiered', itemId: 'a', type: 'question', tier: 1, severity: 'medium', urgency: 'blocked', text: 'SECRET card text', reply: 'x', payload: { a: 1 } }), true)
  const [e] = log.read()
  assert.deepEqual(e, { at: 42, kind: 'tiered', itemId: 'a', type: 'question', tier: 1, severity: 'medium', urgency: 'blocked' })
})

test('an unknown kind is refused, and long strings are cut so no card text can ride along', () => {
  const log = createEventLog(tmp(), { now: () => 1 })
  assert.equal(log.record({ kind: 'invented', itemId: 'a' }), false)
  assert.equal(log.record({ kind: 'resolved', itemId: 'a'.repeat(500), type: 'completed', resolution: 'r'.repeat(500) }), true)
  const [e] = log.read()
  assert.ok(e.itemId.length <= 64 && e.resolution.length <= 64)
})

test('rotates when the file is too big', () => {
  const file = tmp()
  const log = createEventLog(file, { now: () => 1, maxBytes: 200 })
  for (let i = 0; i < 20; i++) log.record({ kind: 'tiered', itemId: 'item' + i, type: 'completed', tier: 3 })
  assert.ok(existsSync(file + '.old'))
  assert.ok(log.read().length >= 2)
})

test('a log problem never throws', () => {
  const log = createEventLog(join(tmpdir(), 'no-such-dir-xyz', 'a', 'events.jsonl'), { now: () => 1 })
  assert.equal(log.record({ kind: 'tiered', itemId: 'a' }), false)
  assert.deepEqual(log.read(), [])
})

test('store: add emits a tiered row, a tier update emits another, with no text', () => {
  const { store, rows } = withStore()
  const item = store.add({ type: 'question', sessionId: 's', payload: { questions: [{ question: 'Secret?' }] } })
  assert.deepEqual(rows.map((r) => [r.kind, r.itemId, r.type, r.tier]), [['tiered', item.id, 'question', 1]])
  store.setTier(item.id, { severity: 'low', urgency: 'blocked', tier: 2, at: 5 })
  assert.deepEqual(rows.map((r) => [r.kind, r.tier]), [['tiered', 1], ['tiered', 2]])
  assert.ok(!JSON.stringify(rows).includes('Secret'))
})

test('store: an update that does not change the tier emits nothing', () => {
  const { store, rows } = withStore()
  const item = store.add({ type: 'completed', sessionId: 's', payload: { reply: 'x' } })
  store.update(item.id, { summary: 'later' })
  assert.equal(rows.length, 1)
})

test('store: resolve emits one resolved row with kind and who', () => {
  const { store, rows } = withStore()
  const item = store.add({ type: 'completed', sessionId: 's', payload: { reply: 'x' } })
  store.resolve(item.id, { kind: 'reviewed', by: 'user' })
  const r = rows.at(-1)
  assert.deepEqual([r.kind, r.itemId, r.type, r.resolution, r.by], ['resolved', item.id, 'completed', 'reviewed', 'user'])
  store.resolve(item.id, { kind: 'reviewed' }) // already resolved: no second row
  assert.equal(rows.filter((x) => x.kind === 'resolved').length, 1)
})

test('store: resolveSession and reconcile emit one resolved row per item', () => {
  const { store, rows } = withStore()
  store.add({ type: 'completed', sessionId: 's1', payload: {} })
  store.add({ type: 'question', sessionId: 's1', payload: {} })
  store.add({ type: 'completed', sessionId: 's2', payload: {} })
  store.resolveSession('s1', { kind: 'session-closed' })
  assert.equal(rows.filter((x) => x.kind === 'resolved').length, 2)
  store.reconcile(new Set())
  const resolved = rows.filter((x) => x.kind === 'resolved')
  assert.equal(resolved.length, 3)
  assert.equal(resolved.at(-1).resolution, 'session-ended')
})

test('store: a throwing event log never breaks the store', () => {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n, events: { record: () => { throw new Error('disk full') } } })
  const item = store.add({ type: 'completed', sessionId: 's', payload: {} })
  assert.equal(store.resolve(item.id, { kind: 'reviewed' }), true)
})

test('a corrupt line in the file is skipped on read', () => {
  const file = tmp()
  writeFileSync(file, 'not json\n{"at":1,"kind":"tiered","itemId":"a"}\n')
  assert.equal(createEventLog(file).read().length, 1)
})
