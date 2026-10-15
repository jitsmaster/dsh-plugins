import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDevices } from '../hub/devices.js'
import { clientIp, createRoles } from '../hub/roles.js'
import { fakeClock, memIo } from './hub-helpers.mjs'

const SECRET = 'S'.repeat(43)
const PORT = 47615

function setup(config = {}) {
  const clock = fakeClock()
  const devices = createDevices({ io: memIo(), now: clock.now, timers: clock, log: () => {} })
  const roles = createRoles({ devices, port: () => PORT, config: () => ({ allowedTailnetLogins: [], publicHost: 'awang-lpt2.ts.net', ...config }) })
  const { token, device } = devices.create({ name: 'Pixel' })
  /** A request as node gives it: lower-case header names, the peer in socket. */
  const req = (headers = {}, peer = '127.0.0.1') => ({ headers: { host: '127.0.0.1:' + PORT, ...headers }, socket: { remoteAddress: peer } })
  return { roles, devices, token, device, req, clock }
}
const bearer = (t) => ({ authorization: 'Bearer ' + t })
const SERVE = { 'x-forwarded-for': '100.101.102.103', 'tailscale-user-login': 'me@example.com', host: 'awang-lpt2.ts.net' }

test('a plain loopback request is the desktop (as in H1); with the agent secret and X-RQ-Role it is the desktop too', () => {
  const { roles, req } = setup()
  assert.deepEqual(roles.identify(req()), { role: 'desktop' })
  assert.deepEqual(roles.identify(req({ ...bearer(SECRET), 'x-rq-role': 'desktop' })), { role: 'desktop' })
  assert.deepEqual(roles.identify(req({ host: 'localhost:' + PORT })), { role: 'desktop' })
})

test('a request that came through tailscale serve never gets the desktop role, not even with the agent secret and the role header', () => {
  const { roles, req } = setup()
  for (const via of [{ 'x-forwarded-for': '100.1.1.1' }, { forwarded: 'for=100.1.1.1' }, { 'tailscale-user-login': 'me@example.com' }, SERVE]) {
    assert.equal(roles.identify(req({ ...via })).role, undefined, JSON.stringify(via))
    assert.equal(roles.identify(req({ ...via, ...bearer(SECRET), 'x-rq-role': 'desktop' })).role, undefined, JSON.stringify(via) + ' + secret')
  }
})

test('a request for the public host name is not the desktop either, even without proxy headers', () => {
  const { roles, req } = setup()
  assert.equal(roles.identify(req({ host: 'awang-lpt2.ts.net', ...bearer(SECRET), 'x-rq-role': 'desktop' })).role, undefined)
})

test('a peer that is not the loopback address never has a role from the secret or the loopback rule', () => {
  const { roles, req, token } = setup()
  assert.equal(roles.identify(req({}, '192.168.1.5')).role, undefined)
  assert.equal(roles.identify(req({ ...bearer(SECRET), 'x-rq-role': 'desktop' }, '100.64.0.1')).role, undefined)
  assert.equal(roles.identify(req(bearer(token), '::1')).role, 'device', 'IPv6 loopback counts as loopback')
})

test('a device token gives the device role and the device id, through the proxy or directly', () => {
  const { roles, req, token, device } = setup()
  assert.deepEqual(roles.identify(req({ ...SERVE, ...bearer(token) })), { role: 'device', deviceId: device.id, login: 'me@example.com' })
  assert.deepEqual(roles.identify(req(bearer(token))), { role: 'device', deviceId: device.id, login: undefined })
})

test('a bad, unknown or revoked device token has no role and says auth-required; it is not rescued by the loopback rule', () => {
  const { roles, req, token, device, devices } = setup()
  assert.deepEqual(roles.identify(req(bearer('rqd_' + 'A'.repeat(43)))), { error: 'auth-required' })
  devices.revoke(device.id)
  assert.deepEqual(roles.identify(req({ ...SERVE, ...bearer(token) })), { error: 'auth-required' })
})

test('the agent secret is not a device token and a device token is not the agent secret', () => {
  const { roles, req, token } = setup()
  assert.equal(roles.identify(req({ ...SERVE, ...bearer(SECRET) })).role, undefined)
  assert.equal(roles.identify(req({ ...bearer(token), 'x-rq-role': 'desktop' })).role, 'device', 'the role header does not upgrade a device')
})

test('allowedTailnetLogins: a device request needs the login header (set by tailscale serve) to be on the list, ignoring case', () => {
  const { roles, req, token } = setup({ allowedTailnetLogins: ['Me@Example.com'] })
  assert.equal(roles.identify(req({ ...SERVE, ...bearer(token) })).role, 'device')
  assert.deepEqual(roles.identify(req({ ...SERVE, 'tailscale-user-login': 'eve@example.com', ...bearer(token) })), { error: 'login-not-allowed' })
  assert.deepEqual(roles.identify(req({ 'x-forwarded-for': '100.1.1.1', ...bearer(token) })), { error: 'login-not-allowed' }, 'no login at all')
  assert.deepEqual(roles.identify(req(bearer(token))), { error: 'login-not-allowed' }, 'a direct loopback call has no login either')
})

test('allowedTailnetLogins does not lock the desktop out', () => {
  const { roles, req } = setup({ allowedTailnetLogins: ['me@example.com'] })
  assert.equal(roles.identify(req()).role, 'desktop')
})

test('loginAllowed is what the public pair route asks: open without a list, strict with one', () => {
  const open = setup()
  assert.equal(open.roles.loginAllowed(open.req(SERVE)), true)
  const strict = setup({ allowedTailnetLogins: ['me@example.com'] })
  assert.equal(strict.roles.loginAllowed(strict.req(SERVE)), true)
  assert.equal(strict.roles.loginAllowed(strict.req({ 'tailscale-user-login': 'x@y.z' })), false)
  assert.equal(strict.roles.loginAllowed(strict.req()), false)
})

test('clientIp: the last X-Forwarded-For entry (the one the proxy added) when the peer is loopback, else the peer address', () => {
  const r = (headers, peer) => ({ headers, socket: { remoteAddress: peer } })
  assert.equal(clientIp(r({ 'x-forwarded-for': '6.6.6.6, 100.64.0.7' }, '127.0.0.1')), '100.64.0.7')
  assert.equal(clientIp(r({ 'x-forwarded-for': '100.64.0.7' }, '127.0.0.1')), '100.64.0.7')
  assert.equal(clientIp(r({}, '127.0.0.1')), '127.0.0.1')
  assert.equal(clientIp(r({ 'x-forwarded-for': '6.6.6.6' }, '192.168.1.9')), '192.168.1.9', 'a header from a stranger is ignored')
  assert.equal(clientIp(r({ 'x-forwarded-for': '  ' }, '::ffff:127.0.0.1')), '::ffff:127.0.0.1')
})
