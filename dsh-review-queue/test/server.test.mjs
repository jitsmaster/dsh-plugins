import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'

let server, base, store, queue, calls
before(async () => {
  let n = 0
  store = createStore({ uuid: () => 'i' + ++n })
  calls = []
  const capture = {
    answerQuestion: (id, answers) => { calls.push(['answer', id, answers]); return answers.length ? { ok: true } : { ok: false, error: 'bad-answer' } },
    decidePermission: (id, d) => { calls.push([d, id]); return { ok: true } },
  }
  queue = createReviewQueue({ store, capture, controllerOf: () => ({ prompt: async () => ({}) }) })
  const serve = createRouter({ queue, dev: undefined })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))

const post = (path, body, headers = { 'content-type': 'application/json' }) => fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
const completed = (over = {}) => store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'Did X.', payload: { reply: 'r' }, ...over })

test('GET /v1/snapshot returns open items with positions and spoken text', async () => {
  completed()
  const res = await fetch(base + '/v1/snapshot')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('cache-control'), /no-store/)
  const snap = await res.json()
  assert.equal(snap.open.length, 1)
  assert.equal(snap.open[0].position, 1)
  assert.ok(snap.open[0].spoken.headline)
})

test('snapshot with a current since id and no wait answers unchanged at once', async () => {
  const snap = await (await fetch(base + '/v1/snapshot')).json()
  const res = await (await fetch(base + '/v1/snapshot?since=' + encodeURIComponent(snap.snapshotId))).json()
  assert.deepEqual(res, { unchanged: true, snapshotId: snap.snapshotId })
})

test('long poll returns as soon as something changes', async () => {
  const snap = await (await fetch(base + '/v1/snapshot')).json()
  const started = Date.now()
  const pending = fetch(base + '/v1/snapshot?wait=5000&since=' + encodeURIComponent(snap.snapshotId)).then((r) => r.json())
  setTimeout(() => completed({ sessionId: 'later' }), 50)
  const res = await pending
  assert.ok(Date.now() - started < 3000)
  assert.ok(res.open.some((i) => i.sessionId === 'later'))
})

test('long poll gives up quietly when nothing changes', async () => {
  const snap = await (await fetch(base + '/v1/snapshot')).json()
  const res = await (await fetch(base + '/v1/snapshot?wait=100&since=' + encodeURIComponent(snap.snapshotId))).json()
  assert.equal(res.unchanged, true)
})

test('actions need JSON content type, valid JSON and a small body', async () => {
  assert.equal((await post('/v1/reviewed', { id: 'x' }, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await post('/v1/reviewed', '{nope')).status, 400)
  assert.equal((await post('/v1/reply', { id: 'x', text: 'y'.repeat(100_000) })).status, 413)
})

test('reviewed resolves a completed item; a repeat is a 409', async () => {
  const c = completed({ sessionId: 'r1' })
  assert.equal((await post('/v1/reviewed', { id: c.id })).status, 200)
  assert.equal(store.get(c.id).status, 'resolved')
  const again = await post('/v1/reviewed', { id: c.id })
  assert.equal(again.status, 409)
  assert.equal((await again.json()).error, 'not-open')
})

test('answer, approve, deny and reply route to the service', async () => {
  const q = store.add({ type: 'question', sessionId: 'q', payload: { questions: [] } })
  assert.equal((await post('/v1/answer', { id: q.id, answers: [{ id: 'a', selected: ['A'] }] })).status, 200)
  assert.equal((await post('/v1/answer', { id: q.id, answers: [] })).status, 400)
  assert.equal((await post('/v1/approve', { id: 'p' })).status, 200)
  assert.equal((await post('/v1/deny', { id: 'p' })).status, 200)
  const c = completed({ sessionId: 'rep' })
  assert.equal((await post('/v1/reply', { id: c.id, text: 'go on' })).status, 200)
  assert.equal((await post('/v1/reply', { id: c.id, text: '' })).status, 409)
})

test('focus can be set and cleared', async () => {
  const c = completed({ sessionId: 'f' })
  assert.equal((await post('/v1/focus', { id: c.id })).status, 200)
  assert.equal((await (await fetch(base + '/v1/snapshot')).json()).focusId, c.id)
  assert.equal((await post('/v1/focus', { id: null })).status, 200)
  assert.equal((await post('/v1/focus', { id: 'ghost' })).status, 409)
})

test('unknown routes are 404, wrong methods 405, and dev routes do not exist unless enabled', async () => {
  assert.equal((await fetch(base + '/v1/nope')).status, 404)
  assert.equal((await fetch(base + '/v1/reviewed')).status, 405)
  assert.equal((await post('/v1/dev/ask', {})).status, 404)
})

test('with dev enabled, the dev route runs the real handlers', async () => {
  const seen = []
  const serve = createRouter({ queue, dev: { ask: async (b) => { seen.push(b); return { ok: true } } } })
  const s = createServer((req, res) => serve(req, res))
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const res = await fetch('http://127.0.0.1:' + s.address().port + '/v1/dev/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'question' }) })
  assert.equal(res.status, 200)
  assert.deepEqual(seen, [{ kind: 'question' }])
  s.closeAllConnections?.(); s.close()
})
