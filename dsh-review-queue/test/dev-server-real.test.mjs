import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createECDH, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDevServer, REAL_QUEUE_SOURCE, REAL_STATE_DIR } from '../scripts/dev-server.mjs'

// The opt-in "real queue" mode: the dev server serves a COPY of the real queue.json (read-only on the source), without wiping or
// seeding, and the fake host keeps recording instead of acting.
const tmp = () => mkdtempSync(join(tmpdir(), 'rq-dev-real-'))
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const json = { 'content-type': 'application/json' }
const b64u = (buf) => Buffer.from(buf).toString('base64url')

/** A source queue.json made by the plugin itself: a demo dev server writes one, then stops. */
async function makeSource(dir) {
  const demo = await startDevServer({ port: 0, stateDir: join(dir, 'demo'), quiet: true })
  const snap = await (await fetch(demo.url + '/review-queue/v1/snapshot')).json()
  await demo.stop()
  return { file: join(dir, 'demo', 'queue.json'), snap }
}

test('the defaults point at the real queue file and at a scratch state dir under ~/.dsh/scratch', () => {
  assert.match(REAL_QUEUE_SOURCE, /[\\/]\.dsh[\\/]review-queue[\\/]queue\.json$/)
  assert.match(REAL_STATE_DIR, /[\\/]\.dsh[\\/]scratch[\\/]rq-dev-real-state$/)
})

test('real mode serves a copy of the source queue, is not seeded, and leaves the source byte for byte alone', async () => {
  const dir = tmp()
  try {
    const { file, snap: demo } = await makeSource(dir)
    const before = { hash: sha(file), mtime: statSync(file).mtimeMs }
    const stateDir = join(dir, 'real')
    const dev = await startDevServer({ port: 0, stateDir, quiet: true, realQueue: file })
    const snap = await (await fetch(dev.url + '/review-queue/v1/snapshot')).json()
    // same items as the source, none added on top of them (no seed). Like a DSH restart, the plugin cancels permission and question
    // items whose session is gone (they move to Resolved); everything else keeps its place.
    const ids = (list) => list.map((i) => i.id).sort()
    assert.deepEqual(ids([...snap.open, ...snap.resolved]), ids([...demo.open, ...demo.resolved]))
    assert.deepEqual(snap.open.map((i) => i.id), demo.open.filter((i) => !['permission', 'question'].includes(i.type)).map((i) => i.id))
    const plain = demo.open.find((i) => i.type === 'completed')
    // an action in the dev server changes the COPY only
    const res = await fetch(dev.url + '/review-queue/v1/reviewed', { method: 'POST', headers: json, body: JSON.stringify({ id: plain.id }) })
    assert.equal(res.status, 200)
    await dev.stop()
    assert.equal(sha(file), before.hash)
    assert.equal(statSync(file).mtimeMs, before.mtime)
    assert.notEqual(sha(join(stateDir, 'queue.json')), before.hash)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real mode records session calls instead of making them, and /__dev/reset re-copies the source', async () => {
  const dir = tmp()
  try {
    const { file, snap: demo } = await makeSource(dir)
    const dev = await startDevServer({ port: 0, stateDir: join(dir, 'real'), quiet: true, realQueue: file })
    const open = (await (await fetch(dev.url + '/review-queue/v1/snapshot')).json()).open
    const reply = open.find((i) => i.type === 'completed')
    await fetch(dev.url + '/review-queue/v1/reply', { method: 'POST', headers: json, body: JSON.stringify({ id: reply.id, text: 'hello' }) })
    assert.deepEqual((await (await fetch(dev.url + '/__dev/prompts')).json()).map((p) => p.text.includes('hello')), [true])
    await fetch(dev.url + '/__dev/reset', { method: 'POST' })
    const again = await (await fetch(dev.url + '/review-queue/v1/snapshot')).json()
    assert.equal(again.open.some((i) => i.id === reply.id), true, 'the copy is fresh again')
    assert.equal(again.open.length, open.length)
    assert.deepEqual(await (await fetch(dev.url + '/__dev/prompts')).json(), [])
    await dev.stop()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real mode refuses a missing source and a state dir that is the source folder', async () => {
  const dir = tmp()
  try {
    await assert.rejects(startDevServer({ port: 0, stateDir: join(dir, 'real'), quiet: true, realQueue: join(dir, 'nope.json') }), /source queue/i)
    const { file } = await makeSource(dir)
    await assert.rejects(startDevServer({ port: 0, stateDir: join(dir, 'demo'), quiet: true, realQueue: file }), /same folder|source/i)
    assert.equal(existsSync(file), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real mode keeps the push key and devices across a restart (a phone subscribed once stays subscribed)', async () => {
  const dir = tmp()
  try {
    const { file } = await makeSource(dir)
    const stateDir = join(dir, 'real')
    const first = await startDevServer({ port: 0, stateDir, quiet: true, realQueue: file })
    const key = (await (await fetch(first.url + '/review-queue/v1/push/key')).json()).key
    await first.stop()
    const second = await startDevServer({ port: 0, stateDir, quiet: true, realQueue: file })
    assert.equal((await (await fetch(second.url + '/review-queue/v1/push/key')).json()).key, key)
    await second.stop()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('without realPush a push is only recorded; /__dev/push sends a custom payload to a device and records it', async () => {
  const dir = tmp()
  const dev = await startDevServer({ port: 0, stateDir: join(dir, 's'), quiet: true })
  try {
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
    const subscription = { endpoint: 'https://push.example.com/send/xyz', keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) } }
    const sub = await (await fetch(dev.url + '/review-queue/v1/push/subscribe', { method: 'POST', headers: json, body: JSON.stringify({ subscription, name: 'Test' }) })).json()
    const res = await fetch(dev.url + '/__dev/push', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Question waiting', body: '1 item', tag: 'question', url: '#/item/abc' }) })
    assert.equal(res.status, 200)
    const out = await res.json()
    assert.equal(out.sent, 1)
    const recorded = await (await fetch(dev.url + '/__dev/pushes')).json()
    assert.deepEqual(recorded.map((p) => [p.payload.tag, p.payload.url, p.opts.topic]), [['question', '#/item/abc', 'question']])
    // a named device only
    const none = await (await fetch(dev.url + '/__dev/push', { method: 'POST', headers: json, body: JSON.stringify({ device: 'nope', title: 't' }) })).json()
    assert.equal(none.sent, 0)
    assert.ok(sub.device.id)
  } finally { await dev.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('realPush swaps the recorder for the plugin\'s real sender', async () => {
  const dir = tmp()
  const calls = []
  const dev = await startDevServer({ port: 0, stateDir: join(dir, 's'), quiet: true, realPush: true, sendPushOverride: async (...a) => { calls.push(a); return { ok: true, status: 201, gone: false } } })
  try {
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
    const subscription = { endpoint: 'https://push.example.com/send/real', keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) } }
    await fetch(dev.url + '/review-queue/v1/push/subscribe', { method: 'POST', headers: json, body: JSON.stringify({ subscription }) })
    await fetch(dev.url + '/__dev/push', { method: 'POST', headers: json, body: JSON.stringify({ title: 'T' }) })
    assert.equal(calls.length, 1, 'the injected "real" sender was used')
    assert.deepEqual(await (await fetch(dev.url + '/__dev/pushes')).json(), [], 'nothing recorded in real mode')
  } finally { await dev.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('/__dev/pr-merged adds a merged-PR item through the real queue (so a live phone list can be driven)', async () => {
  const dir = tmp()
  const dev = await startDevServer({ port: 0, stateDir: join(dir, 's'), quiet: true })
  try {
    const before = await (await fetch(dev.url + '/review-queue/v1/snapshot')).json()
    const res = await fetch(dev.url + '/__dev/pr-merged', { method: 'POST', headers: json, body: JSON.stringify({ prId: '99', title: 'PR 99 - live', followUps: [{ id: 'f', title: 'follow up' }] }) })
    assert.equal(res.status, 200)
    const after = await (await fetch(dev.url + '/review-queue/v1/snapshot')).json()
    const added = after.open.filter((i) => !before.open.some((b) => b.id === i.id))
    assert.deepEqual(added.map((i) => [i.type, i.payload.prId]), [['pr-merged', '99']])
    assert.equal(added[0].payload.followUps.length, 1)
  } finally { await dev.stop(); rmSync(dir, { recursive: true, force: true }) }
})
