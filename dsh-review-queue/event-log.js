/**
 * A minimal append-only event log for the review queue (spec: Review Queue Grouping And Priority Design Spec): when an item was tiered, shown,
 * acted on and resolved. Ids, types, tiers, ranks and timestamps ONLY, never card text: every field is on an allow-list and every string is cut,
 * so nothing else can ride along. One JSON object per line, rotated at 2 MB (one `.old` generation). Best effort: a log problem never reaches the caller.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

export const EVENT_KINDS = new Set(['tiered', 'shown', 'acted', 'resolved'])
export const EVENT_MAX_BYTES = 2 * 1024 * 1024
const MAX_STR = 64
const STRING_FIELDS = ['itemId', 'type', 'severity', 'urgency', 'resolution', 'by', 'groupId']
const NUMBER_FIELDS = ['tier', 'rank', 'groupRank']

const cut = (s) => (s.length > MAX_STR ? s.slice(0, MAX_STR) : s)

/** The allowed part of an event, or undefined for an unknown kind. */
export function cleanEvent(event) {
  if (!event || !EVENT_KINDS.has(event.kind)) return undefined
  const out = { kind: event.kind }
  for (const f of STRING_FIELDS) if (typeof event[f] === 'string') out[f] = cut(event[f])
  for (const f of NUMBER_FIELDS) if (Number.isFinite(event[f])) out[f] = event[f]
  return out
}

/**
 * @param {string} file
 * @param {{ now?: () => number, maxBytes?: number }} [opts]
 */
export function createEventLog(file, { now = Date.now, maxBytes = EVENT_MAX_BYTES } = {}) {
  const parse = (text) => text.split('\n').filter(Boolean).flatMap((line) => { try { const e = JSON.parse(line); return e && typeof e === 'object' && !Array.isArray(e) ? [e] : [] } catch { return [] } })
  let size // tracked in memory after the first stat: no stat per event
  return {
    /** Appends one event (allow-listed, stamped with `at`); true when written. A failed rotation truncates the file instead of stopping the log. */
    record(event) {
      const clean = cleanEvent(event)
      if (!clean) return false
      try {
        if (size === undefined) { try { size = statSync(file).size } catch { size = 0 } }
        if (size > maxBytes) {
          try { renameSync(file, file + '.old') } catch { writeFileSync(file, '') }
          size = 0
        }
        const line = JSON.stringify({ at: now(), ...clean }) + '\n'
        appendFileSync(file, line)
        size += Buffer.byteLength(line)
        return true
      } catch { return false }
    },
    /** Events oldest first (the rotated file first); unreadable lines are skipped. */
    read(test) {
      const all = []
      for (const f of [file + '.old', file]) {
        try { if (existsSync(f)) all.push(...parse(readFileSync(f, 'utf8'))) } catch { /* skip */ }
      }
      return typeof test === 'function' ? all.filter(test) : all
    },
  }
}
