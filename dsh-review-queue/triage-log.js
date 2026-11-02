/**
 * The triage log (phase 2 of the plan in the vault note "Review Queue AI Triage Design Spec"): one JSON object per line in the state directory,
 * what the model proposed and what code made of it, so agreement per rule can be read back later. Text that can carry a secret (replies, answers,
 * quotes, commands) is redacted BEFORE it is written. Rotates at 5 MB (one generation, <file>.old); entries older than the retention (90 days) are
 * dropped by prune(). Best effort: a logging problem never reaches the caller.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

export const LOG_RETENTION_MS = 90 * 24 * 3600 * 1000
export const LOG_MAX_BYTES = 5 * 1024 * 1024
const MAX_STRING = 2000

/** Secrets the log must never hold: bearer tokens, key=value credentials, well-known key prefixes, long opaque tokens, private key blocks. */
export function redact(text) {
  return String(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[redacted]')
    .replace(/\b(?:[A-Za-z0-9_-]*(?:token|secret|password|passwd|pwd|key)[A-Za-z0-9_-]*|(?:[A-Za-z0-9_-]*[_-])?pat)\s*[=:]\s*\S+/gi, '[redacted]')
    .replace(/\b(?:sk|pk|ghp|gho|ghu|ghs|xox[a-z]|AKIA)[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9+_-]{32,}={0,2}/g, '[redacted]')
}

/** Every string anywhere in the entry redacted and capped (depth and array length bounded). */
export function redactDeep(value, depth = 0) {
  if (typeof value === 'string') { const r = redact(value); return r.length > MAX_STRING ? r.slice(0, MAX_STRING) + '…' : r }
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactDeep(v, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, depth + 1)]))
}

/**
 * @param {string} file
 * @param {{ now?: () => number, maxBytes?: number, retentionMs?: number }} [opts]
 */
export function createTriageLog(file, { now = Date.now, maxBytes = LOG_MAX_BYTES, retentionMs = LOG_RETENTION_MS } = {}) {
  const parse = (text) => text.split('\n').filter(Boolean).flatMap((line) => { try { const e = JSON.parse(line); return e && typeof e === 'object' && !Array.isArray(e) ? [e] : [] } catch { return [] } })
  return {
    /** Appends one entry (redacted, stamped with `at`); returns true when written. */
    append(entry) {
      try {
        let size = 0
        try { size = statSync(file).size } catch { /* not there yet */ }
        if (size > maxBytes) renameSync(file, file + '.old')
        appendFileSync(file, JSON.stringify({ at: now(), ...redactDeep(entry) }) + '\n')
        return true
      } catch { return false }
    },
    /** Entries oldest first (the rotated file first), optionally those matching a test; unreadable lines are skipped. */
    read(test) {
      const all = []
      for (const f of [file + '.old', file]) {
        try { if (existsSync(f)) all.push(...parse(readFileSync(f, 'utf8'))) } catch { /* skip */ }
      }
      return typeof test === 'function' ? all.filter(test) : all
    },
    /** Drops entries older than the retention from the file; returns how many went. */
    prune() {
      try {
        if (!existsSync(file)) return 0
        const limit = now() - retentionMs
        const entries = parse(readFileSync(file, 'utf8'))
        const kept = entries.filter((e) => typeof e.at === 'number' && e.at >= limit)
        if (kept.length !== entries.length) writeFileSync(file, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''))
        return entries.length - kept.length
      } catch { return 0 }
    },
  }
}
