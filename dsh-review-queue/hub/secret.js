/**
 * The agent secret (docs/hub.md 9.3): 32 random bytes as base64url in <stateDir>/hub.secret, created when absent and never rotated
 * by the hub. A file that is empty or garbled is replaced. Tightening the Windows ACL is the launcher's job (H4); the secret is
 * only ever compared, never logged.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { readText, writeAtomic } from './atomic-file.js'

export const SECRET_FILE = 'hub.secret'
const VALID = /^[A-Za-z0-9_-]{16,128}$/

export function loadOrCreateSecret(stateDir) {
  const file = join(stateDir, SECRET_FILE)
  const existing = readText(file)?.trim()
  if (existing && VALID.test(existing)) return existing
  const secret = randomBytes(32).toString('base64url')
  writeAtomic(file, secret + '\n', { mode: 0o600 })
  return secret
}

const digest = (text) => createHash('sha256').update(text).digest()

/** Constant time: both sides are hashed first, so the length of the secret does not leak either. */
export function secretMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string' || !expected) return false
  return timingSafeEqual(digest(expected), digest(given))
}
