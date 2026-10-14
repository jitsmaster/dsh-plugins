import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { b64u } from '../webpush.js'

function fakeCtx(admit = () => ({})) {
  const routes = []
  const ctx = {
    on() {}, get: () => undefined, effect: () => {}, logger: { warn() {}, info() {} },
    inject: (_n, fn) => fn({ effect: (f) => f(), connection: { admit }, webServer: { register: (r) => routes.push(r) } }),
  }
  return { ctx, routes }
}

/** Runs the registered /review-queue route on a bare http server, as the Host web server would. */
async function serve(route) {
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port + '/review-queue'
  return { base, close: () => { server.closeAllConnections?.(); server.close() } }
}
const keys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64u(e.getPublicKey()), auth: b64u(randomBytes(16)) } }
const json = { 'content-type': 'application/json' }

test('apply creates the VAPID key once in the state dir and serves its public half', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  let web
  try {
    const a = fakeCtx()
    apply(a.ctx, { stateDir: dir })
    web = await serve(a.routes[0])
    const { key } = await (await fetch(web.base + '/v1/push/key')).json()
    const file = JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8'))
    assert.equal(key, file.publicKey)
    web.close()
    const b = fakeCtx()
    apply(b.ctx, { stateDir: dir })
    web = await serve(b.routes[0])
    assert.equal((await (await fetch(web.base + '/v1/push/key')).json()).key, key, 'same key after a restart')
  } finally { web?.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('devices are saved to push.json, survive a restart, and the test push goes through config.sendPush', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  const sent = []
  let web
  try {
    const sendPush = async (subscription, payload, opts) => { sent.push({ subscription, payload, opts }); return { ok: true, status: 201, gone: false } }
    const a = fakeCtx()
    apply(a.ctx, { stateDir: dir, sendPush })
    web = await serve(a.routes[0])
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', keys: keys() }
    const res = await fetch(web.base + '/v1/push/subscribe', { method: 'POST', headers: json, body: JSON.stringify({ subscription, name: 'Pixel' }) })
    assert.equal(res.status, 200)
    assert.ok(existsSync(join(dir, 'push.json')))
    web.close()
    const b = fakeCtx()
    apply(b.ctx, { stateDir: dir, sendPush })
    web = await serve(b.routes[0])
    assert.equal((await (await fetch(web.base + '/v1/push/devices')).json()).devices[0].name, 'Pixel')
    const t = await fetch(web.base + '/v1/push/test', { method: 'POST', headers: json, body: JSON.stringify({ endpoint: subscription.endpoint }) })
    assert.equal(t.status, 200)
    assert.deepEqual(sent[0].subscription, subscription)
    assert.equal(sent[0].opts.vapid.publicKey, JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8')).publicKey)
    assert.match(sent[0].opts.vapid.subject, /^(mailto:|https:\/\/)/)
  } finally { web?.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('push routes sit behind the same Host admission as every other route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  let web
  try {
    const a = fakeCtx(() => ({ rejection: 401 }))
    apply(a.ctx, { stateDir: dir })
    web = await serve(a.routes[0])
    assert.equal((await fetch(web.base + '/v1/push/devices')).status, 401)
    assert.equal((await fetch(web.base + '/v1/push/key')).status, 401)
  } finally { web?.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('config.pushSubject sets the VAPID contact; with an unusable state dir the routes still work for this run', async () => {
  const sent = []
  const blocker = join(mkdtempSync(join(tmpdir(), 'rq-')), 'a-file')
  writeFileSync(blocker, 'x') // a file where the directory should be: mkdir fails, nothing is persisted
  let web
  try {
    const a = fakeCtx()
    apply(a.ctx, { stateDir: blocker, pushSubject: 'https://example.org/contact', sendPush: async (s, p, o) => { sent.push(o); return { ok: true, status: 201, gone: false } } })
    web = await serve(a.routes[0])
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/mem', keys: keys() }
    await fetch(web.base + '/v1/push/subscribe', { method: 'POST', headers: json, body: JSON.stringify({ subscription }) })
    await fetch(web.base + '/v1/push/test', { method: 'POST', headers: json, body: JSON.stringify({ endpoint: subscription.endpoint }) })
    assert.equal(sent[0].vapid.subject, 'https://example.org/contact')
  } finally { web?.close(); rmSync(join(blocker, '..'), { recursive: true, force: true }) }
})
