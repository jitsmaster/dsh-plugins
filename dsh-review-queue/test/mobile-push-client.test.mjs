import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PUSH_TYPES, DEFAULT_QUIET, urlBase64ToUint8Array, validateQuietHours, normalizeSettings, defaultDeviceName, buildSubscribePayload,
} from '../lib/mobile/push-client.js'

const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: 'BPk', auth: 'aut' } }
const ALL_ON = { permission: true, question: true, completed: true, 'pr-merged': true }

test('the four push types are the item types that need the user', () => {
  assert.deepEqual(PUSH_TYPES.map((t) => t.id), ['permission', 'question', 'pr-merged', 'completed'])
  for (const t of PUSH_TYPES) assert.equal(typeof t.label, 'string')
  assert.equal(PUSH_TYPES.find((t) => t.id === 'permission').breaksQuiet, true)
  assert.equal(PUSH_TYPES.find((t) => t.id === 'completed').breaksQuiet, false)
})

test('urlBase64ToUint8Array decodes unpadded base64url into bytes', () => {
  assert.deepEqual([...urlBase64ToUint8Array('AQAB')], [1, 0, 1])
  assert.deepEqual([...urlBase64ToUint8Array('AQ')], [1])
  assert.deepEqual([...urlBase64ToUint8Array('-__-')], [0xfb, 0xff, 0xfe])
  assert.ok(urlBase64ToUint8Array('AQAB') instanceof Uint8Array)
})

test('urlBase64ToUint8Array decodes a 65-byte VAPID public key', () => {
  const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url')
  const bytes = urlBase64ToUint8Array(key)
  assert.equal(bytes.length, 65)
  assert.equal(bytes[0], 4)
})

test('urlBase64ToUint8Array rejects text that is not base64url', () => {
  assert.throws(() => urlBase64ToUint8Array('not base64!'), /base64/i)
  assert.throws(() => urlBase64ToUint8Array(''), /base64/i)
  assert.throws(() => urlBase64ToUint8Array(undefined), /base64/i)
})

test('quiet hours: disabled needs no valid times', () => {
  const r = validateQuietHours({ enabled: false, start: 'x', end: '' })
  assert.equal(r.ok, true)
  assert.equal(r.value.enabled, false)
})

test('quiet hours: a window across midnight is valid', () => {
  const r = validateQuietHours({ enabled: true, start: '22:00', end: '07:00', tz: 'Europe/Amsterdam' })
  assert.deepEqual(r, { ok: true, value: { enabled: true, start: '22:00', end: '07:00', tz: 'Europe/Amsterdam' } })
})

test('quiet hours: times must be HH:MM on a 24 hour clock', () => {
  for (const bad of ['7:00', '25:00', '12:60', '12:5', 'noon', '', null, 1200]) {
    const r = validateQuietHours({ enabled: true, start: bad, end: '07:00', tz: 'UTC' })
    assert.equal(r.ok, false, String(bad))
    assert.match(r.error, /start/i)
  }
  const r = validateQuietHours({ enabled: true, start: '22:00', end: '24:00', tz: 'UTC' })
  assert.equal(r.ok, false)
  assert.match(r.error, /end/i)
})

test('quiet hours: start and end must differ', () => {
  const r = validateQuietHours({ enabled: true, start: '08:00', end: '08:00', tz: 'UTC' })
  assert.equal(r.ok, false)
  assert.match(r.error, /differ/i)
})

test('quiet hours: a time zone is required when enabled', () => {
  assert.equal(validateQuietHours({ enabled: true, start: '22:00', end: '07:00', tz: '' }).ok, false)
  assert.equal(validateQuietHours({ enabled: true, start: '22:00', end: '07:00' }).ok, false)
})

test('quiet hours: junk input is an error, never a throw', () => {
  for (const junk of [undefined, null, 'x', 3, []]) assert.equal(validateQuietHours(junk).ok, false)
})

test('normalizeSettings gives every type on and quiet hours off by default', () => {
  const s = normalizeSettings(undefined, 'Europe/Amsterdam')
  assert.deepEqual(s.types, ALL_ON)
  assert.deepEqual(s.quiet, { enabled: false, start: DEFAULT_QUIET.start, end: DEFAULT_QUIET.end, tz: 'Europe/Amsterdam' })
  assert.equal(DEFAULT_QUIET.start, '22:00')
  assert.equal(DEFAULT_QUIET.end, '07:00')
  assert.equal(s.name, '')
})

test('normalizeSettings keeps good values and drops bad ones', () => {
  const s = normalizeSettings({
    name: '  Pixel  ', types: { permission: false, question: 'no', bogus: false }, quiet: { enabled: true, start: '23:30', end: '06:15', tz: 'UTC' },
  }, 'Europe/Amsterdam')
  assert.deepEqual(s.types, { ...ALL_ON, permission: false })
  assert.deepEqual(s.quiet, { enabled: true, start: '23:30', end: '06:15', tz: 'UTC' })
  assert.equal(s.name, 'Pixel')
})

test('normalizeSettings repairs an invalid quiet window instead of keeping it', () => {
  const s = normalizeSettings({ quiet: { enabled: true, start: '99:99', end: '07:00', tz: 'UTC' } }, 'UTC')
  assert.equal(s.quiet.enabled, false)
  assert.equal(s.quiet.start, '22:00')
})

test('normalizeSettings survives non-object input', () => {
  for (const junk of [null, 'x', 5, [], { types: 'x', quiet: 'y' }]) {
    const s = normalizeSettings(junk, 'UTC')
    assert.deepEqual(s.types, ALL_ON)
    assert.equal(s.quiet.enabled, false)
  }
})

test('defaultDeviceName reads the model out of an Android user agent', () => {
  assert.equal(defaultDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'), 'Pixel 7')
  assert.equal(defaultDeviceName('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'), 'Android phone')
  assert.equal(defaultDeviceName('Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A) Chrome/120'), 'SM-S918B')
  assert.equal(defaultDeviceName(''), 'This phone')
  assert.equal(defaultDeviceName(undefined), 'This phone')
})

test('buildSubscribePayload sends only the endpoint and the two keys of the subscription', () => {
  const p = buildSubscribePayload({ subscription: SUB, settings: { name: 'Pixel', types: { question: false }, quiet: { enabled: false } }, tz: 'UTC' })
  assert.deepEqual(p.subscription, { endpoint: SUB.endpoint, keys: { p256dh: 'BPk', auth: 'aut' } })
  assert.equal(p.name, 'Pixel')
  assert.deepEqual(p.types, { ...ALL_ON, question: false })
  assert.equal(p.quiet.enabled, false)
  assert.deepEqual(Object.keys(p).sort(), ['name', 'quiet', 'subscription', 'types'])
})

test('buildSubscribePayload accepts a real PushSubscription (toJSON)', () => {
  const p = buildSubscribePayload({ subscription: { toJSON: () => SUB }, settings: {}, tz: 'UTC' })
  assert.equal(p.subscription.endpoint, SUB.endpoint)
})

test('buildSubscribePayload names the device from the user agent when no name is given, and caps long names', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/120'
  assert.equal(buildSubscribePayload({ subscription: SUB, settings: { name: '  ' }, userAgent: ua, tz: 'UTC' }).name, 'Pixel 7')
  assert.equal(buildSubscribePayload({ subscription: SUB, settings: { name: 'x'.repeat(100) }, tz: 'UTC' }).name.length, 40)
})

test('buildSubscribePayload refuses a subscription that is not usable', () => {
  const bad = [undefined, null, {}, { endpoint: 'http://insecure.example/x', keys: SUB.keys }, { endpoint: SUB.endpoint }, { endpoint: SUB.endpoint, keys: { p256dh: 'x' } }, { endpoint: SUB.endpoint, keys: { auth: 'x' } }]
  for (const subscription of bad) assert.throws(() => buildSubscribePayload({ subscription, settings: {}, tz: 'UTC' }), /subscription/i)
})

// ---- iOS device names ------------------------------------------------------------------------------------------------------------------
// An iPhone UA gives "iPhone", an iPad UA gives "iPad", and so does iPadOS in desktop mode (a Macintosh UA when the caller also says the screen
// has more than one touch point: defaultDeviceName(userAgent, { maxTouchPoints })). The Android model parsing above is unchanged.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPOD_UA = 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1'
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

test('defaultDeviceName: an iPhone user agent is "iPhone" (Safari and Chrome on iOS), an iPod is "iPhone" too', () => {
  assert.equal(defaultDeviceName(IPHONE_UA), 'iPhone')
  assert.equal(defaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1'), 'iPhone')
  assert.equal(defaultDeviceName(IPOD_UA), 'iPhone')
})

test('defaultDeviceName: an iPad user agent is "iPad"', () => {
  assert.equal(defaultDeviceName(IPAD_UA), 'iPad')
})

test('defaultDeviceName: iPadOS in desktop mode (Macintosh UA with maxTouchPoints > 1) is "iPad"; a plain Mac UA is not', () => {
  assert.equal(defaultDeviceName(MAC_UA, { maxTouchPoints: 5 }), 'iPad')
  assert.equal(defaultDeviceName(MAC_UA, { maxTouchPoints: 2 }), 'iPad')
  assert.notEqual(defaultDeviceName(MAC_UA, { maxTouchPoints: 0 }), 'iPad')
  assert.notEqual(defaultDeviceName(MAC_UA, { maxTouchPoints: 1 }), 'iPad')
  assert.notEqual(defaultDeviceName(MAC_UA), 'iPad')
  assert.notEqual(defaultDeviceName(MAC_UA), 'iPhone')
})

test('defaultDeviceName: the options argument never changes an Android or empty user agent', () => {
  assert.equal(defaultDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', { maxTouchPoints: 5 }), 'Pixel 7')
  assert.equal(defaultDeviceName('', { maxTouchPoints: 5 }), 'This phone')
  assert.equal(defaultDeviceName(undefined, { maxTouchPoints: 5 }), 'This phone')
})

test('buildSubscribePayload names an iPhone "iPhone" when the settings have no name', () => {
  const body = buildSubscribePayload({ subscription: { endpoint: 'https://web.push.apple.com/QGaU1', keys: { p256dh: 'BPk', auth: 'aut' } }, settings: {}, userAgent: IPHONE_UA, tz: 'America/Los_Angeles' })
  assert.equal(body.name, 'iPhone')
  assert.equal(body.subscription.endpoint, 'https://web.push.apple.com/QGaU1')
})

test('buildSubscribePayload names iPadOS desktop mode "iPad" when it is told the touch points (maxTouchPoints)', () => {
  const body = buildSubscribePayload({ subscription: { endpoint: 'https://web.push.apple.com/QGaU2', keys: { p256dh: 'BPk', auth: 'aut' } }, settings: {}, userAgent: MAC_UA, maxTouchPoints: 5, tz: 'UTC' })
  assert.equal(body.name, 'iPad')
})

test('buildSubscribePayload keeps a name the user typed on an iPhone', () => {
  const body = buildSubscribePayload({ subscription: SUB, settings: { name: 'My iPhone' }, userAgent: IPHONE_UA, tz: 'UTC' })
  assert.equal(body.name, 'My iPhone')
})
