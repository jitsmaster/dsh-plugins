import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDevices } from '../hub/devices.js'
import { createPairing, CODE_ALPHABET, normalizeCode } from '../hub/pairing.js'
import { fakeClock, memIo } from './hub-helpers.mjs'

function setup(over = {}) {
  const clock = fakeClock()
  const sleeps = []
  const logs = []
  const devices = createDevices({ io: memIo(), now: clock.now, timers: clock, log: () => {} })
  const pairing = createPairing({ devices, now: clock.now, sleep: async (ms) => { sleeps.push(ms) }, log: (l) => logs.push(l), ...over })
  let ip = 0
  /** Every call from another address unless one is given, so the per-address limit does not hide the other rules. */
  const attempt = (code, extra = {}) => pairing.pair({ code, name: 'Pixel', ip: extra.ip ?? '100.64.0.' + ++ip, login: 'me@example.com', ...extra })
  return { pairing, devices, clock, sleeps, logs, attempt }
}
const wrong = (code) => (code[0] === 'A' ? 'B' : 'A') + code.slice(1)

test('a code is 8 Crockford base32 characters (40 bits), shown as two groups of four, valid for 5 minutes', () => {
  const { pairing, clock } = setup()
  const r = pairing.createCode()
  assert.match(r.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  assert.equal(r.expiresAt, clock.now() + 5 * 60_000)
  assert.equal(CODE_ALPHABET.length, 32)
  assert.doesNotMatch(CODE_ALPHABET, /[ILOU]/)
})

test('codes are random: ten codes are all different', () => {
  const { pairing } = setup()
  assert.equal(new Set(Array.from({ length: 10 }, () => pairing.createCode().code)).size, 10)
})

test('normalizeCode: case, spaces and hyphens do not matter, and the look-alike letters mean what Crockford says', () => {
  assert.equal(normalizeCode(' ab-cd ef gh '), 'ABCDEFGH')
  assert.equal(normalizeCode('O0Il1L'), '001111')
  assert.equal(normalizeCode(42), '')
})

test('the right code pairs the phone: a device and its token come back, with the name', async () => {
  const { pairing, devices, attempt } = setup()
  const { code } = pairing.createCode()
  const r = await attempt(code.toLowerCase().replace('-', ' '))
  assert.equal(r.ok, true)
  assert.match(r.token, /^rqd_/)
  assert.equal(r.name, 'Pixel')
  assert.equal(devices.authenticate(r.token).device.id, r.deviceId)
  assert.equal(devices.get(r.deviceId).lastLogin, 'me@example.com')
})

test('a code works once: the second use, wrong or right alike, is the same bad-code answer', async () => {
  const { pairing, attempt } = setup()
  const { code } = pairing.createCode()
  assert.equal((await attempt(code)).ok, true)
  assert.deepEqual(await attempt(code), { ok: false, status: 400, error: 'bad-code' })
})

test('an expired code, a wrong code and no code at all get the same answer', async () => {
  const { pairing, clock, attempt } = setup()
  assert.deepEqual(await attempt('ABCD-EFGH'), { ok: false, status: 400, error: 'bad-code' }, 'no active code')
  const { code } = pairing.createCode()
  assert.deepEqual(await attempt(wrong(code)), { ok: false, status: 400, error: 'bad-code' })
  clock.advance(5 * 60_000 + 1)
  assert.deepEqual(await attempt(code), { ok: false, status: 400, error: 'bad-code' }, 'expired')
  assert.deepEqual(await attempt(42), { ok: false, status: 400, error: 'bad-code' }, 'not even text')
})

test('only one code is active: a new code kills the old one', async () => {
  const { pairing, attempt } = setup()
  const first = pairing.createCode().code
  const second = pairing.createCode().code
  assert.deepEqual(await attempt(first), { ok: false, status: 400, error: 'bad-code' })
  assert.equal((await attempt(second)).ok, true)
})

test('a wrong answer is delayed 0.5 s, then 1, 2, 4, 8 s and never more than 8 s; a right answer is not delayed', async () => {
  const { pairing, sleeps, attempt } = setup({ limits: { global: 1000 } })
  const { code } = pairing.createCode()
  for (let i = 0; i < 4; i++) await attempt(wrong(code))
  assert.deepEqual(sleeps, [500, 1000, 2000, 4000])
  assert.equal((await attempt(code)).ok, true)
  assert.deepEqual(sleeps, [500, 1000, 2000, 4000], 'success does not sleep')
  pairing.createCode()
  for (let i = 0; i < 7; i++) await attempt('ZZZZ-ZZZZ')
  assert.deepEqual(sleeps.slice(4), [500, 1000, 2000, 4000, 8000, 8000, 8000], 'the delay starts again after a success and is capped')
})

test('the 5th wrong guess invalidates the code: the 6th, even with the right code, never succeeds', async () => {
  const { pairing, devices, attempt, logs } = setup()
  const { code } = pairing.createCode()
  for (let i = 0; i < 5; i++) assert.equal((await attempt(wrong(code))).ok, false)
  assert.deepEqual(await attempt(code), { ok: false, status: 400, error: 'bad-code' })
  assert.equal(devices.list().length, 0)
  assert.ok(logs.some((l) => /code invalidated/.test(l)))
})

test('four wrong guesses and then the right code still pairs', async () => {
  const { pairing, attempt } = setup()
  const { code } = pairing.createCode()
  for (let i = 0; i < 4; i++) await attempt(wrong(code))
  assert.equal((await attempt(code)).ok, true)
})

test('rate limit by address: the 6th try of one address within a minute is a 429 with Retry-After, and it is not counted as a wrong guess', async () => {
  const { pairing, attempt } = setup()
  const { code } = pairing.createCode()
  for (let i = 0; i < 4; i++) await attempt(wrong(code), { ip: '100.64.1.1' })
  assert.equal((await attempt(wrong(code), { ip: '100.64.1.1' })).ok, false)
  const limited = await attempt(code, { ip: '100.64.1.1' })
  assert.equal(limited.status, 429)
  assert.equal(limited.error, 'rate-limited')
  assert.ok(limited.retryAfterMs > 0)
  assert.equal((await attempt(wrong(code), { ip: '100.64.1.2' })).status, 400, 'another address is not limited by it')
})

test('global limit: 10 tries a minute across all addresses; then even the right code from a fresh address is refused', async () => {
  const { pairing, clock, attempt } = setup({ limits: { tries: 100 } })
  const { code } = pairing.createCode()
  for (let i = 0; i < 10; i++) assert.equal((await attempt(wrong(code))).status, 400)
  assert.equal((await attempt(code)).status, 429)
  clock.advance(61_000)
  assert.equal((await attempt(code)).ok, true, 'a minute later it works again')
})

test('a rate-limited try does not sleep (it costs the server nothing)', async () => {
  const { pairing, sleeps, attempt } = setup()
  pairing.createCode()
  for (let i = 0; i < 5; i++) await attempt('ZZZZ-ZZZZ', { ip: '100.64.9.9' })
  const before = sleeps.length
  await attempt('ZZZZ-ZZZZ', { ip: '100.64.9.9' })
  assert.equal(sleeps.length, before)
})

test('pairing answers 409 when the device list is full, and the code is kept for another try', async () => {
  const { pairing, devices, attempt } = setup()
  for (let i = 0; i < 20; i++) devices.create({ name: 'd' + i })
  const { code } = pairing.createCode()
  const full = await attempt(code)
  assert.equal(full.status, 409)
  assert.equal(full.error, 'too-many-devices')
  devices.revoke(devices.list()[0].id)
  assert.equal((await attempt(code)).ok, true)
})

test('the log of a pairing has the device id and counts, never the code, the token or the name', async () => {
  const { pairing, attempt, logs } = setup()
  const { code } = pairing.createCode()
  const r = await attempt(code, { name: 'Secret Pixel' })
  const text = logs.join('\n')
  assert.ok(text.includes(r.deviceId))
  for (const secret of [code, code.replace('-', ''), r.token, 'Secret Pixel']) assert.ok(!text.includes(secret), secret)
})
