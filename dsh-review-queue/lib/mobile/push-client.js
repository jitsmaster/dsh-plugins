/**
 * The pure parts of the phone's push set-up: decoding the server's VAPID key, quiet-hours rules, the settings of one device and the
 * body of the subscribe call. No browser or network access here, so all of it is unit-tested (test/mobile-push-client.test.mjs).
 */

/** The item types that can be pushed. `breaksQuiet`: a blocked session may still wake the phone during quiet hours (docs/mobile.md). */
export const PUSH_TYPES = [
  { id: 'permission', label: 'Permission requests', breaksQuiet: true },
  { id: 'question', label: 'Questions', breaksQuiet: true },
  { id: 'pr-merged', label: 'Pull request merged', breaksQuiet: false },
  { id: 'completed', label: 'Done (needs a look)', breaksQuiet: false },
]

export const DEFAULT_QUIET = { start: '22:00', end: '07:00' }
const NAME_MAX = 40
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isTime = (v) => typeof v === 'string' && TIME.test(v)
const isZone = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64

/** The server's VAPID public key (base64url, no padding) as the bytes `pushManager.subscribe` wants. */
export function urlBase64ToUint8Array(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(text) || text.replace(/=+$/, '').length % 4 === 1) throw new TypeError('Not a base64url string')
  const base64 = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/** @returns {{ok: true, value: {enabled: boolean, start: string, end: string, tz: string}} | {ok: false, error: string}} */
export function validateQuietHours(q) {
  if (!isObject(q)) return { ok: false, error: 'Quiet hours are not set.' }
  const value = { enabled: q.enabled === true, start: isTime(q.start) ? q.start : DEFAULT_QUIET.start, end: isTime(q.end) ? q.end : DEFAULT_QUIET.end, tz: isZone(q.tz) ? q.tz : '' }
  if (!value.enabled) return { ok: true, value }
  if (!isTime(q.start)) return { ok: false, error: 'Start time must be HH:MM on a 24 hour clock.' }
  if (!isTime(q.end)) return { ok: false, error: 'End time must be HH:MM on a 24 hour clock.' }
  if (q.start === q.end) return { ok: false, error: 'Start and end must differ.' }
  if (!value.tz) return { ok: false, error: 'A time zone is required.' }
  return { ok: true, value }
}

/** A complete, valid settings object from whatever was stored (types default to on, quiet hours to off). `tz` is the phone's zone. */
export function normalizeSettings(raw, tz = 'UTC') {
  const src = isObject(raw) ? raw : {}
  const types = {}
  for (const t of PUSH_TYPES) types[t.id] = isObject(src.types) && typeof src.types[t.id] === 'boolean' ? src.types[t.id] : true
  const quiet = isObject(src.quiet) ? validateQuietHours({ ...src.quiet, tz: isZone(src.quiet.tz) ? src.quiet.tz : tz }) : { ok: false }
  return {
    name: typeof src.name === 'string' ? src.name.trim().slice(0, NAME_MAX) : '',
    types,
    quiet: quiet.ok ? quiet.value : { enabled: false, ...DEFAULT_QUIET, tz: isZone(tz) ? tz : 'UTC' },
  }
}

/** A readable device name from the user agent ("Pixel 7"); Chrome's reduced user agent only says "K". */
export function defaultDeviceName(userAgent) {
  const model = typeof userAgent === 'string' ? /Android [\d.]+;\s*([^;)]+)/.exec(userAgent) : null
  if (typeof userAgent !== 'string' || !userAgent.trim()) return 'This phone'
  const name = model ? model[1].replace(/\s+Build\/.*$/, '').trim() : ''
  return name.length > 1 ? name : 'Android phone'
}

/** The body of POST /v1/push/subscribe: the endpoint and keys of the subscription plus this device's settings. */
export function buildSubscribePayload({ subscription, settings, userAgent, tz }) {
  const sub = subscription && typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription
  const keys = isObject(sub) && isObject(sub.keys) ? sub.keys : {}
  if (!isObject(sub) || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !keys.p256dh || !keys.auth) throw new Error('Invalid push subscription (needs an https endpoint with p256dh and auth keys).')
  const s = normalizeSettings(settings, tz)
  return { subscription: { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, name: s.name || defaultDeviceName(userAgent), types: s.types, quiet: s.quiet }
}
