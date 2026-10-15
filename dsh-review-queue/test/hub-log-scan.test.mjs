import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHub } from '../hub/hub.js'
import { b64u } from '../hub/webpush.js'
import { agentOf, sync } from './hub-agent-helpers.mjs'
import { fakeClock, postJson, raw, tmpDir } from './hub-helpers.mjs'
import { HOST, P, SECRET, noAcl, serveHeaders } from './hub-device-helpers.mjs'

// Design 9.6: no tokens, pairing codes, secrets, push endpoints, command text, replies or titles in the hub's log; device ids and counts only.
// One full run (pairing with wrong guesses, push, approve, revoke, errors) on a hub that writes its real hub.log, then the file is searched.
test('the hub log of a full pairing, push, approve and revoke run holds none of the secrets', async (t) => {
  const dir = tmpDir(t)
  writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ publicUrl: 'https://' + HOST }))
  const clock = fakeClock()
  const e = createECDH('prime256v1'); e.generateKeys()
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT-TOKEN', keys: { p256dh: b64u(e.getPublicKey()), auth: b64u(randomBytes(16)) } }
  const sent = []
  const hub = createHub({ stateDir: dir, port: 0, tickMs: 0, secret: SECRET, now: clock.now, hardener: noAcl, sleep: async () => {}, timers: clock, sendPush: async (s, payload) => { sent.push(payload); return { ok: true, status: 201, gone: false } } })
  await hub.start()
  const port = hub.port
  try {
    const call = (method, path, body, headers = {}) => (method === 'GET' ? raw({ port, path, headers }) : postJson(port, path, body ?? {}, headers))
    const { json: made } = await call('POST', '/hub/v1/pairing-codes', {})
    const code = made.code
    for (let i = 0; i < 2; i++) await call('POST', '/hub/v1/pair', { code: 'WRNG-WRNG', name: 'x' }, serveHeaders({ 'x-forwarded-for': '100.64.5.' + i }))
    const paired = (await call('POST', '/hub/v1/pair', { code, name: 'Secret Pixel Name' }, serveHeaders())).json
    const phone = (method, path, body) => call(method, path, body, serveHeaders({ authorization: 'Bearer ' + paired.token }))
    await phone('POST', P + '/v1/push/subscribe', { subscription, name: 'Secret Pixel Name' })
    const a = agentOf(port)
    await a.register({ sync: sync() })
    await a.send(a.add(1, { type: 'permission', sessionTitle: 'SECRET-SESSION-TITLE', workspace: 'D:/secret-workspace', payload: { toolName: 'shell', summary: 'SECRET-COMMAND', detail: 'SECRET-COMMAND --force' } }))
    clock.advance(500); await new Promise((r) => setImmediate(r))
    const approving = phone('POST', P + '/v1/approve', { id: a.itemId(1), confirmed: true, held: true })
    const cmd = (await a.poll(0, 3000)).json.commands[0]
    await a.result(cmd.cid, { ok: true })
    await approving
    await phone('POST', P + '/v1/reply', { id: a.itemId(2), text: 'SECRET-REPLY-TEXT' })
    await phone('GET', P + '/v1/snapshot?since=garbage&wait=0')
    await call('POST', '/hub/v1/pair', '{broken json', serveHeaders({ 'x-forwarded-for': '100.64.6.6' }))
    await call('POST', '/hub/v1/devices/' + paired.deviceId + '/revoke', {})
    await phone('GET', P + '/v1/snapshot')
    assert.equal(sent.length >= 1, true, 'a push really went out in this run')
    assert.ok(!JSON.stringify(sent).includes('SECRET'), 'and carried no secret')
    await hub.stop()
    const log = readFileSync(join(dir, 'hub', 'hub.log'), 'utf8')
    assert.ok(log.includes(paired.deviceId), 'the device id is what the log names')
    for (const line of [/pairing code created/, /pairing code invalidated|device paired/, /push permission \(1 item\): sent/, /device revoked \(dv_[0-9a-f]{12}\), 1 push subscription/]) assert.match(log, line)
    const forbidden = [SECRET, paired.token, paired.token.slice(4), code, code.replace('-', ''), subscription.endpoint, 'SECRET-ENDPOINT-TOKEN', subscription.keys.p256dh, subscription.keys.auth, 'Secret Pixel Name', 'SECRET-SESSION-TITLE', 'SECRET-COMMAND', 'SECRET-REPLY-TEXT', 'secret-workspace', 'WRNG-WRNG']
    for (const word of forbidden) assert.ok(!log.includes(word), 'the log must not contain ' + word.slice(0, 12))
    const files = ['devices.json', 'vapid.json', 'push.json'].map((n) => { try { return readFileSync(join(dir, 'hub', n), 'utf8') } catch { return '' } }).join('')
    assert.ok(!files.includes(paired.token), 'devices.json keeps only the hash')
    assert.ok(!files.includes(code), 'and no pairing code')
  } finally { await hub.stop() }
})
