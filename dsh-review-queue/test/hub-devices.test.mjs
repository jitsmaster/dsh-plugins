import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createDevices, DEVICE_IDLE_MS, TOKEN_PATTERN } from '../hub/devices.js'
import { fakeClock, memIo } from './hub-helpers.mjs'

const sha = (text) => createHash('sha256').update(text).digest('hex')

function setup(over = {}) {
  const clock = over.clock ?? fakeClock()
  const io = over.io ?? memIo()
  const revoked = []
  const logs = []
  const devices = createDevices({ io, now: clock.now, timers: clock, log: (l) => logs.push(l), onRevoke: (id) => revoked.push(id), ...over.deps })
  return { devices, clock, io, revoked, logs }
}
const pair = (devices, name = 'Pixel', login = 'me@example.com') => devices.create({ name, login })

test('a new device gets an id, a token that is shown once, and its record keeps only the SHA-256 of that token', () => {
  const { devices, io, clock } = setup()
  const r = pair(devices)
  assert.equal(r.ok, true)
  assert.match(r.token, TOKEN_PATTERN)
  assert.match(r.token, /^rqd_[A-Za-z0-9_-]{43}$/)
  assert.match(r.device.id, /^dv_[0-9a-f]{12}$/)
  assert.deepEqual(Object.keys(r.device).sort(), ['createdAt', 'id', 'lastLogin', 'lastSeenAt', 'name', 'revokedAt'])
  assert.equal(r.device.name, 'Pixel')
  assert.equal(r.device.lastLogin, 'me@example.com')
  assert.equal(r.device.createdAt, clock.now())
  assert.equal(r.device.revokedAt, null)
  const text = io.files.main
  assert.ok(!text.includes(r.token), 'the token is never written')
  assert.ok(text.includes(sha(r.token)), 'its hash is')
  assert.ok(!JSON.stringify(devices.list()).includes(sha(r.token)), 'the list never shows the hash')
})

test('two devices get different tokens and ids; the token is 256 random bits', () => {
  const { devices } = setup()
  const a = pair(devices); const b = pair(devices)
  assert.notEqual(a.token, b.token)
  assert.notEqual(a.device.id, b.device.id)
})

test('names are trimmed, stripped of control characters, cut to 40 characters, and default to Phone', () => {
  const { devices } = setup()
  assert.equal(pair(devices, '  My\u0000 Pixel\n ').device.name, 'My Pixel')
  assert.equal(pair(devices, 'x'.repeat(100)).device.name.length, 40)
  assert.equal(pair(devices, '').device.name, 'Phone')
  assert.equal(pair(devices, 42).device.name, 'Phone')
})

test('the login header is stored as text, cut, or null when absent', () => {
  const { devices } = setup()
  assert.equal(devices.create({ name: 'a' }).device.lastLogin, null)
  assert.equal(pair(devices, 'a', 'x'.repeat(500)).device.lastLogin.length, 200)
})

test('authenticate: the token finds its device; a wrong, malformed or missing token does not', () => {
  const { devices } = setup()
  const { token, device } = pair(devices)
  assert.deepEqual(devices.authenticate(token), { ok: true, device: { id: device.id, name: 'Pixel' } })
  for (const bad of ['rqd_' + 'A'.repeat(43), token.slice(0, -1), token + 'x', 'Bearer ' + token, '', undefined, 42, sha(token)]) {
    assert.deepEqual(devices.authenticate(bad), { ok: false, error: 'auth-required' }, String(bad))
  }
})

test('a revoked device is refused with the same answer as an unknown one, its push is dropped through onRevoke, and the revoke is saved', () => {
  const { devices, revoked, io, clock } = setup()
  const { token, device } = pair(devices)
  const r = devices.revoke(device.id)
  assert.equal(r.ok, true)
  assert.equal(r.device.revokedAt, clock.now())
  assert.deepEqual(revoked, [device.id])
  assert.deepEqual(devices.authenticate(token), { ok: false, error: 'auth-required' })
  assert.equal(devices.isActive(device.id), false)
  assert.equal(JSON.parse(io.files.main).devices[0].revokedAt, clock.now())
  assert.equal(devices.revoke(device.id).ok, true, 'revoking twice is fine')
  assert.deepEqual(revoked, [device.id], 'the cleanup runs once')
  assert.deepEqual(devices.revoke('dv_unknown'), { ok: false, error: 'unknown-device' })
})

test('a device idle for more than 180 days is refused; one used within that time is not', () => {
  const { devices, clock } = setup()
  const { token } = pair(devices)
  clock.advance(DEVICE_IDLE_MS - 1000)
  assert.equal(devices.authenticate(token).ok, true)
  clock.advance(DEVICE_IDLE_MS + 1000)
  assert.deepEqual(devices.authenticate(token), { ok: false, error: 'auth-required' })
})

test('lastSeenAt moves at most once a minute, and the file is written shortly after, not on the request', () => {
  const { devices, clock, io } = setup({ deps: {} })
  const { token, device } = pair(devices)
  const writes = io.writes.length
  clock.advance(10_000); devices.authenticate(token)
  clock.advance(10_000); devices.authenticate(token)
  clock.advance(5000)
  assert.equal(io.writes.length, writes, 'no write inside the minute')
  assert.equal(devices.list()[0].lastSeenAt, device.createdAt)
  clock.advance(60_000); devices.authenticate(token)
  const seen = clock.now()
  assert.equal(devices.list()[0].lastSeenAt, seen)
  assert.equal(io.writes.length, writes, 'not on the request itself')
  clock.advance(3000)
  assert.equal(io.writes.length, writes + 1)
  assert.equal(JSON.parse(io.files.main).devices[0].lastSeenAt, seen)
})

test('flush writes a pending lastSeenAt at once (shutdown)', () => {
  const { devices, clock, io } = setup()
  const { token } = pair(devices)
  const writes = io.writes.length
  clock.advance(120_000); devices.authenticate(token)
  devices.flush()
  assert.equal(io.writes.length, writes + 1)
})

test('rename: the desktop can rename a device; an empty or non-text name is refused', () => {
  const { devices, io } = setup()
  const { device } = pair(devices)
  assert.equal(devices.rename(device.id, '  Tablet ').device.name, 'Tablet')
  assert.equal(JSON.parse(io.files.main).devices[0].name, 'Tablet')
  assert.deepEqual(devices.rename(device.id, '   '), { ok: false, error: 'bad-name' })
  assert.deepEqual(devices.rename(device.id, 7), { ok: false, error: 'bad-name' })
  assert.deepEqual(devices.rename('dv_nope', 'x'), { ok: false, error: 'unknown-device' })
})

test('the devices survive a restart (hash, name, revoke), and a damaged main file falls back to the last good copy', () => {
  const { devices, io, clock } = setup()
  const a = pair(devices, 'A'); const b = pair(devices, 'B')
  devices.revoke(b.device.id)
  const again = createDevices({ io, now: clock.now, log: () => {} })
  assert.equal(again.authenticate(a.token).ok, true)
  assert.equal(again.authenticate(b.token).ok, false)
  assert.equal(again.list().length, 2)
  io.files.bak = io.files.main
  io.files.main = '{not json'
  const recovered = createDevices({ io, now: clock.now, log: () => {} })
  assert.equal(recovered.authenticate(a.token).ok, true)
})

test('records with a bad shape are skipped on load instead of breaking the file', () => {
  const io = memIo({ main: JSON.stringify({ v: 1, devices: [{ id: 'dv_000000000001', name: 'ok', tokenHash: sha('t'), createdAt: 1, lastSeenAt: 1, lastLogin: null, revokedAt: null }, { id: 5 }, { id: 'dv_x', tokenHash: 'short' }, null] }) })
  const { devices } = setup({ io })
  assert.deepEqual(devices.list().map((d) => d.id), ['dv_000000000001'])
})

test('a file that cannot be written means no device: no token is returned and nothing stays in memory', () => {
  const io = memIo(); io.failNext = 1
  const { devices, logs } = setup({ io })
  assert.deepEqual(pair(devices), { ok: false, error: 'persist-failed' })
  assert.equal(devices.list().length, 0)
  assert.ok(logs.some((l) => /devices file not written/.test(l)))
})

test('a revoke that cannot be saved still takes effect in memory (the device must not stay usable) and is retried with the next write', () => {
  const { devices, io } = setup()
  const { token, device } = pair(devices)
  io.failNext = 1
  assert.equal(devices.revoke(device.id).ok, true)
  assert.equal(devices.authenticate(token).ok, false)
  pair(devices, 'next')
  assert.equal(JSON.parse(io.files.main).devices.find((d) => d.id === device.id).revokedAt !== null, true)
})

test('at most 20 active devices; revoked ones do not count', () => {
  const { devices } = setup()
  const made = Array.from({ length: 20 }, (_, i) => pair(devices, 'd' + i))
  assert.deepEqual(pair(devices), { ok: false, error: 'too-many-devices' })
  devices.revoke(made[0].device.id)
  assert.equal(pair(devices).ok, true)
})

test('get and list never carry the token hash', () => {
  const { devices } = setup()
  const { device, token } = pair(devices)
  for (const view of [devices.get(device.id), devices.list()[0]]) {
    assert.ok(!('tokenHash' in view))
    assert.ok(!JSON.stringify(view).includes(sha(token)))
  }
  assert.equal(devices.get('dv_nope'), undefined)
})
