/**
 * A small append-only log file, so a failure that is otherwise silent (the todo workspace suggestion, a summary that fell
 * back) can be traced afterwards. One timestamped line per call; past maxBytes the old file moves to <file>.old (one
 * generation), so the log never grows without bound. Best effort: a logging problem never reaches the caller.
 */
import { appendFileSync, renameSync, statSync } from 'node:fs'

const MAX_BYTES = 256 * 1024

export function createFileLog(file, { maxBytes = MAX_BYTES, now = Date.now } = {}) {
  return (line) => {
    try {
      let size = 0
      try { size = statSync(file).size } catch { /* not there yet */ }
      if (size > maxBytes) renameSync(file, file + '.old')
      appendFileSync(file, new Date(now()).toISOString() + ' ' + String(line).replace(/\s*[\r\n]+\s*/g, ' / ') + '\n')
    } catch { /* best effort */ }
  }
}
