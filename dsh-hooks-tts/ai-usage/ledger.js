/** Append-only JSONL ledger of tracker records; the source of truth that notes are regenerated from. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function createLedger(path) {
  return {
    path,
    append(record) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        appendFileSync(path, JSON.stringify(record) + '\n')
      } catch { /* best effort: accounting must never break the session */ }
    },
    /** Replay every valid line into `tracker.apply`; returns the number applied. */
    replay(tracker) {
      if (!existsSync(path)) return 0
      let n = 0
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { tracker.apply(JSON.parse(line)); n++ } catch { /* skip corrupt line */ }
      }
      return n
    },
  }
}
