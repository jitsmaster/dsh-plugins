import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDevServer } from '../scripts/dev-server.mjs'

// The phone page's dev server: the plugin's real pieces on a bare http server, seeded with one demo item per card type.
let dev
let stateDir
const b64u = (buf) => Buffer.from(buf).toString('base64url')

before(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'rq-dev-test-'))
  dev = await startDevServer({ port: 0, stateDir, quiet: true })
})
after(async () => {
  await dev?.stop()
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

const get = (path, init) => fetch(dev.url + path, init)
const snapshot = async () => (await get('/review-queue/v1/snapshot')).json()

test('/ sends the browser to the phone app, which is served as HTML', async () => {
  const root = await get('/', { redirect: 'manual' })
  assert.equal(root.status, 302)
  assert.equal(root.headers.get('location'), '/review-queue/m/')
  const page = await get('/review-queue/m/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /^text\/html/)
  assert.match(await page.text(), /<div id="app">/)
})

test('the manifest and the service worker are served with the types and headers the browser needs', async () => {
  const manifest = await get('/review-queue/m/manifest.webmanifest')
  assert.equal(manifest.status, 200)
  assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/)
  const json = await manifest.json()
  assert.equal(json.display, 'standalone')
  const sw = await get('/review-queue/m/sw.js')
  assert.equal(sw.status, 200)
  assert.match(sw.headers.get('content-type'), /^text\/javascript/)
  assert.equal(sw.headers.get('service-worker-allowed'), './')
  assert.equal(sw.headers.get('cache-control'), 'no-cache')
  assert.equal(sw.headers.get('x-content-type-options'), 'nosniff')
})

test('the snapshot holds a demo item of every type the phone draws', async () => {
  const snap = await snapshot()
  const types = new Set(snap.open.map((i) => i.type))
  for (const t of ['permission', 'question', 'completed', 'pr-merged', 'todo']) assert.ok(types.has(t), 'open ' + t)
  const permissions = snap.open.filter((i) => i.type === 'permission')
  assert.ok(permissions.some((i) => i.risks.length > 0), 'a risky permission')
  assert.ok(permissions.some((i) => i.risks.length === 0), 'a plain permission')
  const questions = snap.open.filter((i) => i.type === 'question')
  assert.ok(questions.some((i) => i.payload.questions.length === 1), 'a single question')
  assert.ok(questions.some((i) => i.payload.questions.length > 1), 'a multi-question')
  assert.ok(questions.some((i) => i.payload.questions.some((q) => q.multiSelect)), 'a multi-select question')
  assert.ok(snap.open.some((i) => i.type === 'completed' && i.summary), 'a completed item with a summary')
})

test('Resolved holds a reviewed, an approved, an expired question and an archived merged-PR item', async () => {
  const kinds = new Set((await snapshot()).resolved.map((i) => i.resolution.kind))
  for (const k of ['reviewed', 'approved', 'expired', 'archived']) assert.ok(kinds.has(k), 'resolved ' + k)
})

test('an approve with the confirm flags goes through the real queue and leaves the list', async () => {
  const plain = (await snapshot()).open.find((i) => i.type === 'permission' && i.risks.length === 0)
  const res = await get('/review-queue/v1/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: plain.id, via: 'phone', confirmed: true }) })
  assert.equal(res.status, 200)
  assert.equal((await snapshot()).open.some((i) => i.id === plain.id), false)
})

test('a push test is recorded instead of sent, and the push routes answer', async () => {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const subscription = { endpoint: 'https://push.example.com/send/abc', keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) } }
  const json = { 'content-type': 'application/json' }
  assert.equal((await get('/review-queue/v1/push/key')).status, 200)
  const sub = await get('/review-queue/v1/push/subscribe', { method: 'POST', headers: json, body: JSON.stringify({ subscription, name: 'Pixel 7' }) })
  assert.equal(sub.status, 200)
  const test = await get('/review-queue/v1/push/test', { method: 'POST', headers: json, body: JSON.stringify({ endpoint: subscription.endpoint }) })
  assert.equal(test.status, 200)
  const sent = await (await get('/__dev/pushes')).json()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].endpoint, subscription.endpoint)
  assert.equal(sent[0].payload.body, 'Test notification')
})

test('reset starts again from a fresh seeded list', async () => {
  const before = await snapshot()
  await dev.reset()
  const after = await snapshot()
  assert.notEqual(after.snapshotId, before.snapshotId)
  assert.ok(after.open.some((i) => i.type === 'permission' && i.risks.length === 0), 'the approved one is back')
  assert.deepEqual(await (await get('/__dev/pushes')).json(), [])
})

test('an unknown path is a 404', async () => {
  assert.equal((await get('/nope')).status, 404)
})
