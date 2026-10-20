import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHub } from '../hub/hub.js'
import { outcome as hubOutcome } from '../hub/http.js'
import { outcome as serverOutcome } from '../server.js'
import { FILES } from '../mobile.js'
import { raw, postJson, tmpDir } from './hub-helpers.mjs'

const P = '/review-queue'
const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89'

async function startHub(t, { dir = tmpDir(t), config, ...over } = {}) {
  if (config) writeFileSync(join(dir, 'hub.config.json'), JSON.stringify(config))
  const logs = []
  const hub = createHub({ stateDir: dir, port: 0, tickMs: 0, log: (l) => logs.push(l), ...over })
  await hub.start()
  t.after(() => hub.stop())
  return { hub, dir, logs, port: hub.port }
}
const feed = (hub, over = {}, owner = 'A1') => hub.store.applyOp({ op: 'add', item: { type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'Did X.', payload: { reply: 'r' }, ...over } }, { owner }).id
const get = (port, path, headers = {}) => raw({ port, path, headers })

// ---- health, routing -----------------------------------------------------------------------------------------------------------

test('health is public and minimal: ok, service, hubId, protocol, version and nothing else', async (t) => {
  const { hub, port } = await startHub(t)
  const res = await get(port, '/hub/v1/health')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.deepEqual(Object.keys(res.json).sort(), ['hubId', 'ok', 'protocol', 'service', 'version'])
  assert.equal(res.json.ok, true)
  assert.equal(res.json.service, 'dsh-review-queue-hub')
  assert.equal(res.json.hubId, hub.hubId)
  assert.equal(typeof res.json.protocol, 'number')
  assert.equal(typeof res.json.version, 'string')
})

test('health needs no role: it answers even when every credential check refuses', async (t) => {
  const { port } = await startHub(t, { roleOf: () => undefined })
  assert.equal((await get(port, '/hub/v1/health')).status, 200)
})

test('unknown paths and unknown API versions are 404', async (t) => {
  const { port } = await startHub(t)
  for (const path of ['/', '/hub/v1/nothing', '/review-queue', P + '/v9/snapshot', '/v1/snapshot', '/m/']) {
    const res = await get(port, path)
    assert.equal(res.status, 404, path)
  }
})

// ---- Host allow-list and Origin ------------------------------------------------------------------------------------------------

test('only the loopback names with the hub port (and the configured public host) are accepted as Host', async (t) => {
  const { port } = await startHub(t, { config: { publicUrl: 'https://rq.example.ts.net' } })
  for (const host of ['127.0.0.1:' + port, 'localhost:' + port, 'LOCALHOST:' + port, 'rq.example.ts.net']) {
    assert.equal((await raw({ port, path: '/hub/v1/health', headers: { host } })).status, 200, host)
  }
  for (const host of ['evil.example', 'evil.example:' + port, '127.0.0.1', '127.0.0.1:1', 'localhost:1', '127.0.0.1.evil.example:' + port, 'rq.example.ts.net:81']) {
    const res = await raw({ port, path: '/hub/v1/health', headers: { host } })
    assert.equal(res.status, 403, JSON.stringify(host))
    assert.deepEqual(res.json, { error: 'bad-host' })
  }
})

test('the Host check covers the API, the app files and assetlinks too', async (t) => {
  const { port } = await startHub(t)
  for (const path of [P + '/v1/snapshot', P + '/m/', '/.well-known/assetlinks.json']) {
    const res = await raw({ port, path, headers: { host: 'evil.example' } })
    assert.equal(res.status, 403, path)
  }
})

test('a POST with a foreign or null Origin is refused; the loopback and public origins and no Origin are fine', async (t) => {
  const { port } = await startHub(t, { config: { publicUrl: 'https://rq.example.ts.net' } })
  for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:1', 'http://localhost', 'https://rq.example.ts.net:444']) {
    const res = await postJson(port, P + '/v1/reviewed', { id: 'x' }, { origin })
    assert.equal(res.status, 403, origin)
    assert.deepEqual(res.json, { error: 'bad-origin' })
  }
  for (const origin of [undefined, 'http://127.0.0.1:' + port, 'http://localhost:' + port, 'https://rq.example.ts.net']) {
    const res = await postJson(port, P + '/v1/reviewed', { id: 'x' }, origin ? { origin } : {})
    assert.equal(res.status, 409, String(origin))
  }
})

// ---- roles ---------------------------------------------------------------------------------------------------------------------

test('a plain loopback request is the desktop role; one that came through tailscale serve is refused until real roles exist', async (t) => {
  const { port } = await startHub(t)
  assert.equal((await get(port, P + '/v1/snapshot')).status, 200)
  for (const headers of [{ 'x-forwarded-for': '100.64.0.9' }, { 'tailscale-user-login': 'me@example.com' }, { forwarded: 'for=100.64.0.9' }]) {
    const res = await get(port, P + '/v1/snapshot', headers)
    assert.equal(res.status, 401, JSON.stringify(headers))
    assert.deepEqual(res.json, { error: 'auth-required' })
  }
  assert.equal((await get(port, '/hub/v1/health', { 'x-forwarded-for': '100.64.0.9' })).status, 200)
  assert.equal((await get(port, P + '/m/', { 'x-forwarded-for': '100.64.0.9' })).status, 200)
})

test('roles are pluggable: roleOf decides who may read and act; static files and health stay public', async (t) => {
  let role = 'device'
  const seen = []
  const { hub, port } = await startHub(t, { roleOf: (req) => { seen.push(req.url); return role } })
  const id = feed(hub)
  assert.equal((await get(port, P + '/v1/snapshot')).status, 200)
  assert.equal((await postJson(port, P + '/v1/reviewed', { id })).status, 200)
  assert.ok(seen.length >= 2)
  role = undefined
  assert.equal((await get(port, P + '/v1/snapshot')).status, 401)
  assert.equal((await get(port, P + '/v1/workspaces')).status, 401)
  assert.equal((await postJson(port, P + '/v1/reopen', { id })).status, 401)
  assert.equal((await get(port, P + '/m/')).status, 200)
  assert.equal((await get(port, '/.well-known/assetlinks.json')).status, 200)
  assert.equal((await get(port, '/hub/v1/health')).status, 200)
})

// ---- body handling and error mapping -------------------------------------------------------------------------------------------

test('error mapping is server.js outcome() itself, not a copy', () => {
  assert.equal(hubOutcome, serverOutcome)
})

test('an action needs JSON, valid JSON, an object and at most 64 KB', async (t) => {
  const { port } = await startHub(t)
  const url = P + '/v1/reviewed'
  assert.equal((await raw({ port, method: 'POST', path: url, headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415)
  assert.equal((await postJson(port, url, '{nope')).status, 400)
  assert.equal((await postJson(port, url, '[1]')).status, 400)
  assert.deepEqual((await postJson(port, url, '[1]')).json, { error: 'bad-request' })
  assert.equal((await postJson(port, url, { id: 'x', pad: 'y'.repeat(100_000) })).status, 413)
})

test('unknown actions are 404 unknown-action and the wrong method is 405', async (t) => {
  const { port } = await startHub(t)
  const res = await postJson(port, P + '/v1/does-not-exist', {})
  assert.equal(res.status, 404)
  assert.deepEqual(res.json, { error: 'unknown-action' })
  assert.equal((await get(port, P + '/v1/reviewed')).status, 405)
  assert.equal((await postJson(port, P + '/v1/snapshot', {})).status, 405)
  assert.equal((await postJson(port, P + '/v1/workspaces', {})).status, 405)
  assert.equal((await raw({ port, method: 'DELETE', path: P + '/v1/snapshot' })).status, 405)
})

test('reviewed resolves a completed item; a repeat, a question and an unknown id are 409 like server.js', async (t) => {
  const { hub, port } = await startHub(t)
  const id = feed(hub)
  const question = feed(hub, { type: 'question', payload: { questions: [{ question: 'Which one?', options: [] }] } })
  const ok = await postJson(port, P + '/v1/reviewed', { id })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { ok: true })
  assert.equal(hub.store.get(id).resolution.kind, 'reviewed')
  const again = await postJson(port, P + '/v1/reviewed', { id })
  assert.deepEqual([again.status, again.json], [409, { ok: false, error: 'not-open' }])
  const q = await postJson(port, P + '/v1/reviewed', { id: question })
  assert.deepEqual([q.status, q.json], [409, { ok: false, error: 'not-completed' }])
  const missing = await postJson(port, P + '/v1/reviewed', { id: 'nope' })
  assert.deepEqual([missing.status, missing.json], [409, { ok: false, error: 'not-open' }])
})

test('reopen puts a reviewed item back; an open one or an unknown id is refused', async (t) => {
  const { hub, port } = await startHub(t)
  const id = feed(hub)
  assert.deepEqual((await postJson(port, P + '/v1/reopen', { id })).json, { ok: false, error: 'not-reopenable' })
  await postJson(port, P + '/v1/reviewed', { id })
  const ok = await postJson(port, P + '/v1/reopen', { id })
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }])
  assert.equal(hub.store.get(id).status, 'open')
  const missing = await postJson(port, P + '/v1/reopen', { id: 'nope' })
  assert.deepEqual([missing.status, missing.json], [409, { ok: false, error: 'not-found' }])
})

test('actions only the owner can run say so while no agent exists: 409 owner-offline for an open item, not-found / not-open otherwise', async (t) => {
  const { hub, port } = await startHub(t)
  const open = feed(hub, { type: 'permission', payload: { toolName: 'shell', summary: 'ls' } })
  const done = feed(hub)
  hub.store.applyOp({ op: 'resolve', id: done, resolution: { kind: 'reviewed' } }, { owner: 'A1' })
  for (const action of ['answer', 'approve', 'approve-similar', 'deny', 'reply', 'archive', 'todo-confirm', 'todo-cancel']) {
    const res = await postJson(port, P + '/v1/' + action, { id: open })
    assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'owner-offline' }], action)
    assert.deepEqual((await postJson(port, P + '/v1/' + action, { id: 'nope' })).json, { ok: false, error: 'not-found' }, action)
    assert.deepEqual((await postJson(port, P + '/v1/' + action, { id: done })).json, { ok: false, error: 'not-open' }, action)
  }
})

test('a late answer targets a closed question, so only an unknown id or a missing owner stops it', async (t) => {
  const { hub, port } = await startHub(t)
  const q = feed(hub, { type: 'question', payload: { questions: [{ question: 'Which one?', options: [] }] } })
  hub.store.applyOp({ op: 'resolve', id: q, resolution: { kind: 'expired' } }, { owner: 'A1' })
  assert.deepEqual((await postJson(port, P + '/v1/late-answer', { id: q, answers: [] })).json, { ok: false, error: 'owner-offline' })
  assert.deepEqual((await postJson(port, P + '/v1/late-answer', { id: 'nope' })).json, { ok: false, error: 'not-found' })
})

test('a new todo needs a workspace registry, which only agents have: 409 no-registry', async (t) => {
  const { port } = await startHub(t)
  const res = await postJson(port, P + '/v1/todo', { text: 'do it' })
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'no-registry' }])
})

test('read, read-tip, tip-deeper, tip-todo, stop, ui and focus belong to the desktop app that owns the speakers and the screen: 403 local-only', async (t) => {
  const { port } = await startHub(t)
  for (const action of ['read', 'read-tip', 'tip-deeper', 'tip-todo', 'stop', 'ui', 'focus']) {
    const res = await postJson(port, P + '/v1/' + action, { id: 'x' })
    assert.deepEqual([res.status, res.json], [403, { ok: false, error: 'local-only' }], action)
  }
})

test('workspaces is an empty list until agents report theirs', async (t) => {
  const { port } = await startHub(t)
  const res = await get(port, P + '/v1/workspaces')
  assert.deepEqual([res.status, res.json], [200, { workspaces: [] }])
})

// ---- snapshot ------------------------------------------------------------------------------------------------------------------

test('the snapshot has what the overlay and the phone page render: positions, titles, speech, risks, resolved', async (t) => {
  let now = 5_000_000_000_000
  const { hub, port } = await startHub(t, { now: () => now })
  feed(hub, { sessionId: 'a', createdAt: now - 3000 }, 'A1')
  feed(hub, { type: 'permission', sessionId: 'b', createdAt: now - 2000, payload: { toolName: 'shell', detail: 'rm -rf /tmp/x', summary: 'delete x' } }, 'B2')
  const gone = feed(hub, { sessionId: 'c', createdAt: now - 1000 })
  hub.store.applyOp({ op: 'resolve', id: gone, resolution: { kind: 'reviewed' } }, { owner: 'A1' })
  const res = await get(port, P + '/v1/snapshot')
  assert.equal(res.status, 200)
  assert.match(res.headers['cache-control'], /no-store/)
  const snap = res.json
  assert.equal(snap.serverNow, now)
  assert.equal(snap.snapshotId, hub.store.epoch + ':' + hub.store.rev)
  assert.deepEqual(snap.open.map((i) => [i.position, i.sessionId, i.owner]), [[1, 'a', 'A1'], [2, 'b', 'B2']])
  assert.ok(snap.open[0].spoken.headline)
  assert.ok(snap.open[0].title)
  assert.deepEqual(snap.open[1].risks.map((r) => r.code), ['recursive-delete'])
  assert.deepEqual(snap.resolved.map((i) => i.id), [gone])
  assert.equal(snap.focusId, undefined, 'focus, reading and ui are instance-local (D7): the hub has none')
})

test('a since token that is current answers unchanged at once, in the overlay format (id|||0) and the bare id', async (t) => {
  const { hub, port } = await startHub(t)
  feed(hub)
  const snap = (await get(port, P + '/v1/snapshot')).json
  for (const since of [snap.snapshotId + '|||0', snap.snapshotId]) {
    const res = await get(port, P + '/v1/snapshot?since=' + encodeURIComponent(since))
    assert.deepEqual(res.json, { unchanged: true, snapshotId: snap.snapshotId })
  }
  const stale = await get(port, P + '/v1/snapshot?since=' + encodeURIComponent('old:1|||0'))
  assert.ok(Array.isArray(stale.json.open), 'a stale token gets the full snapshot')
  const moved = await get(port, P + '/v1/snapshot?since=' + encodeURIComponent(snap.snapshotId + '|x||0'))
  assert.ok(Array.isArray(moved.json.open), 'a token with a focus the hub does not have is not current')
})

test('the long poll returns as soon as something changes, and gives up quietly when nothing does', async (t) => {
  const { hub, port } = await startHub(t)
  const snap = (await get(port, P + '/v1/snapshot')).json
  const since = encodeURIComponent(snap.snapshotId + '|||0')
  const started = Date.now()
  const pending = get(port, P + '/v1/snapshot?wait=5000&since=' + since)
  setTimeout(() => feed(hub, { sessionId: 'later' }), 60)
  const res = await pending
  assert.ok(Date.now() - started < 3000)
  assert.ok(res.json.open.some((i) => i.sessionId === 'later'))
  const quiet = await get(port, P + '/v1/snapshot?wait=100&since=' + encodeURIComponent(res.json.snapshotId + '|||0'))
  assert.equal(quiet.json.unchanged, true)
})

test('a long poll that is still waiting when the hub shuts down is answered 503 shutting-down', async (t) => {
  const { hub, port } = await startHub(t)
  const snap = (await get(port, P + '/v1/snapshot')).json
  const pending = get(port, P + '/v1/snapshot?wait=20000&since=' + encodeURIComponent(snap.snapshotId + '|||0'))
  await new Promise((r) => setTimeout(r, 100))
  await hub.stop()
  const res = await pending
  assert.deepEqual([res.status, res.json], [503, { error: 'shutting-down' }])
})

// ---- the phone app files -------------------------------------------------------------------------------------------------------

test('the phone app is served under /review-queue/m/ with no credential and no data', async (t) => {
  const { port } = await startHub(t, { roleOf: () => undefined })
  const page = await get(port, P + '/m/')
  assert.equal(page.status, 200)
  assert.match(page.headers['content-type'], /^text\/html/)
  assert.match(page.text, /manifest\.webmanifest/)
  for (const name of Object.keys(FILES).filter((n) => n && n !== 'index.html')) {
    const res = await get(port, P + '/m/' + name)
    assert.equal(res.status, 200, name)
  }
  const sw = await get(port, P + '/m/sw.js')
  assert.equal(sw.headers['service-worker-allowed'], './')
})

test('/review-queue/m redirects to the slash form; traversal, unknown names and the wrong method are refused', async (t) => {
  const { port } = await startHub(t)
  const redirect = await get(port, P + '/m')
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.location, 'm/')
  for (const path of ['/m/../server.js', '/m/%2e%2e/server.js', '/m/store.js', '/m/vendor/', '/m/__proto__', '/m/constructor']) {
    assert.equal((await get(port, P + path)).status, 404, path)
  }
  assert.equal((await raw({ port, method: 'POST', path: P + '/m/', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 405)
  assert.equal((await raw({ port, method: 'HEAD', path: P + '/m/' })).status, 200)
})

// ---- assetlinks ----------------------------------------------------------------------------------------------------------------

test('assetlinks.json is an empty list when the app is not configured', async (t) => {
  const { port } = await startHub(t)
  const res = await get(port, '/.well-known/assetlinks.json')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /^application\/json/)
  assert.equal(res.text, '[]')
  assert.equal(res.headers.location, undefined, 'no redirect: Chrome refuses one')
})

test('assetlinks.json lists the configured package and fingerprints; only GET and HEAD, only the exact path', async (t) => {
  const { port } = await startHub(t, { config: { android: { packageName: 'com.example.rq', sha256CertFingerprints: [FP] } } })
  const res = await get(port, '/.well-known/assetlinks.json')
  assert.equal(res.json[0].target.package_name, 'com.example.rq')
  assert.deepEqual(res.json[0].target.sha256_cert_fingerprints, [FP])
  assert.equal((await raw({ port, method: 'HEAD', path: '/.well-known/assetlinks.json' })).status, 200)
  assert.equal((await postJson(port, '/.well-known/assetlinks.json', {})).status, 405)
  assert.equal((await get(port, '/.well-known/assetlinks.json/')).status, 404)
  assert.equal((await get(port, P + '/.well-known/assetlinks.json')).status, 404)
})
