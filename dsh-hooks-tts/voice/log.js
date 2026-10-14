import { appendFile as appendFileAsync, rename as renameAsync, stat as statAsync } from 'node:fs/promises'
import { cutBytes } from './sanitize.js'

/**
 * The voice log (voice.log, one JSON object per line), written off the hot path: write() only buffers a line and schedules a
 * flush; the flush appends all buffered lines in one go (rotating to <file>.1 past maxBytes). Every I/O failure is swallowed:
 * logging must never break voice. The buffer is bounded, so a stalled disk costs the oldest lines, not memory, and a line is cut to
 * maxLineBytes (a decider reply or a tool result can be megabytes): the cut line stays one valid JSON object ({at, type, stage,
 * truncated:true, bytes, text: the start of the original line}).
 */

function limitLine(line, entry, at, maxLineBytes) {
  const size = Buffer.byteLength(line)
  if (size <= maxLineBytes) return line
  const name = (v) => (typeof v === 'string' ? v.slice(0, 60) : undefined)
  const meta = { at, type: name(entry?.type), stage: name(entry?.stage), truncated: true, bytes: size }
  let room = maxLineBytes
  let out = ''
  // Bounded work: a character is at least one byte, so the first 2 x room characters always cover room bytes. Cutting a prefix
  // first keeps every pass O(maxLineBytes) instead of O(size of a multi-MB line) (a split surrogate pair lies beyond the cut).
  const head = line.slice(0, maxLineBytes * 2)
  // The text is JSON-escaped again inside the new line (quotes double up), so shrink until the whole line fits.
  while (room > 0) {
    out = JSON.stringify({ ...meta, text: cutBytes(head, room) }) + '\n'
    if (Buffer.byteLength(out) <= maxLineBytes) return out
    room = Math.floor(room * 0.8) - 16
  }
  return JSON.stringify({ at, truncated: true, bytes: size }) + '\n'
}
export function createVoiceLog({
  file, maxBytes = 1_000_000, maxBuffered = 500, maxLineBytes = 8192,
  appendFile = appendFileAsync, statFile = statAsync, rename = renameAsync,
  schedule = (fn) => { setTimeout(fn, 50).unref?.() },
  now = () => new Date(),
}) {
  let buffer = []
  let scheduled = false
  let draining // the one running drain loop, if any

  async function drainOnce() {
    const data = buffer.join('')
    buffer = []
    try {
      try { if ((await statFile(file)).size > maxBytes) await rename(file, file + '.1') } catch { /* no log yet */ }
      await appendFile(file, data)
    } catch { /* best effort */ }
  }

  /** Writes the buffer, and whatever arrives meanwhile, until it is empty. The flag is cleared in the same step that sees the empty buffer. */
  async function drainAll() {
    try {
      while (buffer.length > 0) await drainOnce()
    } finally { draining = undefined }
  }

  /**
   * Appends what is buffered. Only one drain loop ever exists (appends never overlap): a flush while one runs joins it instead of
   * chaining another link behind it, so a stalled disk costs one pending append, not one promise per 50 ms tick. Never rejects.
   */
  function flush() {
    if (draining) return draining
    if (buffer.length === 0) return Promise.resolve()
    draining = drainAll() // awaits at least once before its finally, so the assignment always comes first
    return draining
  }

  return {
    write(entry) {
      let line
      try {
        const at = now().toISOString()
        line = limitLine(JSON.stringify({ at, ...entry }) + '\n', entry, at, maxLineBytes)
      } catch { return }
      buffer.push(line)
      if (buffer.length > maxBuffered) buffer.splice(0, buffer.length - maxBuffered)
      if (!scheduled) {
        scheduled = true
        schedule(() => { scheduled = false; return flush() })
      }
    },
    flush,
    /** 1 while a drain loop is running (a stalled disk keeps it at 1: flushes join it), else 0. */
    pendingFlushes: () => (draining ? 1 : 0),
    /** flush(), but gives up after timeoutMs (a stalled disk must not hang shutdown); never rejects. */
    flushWithin(timeoutMs) {
      let timer
      const gaveUp = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.() })
      return Promise.race([flush().catch(() => {}), gaveUp]).finally(() => clearTimeout(timer))
    },
  }
}
