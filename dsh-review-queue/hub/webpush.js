/**
 * Web Push on node:crypto only (no npm dependency): VAPID (RFC 8292) authentication, aes128gcm message encryption (RFC 8291 /
 * RFC 8188) and the one HTTP request that hands a message to the browser's push service. Pure functions plus an injectable fetch,
 * so everything is unit-tested, the encryption against the worked example of RFC 8291 appendix A.
 */
import { createECDH, createHash, createCipheriv, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'

const CURVE = 'prime256v1'
const RECORD_SIZE = 4096
// A push service accepts at most 4096 bytes: 86 header + 16 tag + 1 padding delimiter leave this much for the plaintext.
const HEADER_LEN = 21 + 65
export const MAX_PLAINTEXT = RECORD_SIZE - HEADER_LEN - 16 - 1
const MAX_VAPID_EXP_SEC = 12 * 3600
export const DEFAULT_TTL_SEC = 12 * 3600
const URGENCIES = new Set(['very-low', 'low', 'normal', 'high'])
const SEND_TIMEOUT_MS = 15_000

export const b64u = (buf) => Buffer.from(buf).toString('base64url')
/** Decodes base64url (padding tolerated); throws on any other character. */
export function fromB64u(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new TypeError('not a base64url string')
  return Buffer.from(text.replace(/=+$/, ''), 'base64url')
}

const pad32 = (buf) => (buf.length >= 32 ? buf : Buffer.concat([Buffer.alloc(32 - buf.length), buf]))

// ---- VAPID -----------------------------------------------------------------------------------------------------------------

/** A fresh P-256 key pair: the public key as the uncompressed point and the private scalar, both base64url. */
export function generateVapidKeys() {
  const ecdh = createECDH(CURVE)
  ecdh.generateKeys()
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(pad32(ecdh.getPrivateKey())) }
}

/** The public key (base64url point) that belongs to a private scalar, to check that a stored pair still matches. */
export function publicKeyOf(privateKey) {
  const ecdh = createECDH(CURVE)
  ecdh.setPrivateKey(fromB64u(privateKey))
  return b64u(ecdh.getPublicKey())
}

function signingKey({ publicKey, privateKey }) {
  const point = fromB64u(publicKey)
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)), d: privateKey }, format: 'jwk' })
}

/**
 * The Authorization header of a push request: "vapid t=<ES256 JWT>, k=<public key>". The JWT names the push service (the origin of
 * the endpoint) and lives at most 12 hours.
 * @param {{ endpoint: string, vapid: { publicKey: string, privateKey: string, subject: string }, now?: number, expiresInSec?: number }} o
 */
export function vapidAuthorization({ endpoint, vapid, now = Date.now(), expiresInSec = MAX_VAPID_EXP_SEC }) {
  const life = Math.min(Math.max(Math.floor(expiresInSec), 1), MAX_VAPID_EXP_SEC)
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + life, sub: vapid.subject }))
  const signed = head + '.' + claims
  // ieee-p1363 is the raw r||s form JWS wants (the default would be DER).
  const signature = sign('sha256', Buffer.from(signed), { key: signingKey(vapid), dsaEncoding: 'ieee-p1363' })
  return 'vapid t=' + signed + '.' + b64u(signature) + ', k=' + vapid.publicKey
}

// ---- RFC 8291 encryption ---------------------------------------------------------------------------------------------------

const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length))

/**
 * Encrypts one push message (a single aes128gcm record) for a subscription. `ephemeral` ({ privateKey }, base64url) and `salt`
 * (base64url or Buffer) exist for the RFC test vector; by default both are fresh random values.
 * @returns {Buffer} the request body: header (salt, record size, key id = our public key) followed by the ciphertext
 */
export function encryptPayload({ plaintext, uaPublic, authSecret, ephemeral, salt }) {
  const text = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext)
  if (text.length > MAX_PLAINTEXT) throw new RangeError('payload too large for one push message (' + text.length + ' > ' + MAX_PLAINTEXT + ' bytes)')
  let ua, auth
  try { ua = fromB64u(uaPublic) } catch { throw new TypeError('invalid subscription key (p256dh)') }
  try { auth = fromB64u(authSecret) } catch { throw new TypeError('invalid subscription auth secret') }
  if (ua.length !== 65 || ua[0] !== 4) throw new TypeError('invalid subscription key (p256dh must be an uncompressed P-256 point)')
  if (auth.length !== 16) throw new TypeError('invalid subscription auth secret (16 bytes expected)')

  const as = createECDH(CURVE)
  if (ephemeral?.privateKey) as.setPrivateKey(typeof ephemeral.privateKey === 'string' ? fromB64u(ephemeral.privateKey) : Buffer.from(ephemeral.privateKey))
  else as.generateKeys()
  const asPublic = as.getPublicKey()
  let shared
  try { shared = as.computeSecret(ua) } catch { throw new TypeError('invalid subscription key (p256dh is not a point on P-256)') }
  const saltBytes = salt === undefined ? randomBytes(16) : typeof salt === 'string' ? fromB64u(salt) : Buffer.from(salt)
  if (saltBytes.length !== 16) throw new TypeError('salt must be 16 bytes')

  // RFC 8291 3.3: mix the ECDH secret with the auth secret, binding both public keys; RFC 8188 2.2/2.3: derive key and nonce.
  const ikm = hkdf(shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublic]), 32)
  const cek = hkdf(ikm, saltBytes, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, saltBytes, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 marks the last record; no further padding (the text is already generic).
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([text, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(RECORD_SIZE)
  return Buffer.concat([saltBytes, rs, Buffer.from([asPublic.length]), asPublic, encrypted])
}

// ---- delivery --------------------------------------------------------------------------------------------------------------

/** A Topic header value is 1-32 base64url characters; anything else (a long or free-form tag) is hashed into one. */
function topicOf(topic) {
  if (typeof topic !== 'string' || !topic) return undefined
  return /^[A-Za-z0-9_-]{1,32}$/.test(topic) ? topic : createHash('sha256').update(topic).digest('base64url').slice(0, 32)
}

/**
 * Sends one message to one subscription. Never throws: a bad subscription or a network failure comes back as status 0 with an error.
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {object} payload JSON-serialisable (the service worker reads { title, body, tag, url })
 * @param {{ ttl?: number, urgency?: string, topic?: string, vapid: { publicKey: string, privateKey: string, subject: string }, fetch?: typeof fetch, now?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, status: number, gone: boolean, error?: string }>}
 */
export async function sendPush(subscription, payload, { ttl = DEFAULT_TTL_SEC, urgency = 'normal', topic, vapid, fetch: doFetch = globalThis.fetch, now, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  let body, headers
  try {
    body = encryptPayload({ plaintext: JSON.stringify(payload), uaPublic: subscription.keys.p256dh, authSecret: subscription.keys.auth })
    headers = {
      Authorization: vapidAuthorization({ endpoint: subscription.endpoint, vapid, now }),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(Math.max(0, Math.floor(Number(ttl)) || 0)),
      Urgency: URGENCIES.has(urgency) ? urgency : 'normal',
    }
    const t = topicOf(topic)
    if (t) headers.Topic = t
  } catch (error) { return { ok: false, status: 0, gone: false, error: String(error?.message ?? error) } }
  try {
    const res = await doFetch(subscription.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) })
    // 404 and 410: the push service no longer knows the subscription (uninstalled, expired, permission revoked).
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410, ...(res.status >= 300 ? { error: 'HTTP ' + res.status } : {}) }
  } catch (error) { return { ok: false, status: 0, gone: false, error: String(error?.message ?? error) } }
}
