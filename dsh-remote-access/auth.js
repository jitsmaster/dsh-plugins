/** Password (scrypt) + optional TOTP, session store and brute-force throttling. Node built-ins only. */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const authPath = (dir) => join(dir, 'auth.json')

export function makeAuthRecord(password, withTotp) {
  const salt = randomBytes(16)
  const rec = { salt: salt.toString('hex'), hash: scryptSync(password, salt, 64, SCRYPT).toString('hex') }
  if (withTotp) rec.totpSecret = base32(randomBytes(20))
  return rec
}

export function saveAuthRecord(dir, rec) { writeFileSync(authPath(dir), JSON.stringify(rec, null, 2), { mode: 0o600 }) }
export function loadAuthRecord(dir) {
  const p = authPath(dir)
  if (!existsSync(p)) return undefined
  try {
    const rec = JSON.parse(readFileSync(p, 'utf8'))
    return typeof rec.salt === 'string' && typeof rec.hash === 'string' ? rec : undefined
  } catch { return undefined }
}

function base32(buf) {
  let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0')
  return bits.match(/.{1,5}/g).map((c) => B32[parseInt(c.padEnd(5, '0'), 2)]).join('')
}
function unbase32(s) {
  let bits = ''; for (const ch of s) bits += B32.indexOf(ch).toString(2).padStart(5, '0')
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)))
}
function totp(secret, t) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(t / 30000)))
  const h = createHmac('sha1', unbase32(secret)).update(c).digest()
  const o = h[19] & 15
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0')
}

const eq = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }

export function verifyCredentials(rec, password, code) {
  const got = scryptSync(String(password ?? ''), Buffer.from(rec.salt, 'hex'), 64, SCRYPT)
  let ok = timingSafeEqual(got, Buffer.from(rec.hash, 'hex'))
  if (rec.totpSecret) {
    const now = Date.now(); const c = String(code ?? '').replace(/\s/g, '')
    const t = [-30000, 0, 30000].map((d) => eq(totp(rec.totpSecret, now + d), c)).some(Boolean)
    ok = ok && t
  }
  return ok
}

export function createSessions(hours) {
  const ttl = hours * 3600e3; const map = new Map()
  return {
    create() { const id = randomBytes(32).toString('base64url'); map.set(id, Date.now() + ttl); return id },
    valid(id) {
      if (!id) return false
      const exp = map.get(id)
      if (exp === undefined) return false
      if (exp < Date.now()) { map.delete(id); return false }
      return true
    },
    destroy(id) { map.delete(id) },
    sweep() { const n = Date.now(); for (const [k, v] of map) if (v < n) map.delete(k) },
  }
}

/** Per-IP exponential lockout plus a global failure budget. */
export function createThrottle() {
  const ips = new Map(); let global = []
  return {
    /** ms the caller must wait, 0 if allowed. */
    wait(ip) {
      const n = Date.now()
      global = global.filter((t) => n - t < 600e3)
      if (global.length >= 40) return 60e3
      const e = ips.get(ip)
      return e && e.until > n ? e.until - n : 0
    },
    fail(ip) {
      const n = Date.now(); const e = ips.get(ip) ?? { fails: 0, until: 0 }
      e.fails++; global.push(n)
      if (e.fails >= 5) e.until = n + Math.min(15 * 60e3, 2 ** (e.fails - 5) * 5e3)
      ips.set(ip, e)
      if (ips.size > 5000) ips.clear()
    },
    ok(ip) { ips.delete(ip) },
  }
}
