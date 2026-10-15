import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrateLegacy } from '../hub/migrate.js'
import { createHubStore } from '../hub/hub-store.js'
import { createFileIo } from '../hub/atomic-file.js'
import { tmpDir } from './hub-helpers.mjs'

const NOW = 1_800_000_000_000
const row = (id, type, status = 'open', extra = {}) => ({ id, seq: Number(id.replace(/\D/g, '')) || 1, type, status, createdAt: NOW - 5000, sessionId: 's-' + id, sessionTitle: 'T' + id, payload: { text: 'SECRET-' + id }, ...extra })
const LEGACY = {
  v: 1,
  seq: 7,
  items: [
    row('q1', 'question'),
    row('p2', 'permission'),
    row('c3', 'completed'),
    row('m4', 'pr-merged'),
    row('t5', 'todo', 'open', { state: 'starting' }),
    row('c6', 'completed', 'resolved', { resolvedAt: NOW - 1000, resolution: { kind: 'reviewed', by: 'card' } }),
  ],
}
// null = no such legacy file
function setup(t, { legacy = LEGACY, vapid = '{"publicKey":"PUB","privateKey":"PRIVATE-KEY-123"}' } = {}) {
  const stateDir = tmpDir(t)
  if (legacy !== null) writeFileSync(join(stateDir, 'queue.json'), typeof legacy === 'string' ? legacy : JSON.stringify(legacy))
  if (vapid !== null) writeFileSync(join(stateDir, 'vapid.json'), vapid)
  const logs = []
  const run = () => migrateLegacy({ stateDir, now: () => NOW, log: (l) => logs.push(l) })
  return { stateDir, hubDir: join(stateDir, 'hub'), logs, run }
}
const readHub = (hubDir) => JSON.parse(readFileSync(join(hubDir, 'queue.json'), 'utf8'))

test('the first start imports the legacy queue: open questions and permissions end, completed / pr-merged / todo stay open without an owner', (t) => {
  const { hubDir, run } = setup(t)
  const result = run()
  assert.equal(result.queue, 'imported')
  assert.equal(result.items, 6)
  assert.equal(result.ended, 2)
  const data = readHub(hubDir)
  assert.equal(data.v, 2)
  assert.equal(data.seq, 7)
  const byId = Object.fromEntries(data.items.map((i) => [i.id, i]))
  for (const id of ['q1', 'p2']) {
    assert.equal(byId[id].status, 'resolved', id)
    assert.deepEqual(byId[id].resolution, { kind: 'session-ended', by: 'hub', reason: 'migration' })
    assert.equal(byId[id].resolvedAt, NOW)
  }
  for (const id of ['c3', 'm4', 't5']) {
    assert.equal(byId[id].status, 'open', id)
    assert.equal(byId[id].owner, undefined, id)
  }
  assert.equal(byId.t5.state, 'starting')
  assert.deepEqual(byId.c6.resolution, { kind: 'reviewed', by: 'card' })
  assert.equal(byId.c6.resolvedAt, NOW - 1000)
})

test('the legacy file is copied to hub/queue.v1-import-<ts>.json and left untouched', (t) => {
  const { stateDir, hubDir, run } = setup(t)
  const before = readFileSync(join(stateDir, 'queue.json'))
  run()
  assert.ok(readFileSync(join(stateDir, 'queue.json')).equals(before), 'the old file is not modified')
  const copies = readdirSync(hubDir).filter((n) => /^queue\.v1-import-.+\.json$/.test(n))
  assert.equal(copies.length, 1)
  assert.ok(readFileSync(join(hubDir, copies[0])).equals(before), 'the copy is byte for byte the original')
})

test('the imported file loads into the hub store: the orphans are open and numbered, the order is kept', (t) => {
  const { hubDir, run } = setup(t)
  run()
  const store = createHubStore({ now: () => NOW, io: createFileIo(join(hubDir, 'queue.json')) })
  assert.equal(store.loadedFrom, 'main')
  assert.deepEqual(store.snapshot().open.map((i) => [i.position, i.id]), [[1, 'c3'], [2, 'm4'], [3, 't5']])
  assert.equal(store.applyOp({ op: 'add', item: { type: 'completed' } }, { owner: 'A1' }).ok, true)
  assert.equal(store.list().find((i) => i.owner === 'A1').seq, 8, 'the hub seq continues after the legacy seq')
})

test('it runs once: a second start, or a hub folder that only has queue.json.bak, imports nothing', (t) => {
  const { stateDir, hubDir, run } = setup(t)
  run()
  const first = readFileSync(join(hubDir, 'queue.json'), 'utf8')
  writeFileSync(join(stateDir, 'queue.json'), JSON.stringify({ v: 1, seq: 1, items: [row('n9', 'completed')] }))
  assert.equal(run().queue, 'skipped')
  assert.equal(readFileSync(join(hubDir, 'queue.json'), 'utf8'), first)
  assert.equal(readdirSync(hubDir).filter((n) => n.startsWith('queue.v1-import-')).length, 1)
  const other = setup(t)
  mkdirSync(other.hubDir, { recursive: true })
  writeFileSync(join(other.hubDir, 'queue.json.bak'), '{}')
  assert.equal(other.run().queue, 'skipped')
  assert.equal(existsSync(join(other.hubDir, 'queue.json')), false)
})

test('no legacy file: nothing to import and nothing created', (t) => {
  const { hubDir, run } = setup(t, { legacy: null, vapid: null })
  assert.deepEqual(run(), { queue: 'none', items: 0, ended: 0, vapid: false, push: false })
  assert.equal(existsSync(join(hubDir, 'queue.json')), false)
})

test('an unreadable or wrong-version legacy file is not imported, the hub starts empty and does not retry', (t) => {
  for (const legacy of ['{"v":1,"items":[', JSON.stringify({ v: 3, items: [] }), JSON.stringify({ v: 1, items: 'x' })]) {
    const { stateDir, hubDir, logs, run } = setup(t, { legacy })
    assert.equal(run().queue, 'unreadable')
    assert.equal(readHub(hubDir).items.length, 0)
    assert.equal(readFileSync(join(stateDir, 'queue.json'), 'utf8'), legacy)
    assert.ok(logs.length > 0)
    assert.equal(run().queue, 'skipped')
  }
})

test('items without an id or type are dropped by the import, the rest is kept', (t) => {
  const { hubDir, run } = setup(t, { legacy: { v: 1, seq: 3, items: [row('c1', 'completed'), null, { id: 'x' }, { type: 'completed' }] } })
  assert.equal(run().items, 1)
  assert.deepEqual(readHub(hubDir).items.map((i) => i.id), ['c1'])
})

test('vapid.json is copied to hub/vapid.json (subscriptions stay valid); an existing hub copy is kept', (t) => {
  const { stateDir, hubDir, run } = setup(t)
  assert.equal(run().vapid, true)
  assert.equal(readFileSync(join(hubDir, 'vapid.json'), 'utf8'), readFileSync(join(stateDir, 'vapid.json'), 'utf8'))
  writeFileSync(join(stateDir, 'vapid.json'), '{"publicKey":"NEW"}')
  assert.equal(run().vapid, false)
  assert.match(readFileSync(join(hubDir, 'vapid.json'), 'utf8'), /PUB/)
  assert.equal(readFileSync(join(stateDir, 'vapid.json'), 'utf8'), '{"publicKey":"NEW"}', 'the old file is untouched')
})

test('vapid.json is copied even when there is no queue to import', (t) => {
  const { hubDir, run } = setup(t, { legacy: null })
  assert.equal(run().vapid, true)
  assert.ok(existsSync(join(hubDir, 'vapid.json')))
})

test('the log has counts only: no item text and no key material', (t) => {
  const { logs, run } = setup(t)
  run()
  assert.ok(logs.length > 0)
  const text = logs.join('\n')
  assert.doesNotMatch(text, /SECRET-|PRIVATE-KEY|PUB\b/)
})

test('push.json (phones of a pre-hub build) is copied to hub/push.json once; an existing hub copy and the old file are kept', (t) => {
  const { stateDir, hubDir, run } = setup(t, { legacy: null })
  writeFileSync(join(stateDir, 'push.json'), '{"v":1,"devices":[]}')
  assert.equal(run().push, true)
  assert.equal(readFileSync(join(hubDir, 'push.json'), 'utf8'), '{"v":1,"devices":[]}')
  writeFileSync(join(stateDir, 'push.json'), '{"v":1,"devices":[{"id":"new"}]}')
  assert.equal(run().push, false)
  assert.equal(readFileSync(join(hubDir, 'push.json'), 'utf8'), '{"v":1,"devices":[]}')
  assert.match(readFileSync(join(stateDir, 'push.json'), 'utf8'), /new/, 'the old file is untouched')
})
