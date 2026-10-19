import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createExecutor } from '../agent/executor.js'
import { readThread } from '../thread.js'

// An ownerless open item is read by the coordinator, whose own store does not hold it: the hub sends the session id with the thread command.
// The REAL executor and the REAL service run here; only the thread reader is a fake (or, for the id check, the real one on an empty folder).

function coordinator({ threadOf } = {}) {
  const store = createStore({ uuid: () => 'local-1' })
  const reads = []
  const reader = threadOf ?? (async (opts) => { reads.push(opts); return { ok: true, messages: [{ id: 1, role: 'user', text: 'hi' }], hasMore: false, cursor: 1 } })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => undefined, threadOf: reader })
  const executor = createExecutor({ queue, adapter: {} })
  return { store, queue, executor, reads }
}
let n = 0
const cmd = (itemId, args = {}) => ({ cid: 'c' + ++n, seq: n, kind: 'thread', itemId, args })

test('a thread command for an item the local store lacks reads the session id it carries', async () => {
  const { executor, store, reads } = coordinator()
  assert.equal(store.get('hub-only'), undefined)
  const res = await executor.execute(cmd('hub-only', { before: 8, limit: 5, sessionId: 'sess-77' }))
  assert.deepEqual(res, { ok: true, sessionId: 'sess-77', title: '', messages: [{ id: 1, role: 'user', text: 'hi' }], hasMore: false, cursor: 1 })
  assert.deepEqual(reads, [{ sessionId: 'sess-77', before: 8, limit: 5 }])
  assert.equal(store.get('hub-only'), undefined, 'the read does not add the item to the store')
})

test('a thread command for an unknown item that carries no session id is not-found', async () => {
  const { executor, reads } = coordinator()
  assert.deepEqual(await executor.execute(cmd('hub-only')), { ok: false, error: 'not-found' })
  assert.deepEqual(reads, [])
})

test('an item the store does hold keeps its own session whatever the command carries', async () => {
  const { executor, store, reads } = coordinator()
  const held = store.add({ type: 'completed', sessionId: 'sess-own', sessionTitle: 'Own', summary: 'x', payload: { reply: 'r' } })
  const res = await executor.execute(cmd(held.id, { sessionId: 'sess-other' }))
  assert.deepEqual([res.ok, res.sessionId, res.title], [true, 'sess-own', 'Own'])
  assert.equal(reads[0].sessionId, 'sess-own')
})

test('the session id rules of thread.js still apply to a carried session id (no path traversal)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rq-orphan-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { executor } = coordinator({ threadOf: (opts) => readThread({ root, ...opts }) })
  for (const sessionId of ['../etc', '..', '.', 'a/b', 'a\\b', 'a.', 'a ', 'x'.repeat(129)]) {
    assert.deepEqual(await executor.execute(cmd('hub-only', { sessionId })), { ok: false, error: 'not-found' }, sessionId) // the service refuses it before any reader is asked
  }
  assert.deepEqual(await executor.execute(cmd('hub-only', { sessionId: 'valid-id-1' })), { ok: false, error: 'no-log' }, 'a valid id reaches the real reader')
})
