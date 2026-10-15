import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHardener } from '../hub/file-acl.js'
import { raw } from './hub-helpers.mjs'
import { agentOf, sync } from './hub-agent-helpers.mjs'
import { HOST, LOGIN, P, SECRET, serveHeaders, startPhoneHub } from './hub-device-helpers.mjs'

const permission = (over = {}) => ({ type: 'permission', sessionId: 's1', workspace: 'D:/w', payload: { toolName: 'shell', summary: 'ls', detail: 'ls' }, ...over })
const risky = () => permission({ payload: { toolName: 'shell', summary: 'rm', detail: 'rm -rf /tmp/x' } })

// ---- pairing over HTTP -------------------------------------------------------------------------------------------------------------

test('the desktop gets a code and the pairing URL with the code only in the fragment', async (t) => {
  const { desktop } = await startPhoneHub(t)
  const r = await desktop('POST', '/hub/v1/pairing-codes', {})
  assert.equal(r.status, 200)
  assert.match(r.json.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  assert.equal(r.json.url, 'https://' + HOST + '/review-queue/m/#/pair')
  assert.equal(r.json.link, r.json.url + '/' + r.json.code)
  assert.ok(r.json.expiresAt > 0)
  assert.equal(r.headers['cache-control'], 'no-store')
})

test('without a publicUrl the code comes without a URL (the page says to configure it)', async (t) => {
  const { desktop } = await startPhoneHub(t, { config: { publicUrl: undefined } })
  assert.equal((await desktop('POST', '/hub/v1/pairing-codes', {})).json.url, null)
})

test('a phone pairs with the code through the public name and gets its token once; the file holds only the hash', async (t) => {
  const { dir, pairPhone, desktop } = await startPhoneHub(t)
  const p = await pairPhone('Pixel 9')
  assert.equal(p.res.status, 200)
  assert.match(p.token, /^rqd_[A-Za-z0-9_-]{43}$/)
  assert.equal(p.name, 'Pixel 9')
  const file = readFileSync(join(dir, 'hub', 'devices.json'), 'utf8')
  assert.ok(!file.includes(p.token))
  const list = (await desktop('GET', '/hub/v1/devices')).json
  assert.equal(list.devices.length, 1)
  assert.equal(list.devices[0].lastLogin, LOGIN)
  assert.equal(list.devices[0].id, p.deviceId)
  assert.ok(!JSON.stringify(list).includes(p.token))
  assert.ok(!JSON.stringify(list).includes('tokenHash'))
  assert.equal((await p.call('GET', P + '/v1/snapshot')).status, 200)
})

test('a wrong code is a 400 bad-code, and the 6th guess never succeeds even with the right code', async (t) => {
  const { desktop, call } = await startPhoneHub(t)
  const { json } = await desktop('POST', '/hub/v1/pairing-codes', {})
  const wrongCode = (json.code[0] === 'A' ? 'B' : 'A') + json.code.slice(1)
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/hub/v1/pair', { code: wrongCode, name: 'x' }, serveHeaders({ 'x-forwarded-for': '100.64.1.' + i }))
    assert.deepEqual([r.status, r.json], [400, { error: 'bad-code' }])
  }
  const sixth = await call('POST', '/hub/v1/pair', { code: json.code, name: 'x' }, serveHeaders({ 'x-forwarded-for': '100.64.2.1' }))
  assert.deepEqual([sixth.status, sixth.json], [400, { error: 'bad-code' }])
  assert.deepEqual((await desktop('GET', '/hub/v1/devices')).json.devices, [])
})

test('wrong answers are delayed by the injected sleep, 0.5 s doubling', async (t) => {
  const { call, sleeps, desktop } = await startPhoneHub(t)
  await desktop('POST', '/hub/v1/pairing-codes', {})
  for (let i = 0; i < 3; i++) await call('POST', '/hub/v1/pair', { code: 'ZZZZ-ZZZZ' }, serveHeaders({ 'x-forwarded-for': '100.64.3.' + i }))
  assert.deepEqual(sleeps, [500, 1000, 2000])
})

test('pairing is rate limited per address (from X-Forwarded-For): 429 with Retry-After', async (t) => {
  const { call, desktop } = await startPhoneHub(t)
  await desktop('POST', '/hub/v1/pairing-codes', {})
  for (let i = 0; i < 5; i++) await call('POST', '/hub/v1/pair', { code: 'ZZZZ-ZZZZ' }, serveHeaders())
  const r = await call('POST', '/hub/v1/pair', { code: 'ZZZZ-ZZZZ' }, serveHeaders())
  assert.equal(r.status, 429)
  assert.deepEqual(r.json, { error: 'rate-limited' })
  assert.ok(Number(r.headers['retry-after']) >= 1)
  assert.equal((await call('POST', '/hub/v1/pair', { code: 'ZZZZ-ZZZZ' }, serveHeaders({ 'x-forwarded-for': '100.64.9.9' }))).status, 400)
})

test('the pair route needs JSON, a good Host, an allowed Origin, and the tailnet login when logins are configured', async (t) => {
  const { call, port, desktop } = await startPhoneHub(t, { config: { allowedTailnetLogins: ['Me@Example.com'] } })
  const { json } = await desktop('POST', '/hub/v1/pairing-codes', {})
  const body = { code: json.code, name: 'x' }
  assert.equal((await raw({ port, method: 'POST', path: '/hub/v1/pair', headers: serveHeaders({ 'content-type': 'text/plain' }), body: JSON.stringify(body) })).status, 415)
  assert.equal((await call('POST', '/hub/v1/pair', body, serveHeaders({ host: 'evil.example' }))).status, 403)
  assert.deepEqual((await call('POST', '/hub/v1/pair', body, serveHeaders({ origin: 'https://evil.example' }))).json, { error: 'bad-origin' })
  assert.deepEqual((await call('POST', '/hub/v1/pair', body, serveHeaders({ 'tailscale-user-login': 'eve@example.com' }))).json, { error: 'login-not-allowed' })
  assert.deepEqual((await call('POST', '/hub/v1/pair', body, { host: HOST, 'x-forwarded-for': '100.64.0.7' })).json, { error: 'login-not-allowed' }, 'no login header')
  const ok = await call('POST', '/hub/v1/pair', body, serveHeaders({ origin: 'https://' + HOST }))
  assert.equal(ok.status, 200)
})

test('a GET on the pair route is a 405, and a stranger cannot create a code', async (t) => {
  const { call, stranger } = await startPhoneHub(t)
  assert.equal((await call('GET', '/hub/v1/pair')).status, 405)
  assert.equal((await stranger('POST', '/hub/v1/pairing-codes', {})).status, 401)
})

// ---- every role against every route class ------------------------------------------------------------------------------------------

const ROUTES = {
  snapshot: ['GET', P + '/v1/snapshot'],
  reviewed: ['POST', P + '/v1/reviewed', { id: 'nope' }],
  pushKey: ['GET', P + '/v1/push/key'],
  session: ['GET', '/hub/v1/session'],
  devices: ['GET', '/hub/v1/devices'],
  pairingCode: ['POST', '/hub/v1/pairing-codes', {}],
  localRead: ['POST', P + '/v1/read', { id: 'nope' }],
  todo: ['POST', P + '/v1/todo', { text: 'x' }],
  agent: ['POST', '/hub/v1/agent/register', {}],
}

test('role by route class: public, device, desktop and the agent secret each get exactly their routes', async (t) => {
  const h = await startPhoneHub(t)
  const phone = await h.pairPhone()
  const revoked = await h.pairPhone('Old')
  await h.desktop('POST', '/hub/v1/devices/' + revoked.deviceId + '/revoke', {})
  const as = {
    stranger: (...a) => h.stranger(...a),
    'proxied with the agent secret': (m, p, b) => h.stranger(m, p, b, { authorization: 'Bearer ' + SECRET, 'x-rq-role': 'desktop' }),
    device: phone.call,
    'revoked device': revoked.call,
    desktop: (...a) => h.desktop(...a),
  }
  const expected = {
    stranger: { snapshot: 401, reviewed: 401, pushKey: 401, session: 401, devices: 401, pairingCode: 401, localRead: 401, todo: 401, agent: 401 },
    'proxied with the agent secret': { snapshot: 401, reviewed: 401, pushKey: 401, session: 401, devices: 401, pairingCode: 401, localRead: 401, todo: 401, agent: 401 },
    'revoked device': { snapshot: 401, reviewed: 401, pushKey: 401, session: 401, devices: 401, pairingCode: 401, localRead: 401, todo: 401, agent: 401 },
    device: { snapshot: 200, reviewed: 409, pushKey: 200, session: 200, devices: 403, pairingCode: 403, localRead: 403, todo: 409, agent: 401 },
    desktop: { snapshot: 200, reviewed: 409, pushKey: 200, session: 200, devices: 200, pairingCode: 200, localRead: 403, todo: 409, agent: 401 },
  }
  for (const [who, call] of Object.entries(as)) {
    for (const [name, [method, path, body]] of Object.entries(ROUTES)) {
      assert.equal((await call(method, path, body)).status, expected[who][name], who + ' -> ' + name)
    }
  }
})

test('the agent secret from a proxied request is refused on the agent routes too; direct with the secret it is accepted', async (t) => {
  const { stranger, desktop, port } = await startPhoneHub(t)
  assert.equal((await stranger('POST', '/hub/v1/agent/register', {}, { authorization: 'Bearer ' + SECRET })).status, 401)
  const direct = await desktop('POST', '/hub/v1/agent/register', {})
  assert.equal(direct.status, 401)
  const a = agentOf(port)
  assert.notEqual((await a.register({ sync: sync() })).status, 401)
})

test('public routes need no credential: health, assetlinks, the app files', async (t) => {
  const { stranger } = await startPhoneHub(t)
  for (const path of ['/hub/v1/health', '/.well-known/assetlinks.json', P + '/m/', P + '/m/api.js']) assert.equal((await stranger('GET', path)).status, 200, path)
})

test('DNS rebinding: a foreign Host name is refused on every route class, with or without a valid token', async (t) => {
  const { stranger, pairPhone } = await startPhoneHub(t)
  const p = await pairPhone()
  for (const host of ['evil.example', 'rq.example.ts.net.evil.example', '127.0.0.1', 'localhost:1']) {
    for (const [method, path] of [['GET', P + '/v1/snapshot'], ['GET', '/hub/v1/session'], ['POST', '/hub/v1/pair'], ['POST', '/hub/v1/pairing-codes'], ['GET', '/hub/v1/devices']]) {
      const res = await stranger(method, path, method === 'POST' ? {} : undefined, { host, authorization: 'Bearer ' + p.token })
      assert.equal(res.status, 403, host + ' ' + path)
    }
  }
})

test('every state-changing call checks Origin: a foreign one is refused for devices, pairing codes, push and actions', async (t) => {
  const { pairPhone, call } = await startPhoneHub(t)
  const p = await pairPhone()
  const evil = serveHeaders({ authorization: 'Bearer ' + p.token, origin: 'https://evil.example' })
  for (const [path, body] of [[P + '/v1/push/subscribe', {}], [P + '/v1/reviewed', { id: 'x' }]]) assert.deepEqual((await call('POST', path, body, evil)).json, { error: 'bad-origin' }, path)
  assert.deepEqual((await call('POST', '/hub/v1/pairing-codes', {}, { origin: 'https://evil.example' })).json, { error: 'bad-origin' })
  assert.deepEqual((await call('POST', '/hub/v1/devices/dv_000000000000/revoke', {}, { origin: 'https://evil.example' })).json, { error: 'bad-origin' })
})

test('state-changing calls need Content-Type application/json (415), and the body is capped at 64 KB (413)', async (t) => {
  const { pairPhone, port } = await startPhoneHub(t)
  const p = await pairPhone()
  const headers = serveHeaders({ authorization: 'Bearer ' + p.token })
  assert.equal((await raw({ port, method: 'POST', path: P + '/v1/reviewed', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' })).status, 415)
  assert.equal((await p.call('POST', P + '/v1/reviewed', { id: 'x', pad: 'y'.repeat(70_000) })).status, 413)
})

test('allowedTailnetLogins: a device request from another login is refused, from the listed one it works', async (t) => {
  const h = await startPhoneHub(t, { config: { allowedTailnetLogins: [LOGIN] } })
  const p = await h.pairPhone()
  assert.equal((await p.call('GET', P + '/v1/snapshot')).status, 200)
  const other = await p.call('GET', P + '/v1/snapshot', undefined, { 'tailscale-user-login': 'eve@example.com' })
  assert.deepEqual([other.status, other.json], [403, { error: 'login-not-allowed' }])
  assert.equal((await h.desktop('GET', P + '/v1/snapshot')).status, 200, 'the desktop is not subject to it')
})

// ---- revoke --------------------------------------------------------------------------------------------------------------------------

test('revoke: the next request of the phone is a 401 auth-required and its push subscription is gone', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } }
  assert.equal((await p.call('POST', P + '/v1/push/subscribe', { subscription: sub, name: 'Pixel' })).status, 200)
  assert.equal(h.hub.push.devices().length, 1)
  const res = await h.desktop('POST', '/hub/v1/devices/' + p.deviceId + '/revoke', {})
  assert.equal(res.status, 200)
  assert.ok(res.json.device.revokedAt > 0)
  const after = await p.call('GET', P + '/v1/snapshot')
  assert.deepEqual([after.status, after.json], [401, { error: 'auth-required' }])
  assert.equal(h.hub.push.devices().length, 0)
})

test('revoke aborts the phone\'s pending snapshot long poll with a 401', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  const firstRes = await p.call('GET', P + '/v1/snapshot')
  assert.equal(firstRes.status, 200)
  const pending = p.call('GET', P + '/v1/snapshot?wait=20000&since=' + encodeURIComponent(firstRes.json.snapshotId + '|||0'))
  let settled = false
  pending.then(() => { settled = true })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(settled, false, 'the long poll is really waiting before the revoke')
  const started = Date.now()
  await h.desktop('POST', '/hub/v1/devices/' + p.deviceId + '/revoke', {})
  const res = await pending
  assert.equal(res.status, 401)
  assert.ok(Date.now() - started < 3000, 'answered at once, not after the wait')
})

test('revoke of an unknown device is 404, rename needs a name and works on the desktop only', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  assert.equal((await h.desktop('POST', '/hub/v1/devices/dv_000000000000/revoke', {})).status, 404)
  assert.equal((await h.desktop('PATCH', '/hub/v1/devices/' + p.deviceId, { name: '  ' })).status, 400)
  const ok = await h.desktop('PATCH', '/hub/v1/devices/' + p.deviceId, { name: 'Tablet' })
  assert.equal(ok.json.device.name, 'Tablet')
  assert.equal((await p.call('PATCH', '/hub/v1/devices/' + p.deviceId, { name: 'Mine' })).status, 403)
  assert.equal((await p.call('POST', '/hub/v1/devices/' + p.deviceId + '/revoke', {})).status, 403)
})

test('a device that was revoked cannot pair again with its old token, and the session endpoint says who is calling', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone('Pixel')
  const me = (await p.call('GET', '/hub/v1/session')).json
  assert.deepEqual([me.ok, me.role, me.deviceId, me.name], [true, 'device', p.deviceId, 'Pixel'])
  assert.deepEqual([(await h.desktop('GET', '/hub/v1/session')).json.role], ['desktop'])
})

// ---- per-device rate limit ---------------------------------------------------------------------------------------------------------

test('a device may make 120 requests a minute; the long-poll form of the snapshot does not count', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  for (let i = 0; i < 200; i++) assert.equal((await p.call('GET', P + '/v1/snapshot?wait=100&since=x')).status, 200, 'long poll ' + i)
  for (let i = 0; i < 120; i++) assert.equal((await p.call('GET', '/hub/v1/session')).status, 200, 'request ' + i)
  const limited = await p.call('GET', '/hub/v1/session')
  assert.equal(limited.status, 429)
  assert.deepEqual(limited.json, { error: 'rate-limited' })
  assert.ok(Number(limited.headers['retry-after']) >= 1)
  h.clock.advance(61_000)
  assert.equal((await p.call('GET', '/hub/v1/session')).status, 200)
  const other = await h.pairPhone('Second')
  assert.equal((await other.call('GET', '/hub/v1/session')).status, 200, 'another device has its own budget')
})

// ---- D8 end to end, through real device authentication -----------------------------------------------------------------------------

async function withAgent(t) {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, permission()), a.add(2, risky()), a.add(3, { type: 'completed' }))
  const p = await h.pairPhone()
  /** One phone action, answered by the agent when it receives a command. */
  const viaAgent = async (kind, body, result = { ok: true }) => {
    const pending = p.call('POST', P + '/v1/' + kind, body)
    const got = await a.poll(0, 3000)
    const cmd = got.json.commands[0]
    if (cmd) await a.result(cmd.cid, result)
    return { res: await pending, cmd }
  }
  const nothingQueued = async () => assert.deepEqual((await a.poll(0, 0)).json.commands, [])
  return { h, a, p, viaAgent, nothingQueued }
}

test('phone approve without confirmed is 400 needs-confirm and nothing is sent to the app', async (t) => {
  const { a, p, nothingQueued } = await withAgent(t)
  const res = await p.call('POST', P + '/v1/approve', { id: a.itemId(1) })
  assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'needs-confirm' }])
  assert.equal((await p.call('POST', P + '/v1/approve', { id: a.itemId(1), confirmed: 'true' })).status, 400)
  await nothingQueued()
})

test('a risky approve from the phone needs the hold as well (400 needs-hold)', async (t) => {
  const { a, p, nothingQueued, viaAgent } = await withAgent(t)
  const res = await p.call('POST', P + '/v1/approve', { id: a.itemId(2), confirmed: true })
  assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'needs-hold' }])
  await nothingQueued()
  const ok = await viaAgent('approve', { id: a.itemId(2), confirmed: true, held: true, via: 'desktop' })
  assert.equal(ok.res.status, 200)
  assert.deepEqual(ok.cmd.args, { via: 'phone', confirmed: true, held: true }, 'via comes from the credential, not the body')
})

test('approve-similar on a risky item is a 409 risky from the phone, and a safe one needs the confirm sheet', async (t) => {
  const { a, p, nothingQueued } = await withAgent(t)
  assert.deepEqual((await p.call('POST', P + '/v1/approve-similar', { id: a.itemId(1) })).json, { ok: false, error: 'needs-confirm' })
  const risk = await p.call('POST', P + '/v1/approve-similar', { id: a.itemId(2), confirmed: true, held: true })
  assert.deepEqual([risk.status, risk.json], [409, { ok: false, error: 'risky' }])
  await nothingQueued()
})

test('the phone can deny, answer, reply, archive and mark reviewed; the owner app receives each as its own command', async (t) => {
  const { a, viaAgent, p } = await withAgent(t)
  assert.equal((await viaAgent('deny', { id: a.itemId(1) })).cmd.kind, 'deny')
  assert.equal((await viaAgent('reply', { id: a.itemId(3), text: 'go on' })).cmd.kind, 'reply')
  assert.equal((await p.call('POST', P + '/v1/reviewed', { id: a.itemId(3) })).status, 200)
})

test('a phone can start todos (todo, todo-confirm, todo-cancel pass the role check) but cannot open sessions: open-session is desktop only (403)', async (t) => {
  const p = await (await startPhoneHub(t)).pairPhone() // no app online, so nothing waits for an answer
  for (const kind of ['todo', 'todo-confirm', 'todo-cancel']) {
    const res = await p.call('POST', P + '/v1/' + kind, { id: 'x', text: 'y' })
    assert.notEqual(res.status, 403, kind + ' is not refused for a phone')
  }
  const res = await p.call('POST', P + '/v1/open-session', { id: 'x', text: 'y' })
  assert.deepEqual([res.status, res.json], [403, { error: 'desktop-only' }], 'open-session')
})

// ---- file permissions flag -----------------------------------------------------------------------------------------------------------

test('when the permissions of devices.json cannot be tightened the devices list says so, and icacls was asked for that file', async (t) => {
  const calls = []
  const hardener = createHardener({ platform: 'win32', user: 'PC\\me', run: (cmd, args) => { calls.push(args); return { status: 5 } }, log: () => {} })
  const h = await startPhoneHub(t, { hardener })
  await h.pairPhone()
  const list = (await h.desktop('GET', '/hub/v1/devices')).json
  assert.deepEqual(list.warnings, ['permissions could not be tightened'])
  assert.ok(calls.some((args) => /devices\.json/.test(args[0]) && args[1] === '/inheritance:r' && args[3] === 'PC\\me:(R,W)'))
})

test('with the permissions in order there is no warning', async (t) => {
  const h = await startPhoneHub(t)
  await h.pairPhone()
  assert.deepEqual((await h.desktop('GET', '/hub/v1/devices')).json.warnings, [])
})
