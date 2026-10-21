import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { createTodoImages, MAX_IMAGE_BYTES } from '../todo-images.js'

// POST /v1/todo-image takes ONE raw image (the JSON bodies are capped at 64 KB); POST /v1/todo then names the saved ids.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200_000, 7)])
let server, base, dir, calls
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rq-imgsrv-'))
  calls = []
  const store = createStore({})
  const controller = { create: async () => ({ sessionId: 'S1' }), rename: async () => {}, prompt: async (req) => { calls.push(req); return {} } }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => controller, registryOf: () => ({ list: () => [{ id: 'w1', title: 'Alpha', path: 'D:/a/alpha', sessionIds: [] }] }), todoImages: createTodoImages({ root: join(dir, 'todo-images') }) })
  const serve = createRouter({ queue })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
  globalThis.__queue = queue
})
after(() => new Promise((r) => { rmSync(dir, { recursive: true, force: true }); server.closeAllConnections?.(); server.close(r) }))
const upload = (body, type = 'image/png', method = 'POST') => fetch(base + '/v1/todo-image', { method, headers: type ? { 'content-type': type } : {}, body })
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('a raw image over 64 KB is accepted and answered with its id', async () => {
  const res = await upload(PNG)
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.ok, true)
  assert.equal(j.mediaType, 'image/png')
  assert.equal(j.bytes, PNG.length)
  assert.match(j.id, /^[0-9a-f-]{36}$/)
})

test('the type comes from the bytes: a text file sent as image/png is a 400 bad-image', async () => {
  const res = await upload(Buffer.from('just text, not a picture'))
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { ok: false, error: 'bad-image' })
})

test('a request that is not an image type is a 415; other methods a 405', async () => {
  assert.equal((await upload(PNG, 'application/json')).status, 415)
  assert.equal((await upload(PNG, 'text/plain')).status, 415)
  assert.equal((await upload(undefined, 'image/png', 'GET')).status, 405)
})

test('a body over the cap is a 413 too-large', async () => {
  const res = await upload(Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))
  assert.equal(res.status, 413)
  assert.deepEqual(await res.json(), { ok: false, error: 'too-large' })
})

test('POST /v1/todo with the saved ids starts a session whose prompt has the image', async () => {
  const { id } = await (await upload(PNG)).json()
  calls.length = 0
  const res = await post('/v1/todo', { text: 'Look at this', workspaceId: 'w1', images: [id] })
  assert.equal(res.status, 200)
  await globalThis.__queue.todoIdle()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].content.map((p) => p.type), ['text', 'image'])
  assert.equal(calls[0].content[1].mediaType, 'image/png')
})

test('bad image ids are a 400 with their own codes', async () => {
  const code = async (images) => { const r = await post('/v1/todo', { text: 'x', workspaceId: 'w1', images }); return [r.status, (await r.json()).error] }
  assert.deepEqual(await code('nope'), [400, 'bad-images'])
  assert.deepEqual(await code(['../x']), [400, 'bad-images'])
  assert.deepEqual(await code(['00000000-0000-4000-8000-000000000000']), [400, 'unknown-image'])
  assert.deepEqual(await code(Array(6).fill('00000000-0000-4000-8000-000000000000')), [400, 'too-many-images'])
})
