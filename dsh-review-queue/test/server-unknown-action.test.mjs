import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'

// An unknown route must not look like a missing item: the client tells them apart ("older server" vs "item gone").
let server, base
before(async () => {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const speaker = { speak: () => ({ ok: true }), stop: () => {} }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({ prompt: async () => ({}) }), speaker })
  const serve = createRouter({ queue, dev: undefined })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('an unknown route answers 404 unknown-action', async () => {
  const res = await post('/v1/does-not-exist', {})
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { error: 'unknown-action' })
})

test('a genuinely missing item is not an unknown action: 409 not-found', async () => {
  const res = await post('/v1/read', { id: 'nope' })
  assert.equal(res.status, 409)
  assert.deepEqual(await res.json(), { ok: false, error: 'not-found' })
})
