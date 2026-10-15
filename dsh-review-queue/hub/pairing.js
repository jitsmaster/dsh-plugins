/**
 * Pairing a phone (docs/hub.md 9.4). The desktop asks for a code: 8 characters of Crockford base32 (40 bits of randomness), valid
 * 5 minutes, single use, one active code at a time, kept only as its SHA-256 in memory. The phone sends the code and a name to the public
 * POST /hub/v1/pair; every refusal for a wrong, expired, used or missing code is the same 400 bad-code, delayed 0.5 s * 2^fails (at most
 * 8 s) so guessing is slow, and the 5th wrong try kills the code. Tries are rate limited by address (the caller passes the address the
 * hub trusts) and across all addresses; a limited try is refused at once and is not a guess. The code, the token and the name never
 * reach the log.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRateLimiter } from './ratelimit.js'

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_TTL_MS = 5 * 60_000
const CODE_LENGTH = 8
const MIN_DELAY_MS = 500
const MAX_DELAY_MS = 8000
const DEFAULTS = { perIp: 5, global: 10, windowMs: 60_000, tries: 5 }
const BAD_CODE = { ok: false, status: 400, error: 'bad-code' }
const digest = (text) => createHash('sha256').update(text).digest()

/** Upper case, no spaces or hyphens, and Crockford's reading of look-alikes (O is 0, I and L are 1); '' when it is not text. */
export function normalizeCode(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1') : ''
}

/**
 * @param {{ devices: ReturnType<import('./devices.js').createDevices>, now?: () => number, sleep?: (ms: number) => Promise<void>, random?: (n: number) => Buffer,
 *   limits?: Partial<typeof DEFAULTS>, log?: (line: string) => void }} opts
 */
export function createPairing({ devices, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = randomBytes, limits = {}, log = () => {} }) {
  const cfg = { ...DEFAULTS, ...limits }
  const perIp = createRateLimiter({ now, limit: cfg.perIp, windowMs: cfg.windowMs })
  const global = createRateLimiter({ now, limit: cfg.global, windowMs: cfg.windowMs })
  /** @type {{ hash: Buffer, expiresAt: number, tries: number } | undefined} */
  let active
  let fails = 0

  function newCode() {
    const bytes = random(5) // 40 bits, five per character
    let bits = 0n
    for (const b of bytes) bits = (bits << 8n) | BigInt(b)
    let code = ''
    for (let i = CODE_LENGTH - 1; i >= 0; i--) code += CODE_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)]
    return code
  }

  /** The delay and the one answer of every refusal; fails counts the refusals since the last success. */
  async function refuse() {
    const wait = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** fails)
    fails++
    await sleep(wait)
    return BAD_CODE
  }
  const matches = (code) => active !== undefined && now() < active.expiresAt && timingSafeEqual(digest(normalizeCode(code)), active.hash)

  return {
    /** Replaces the active code. @returns {{ code: string, expiresAt: number }} the only time the code exists in clear */
    createCode() {
      const code = newCode()
      active = { hash: digest(code), expiresAt: now() + CODE_TTL_MS, tries: 0 }
      fails = 0
      log('pairing code created')
      return { code: code.slice(0, 4) + '-' + code.slice(4), expiresAt: active.expiresAt }
    },

    /**
     * @param {{ code: unknown, name?: unknown, ip: string, login?: string }} attempt
     * @returns {Promise<{ ok: true, deviceId: string, token: string, name: string } | { ok: false, status: number, error: string, retryAfterMs?: number }>}
     */
    async pair({ code, name, ip, login }) {
      const limited = [perIp.take(String(ip)), global.take('*')].find((r) => !r.ok)
      if (limited) return { ok: false, status: 429, error: 'rate-limited', retryAfterMs: limited.retryAfterMs }
      if (!matches(code)) {
        if (active && now() < active.expiresAt && ++active.tries >= cfg.tries) { active = undefined; log('pairing code invalidated after too many wrong tries') }
        return refuse()
      }
      const created = devices.create({ name, login })
      if (!created.ok) return { ok: false, status: created.error === 'too-many-devices' ? 409 : 500, error: created.error }
      active = undefined
      fails = 0
      log('device paired (' + created.device.id + ')')
      return { ok: true, deviceId: created.device.id, token: created.token, name: created.device.name }
    },
  }
}
