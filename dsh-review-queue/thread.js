/**
 * The chat thread of a session: the text of its user and assistant messages, read from the session log on disk
 * (~/.dsh/sessions/--<cwd>--/<id>/session.v4.jsonl.zstd, see paused.js). Tool calls, tool results, thinking and every automatic
 * notice (hook, system, working-directory sources) are not part of it. A message is identified by the index of its record in the log,
 * which never changes while the log only grows, so a client pages back with the id of the oldest message it has (`before`).
 * Only message text is returned; nothing here logs it.
 */
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { SESSION_LOG, ZSTD_MAGIC, parseLogFrames } from './paused.js'

export const DEFAULT_LIMIT = 40
export const MAX_LIMIT = 100
/** A single message is cut to this many characters (marked truncated). */
export const MAX_TEXT = 4000
/** The thread reads logs up to this (compressed) size (the paused scan's cap is higher): the phone refreshes it every few seconds. */
export const DEFAULT_THREAD_LOG_BYTES = 8 * 1024 * 1024
/** One zstd frame may decode to at most this many bytes (the compressed cap alone does not bound the memory of a high-ratio file). */
export const MAX_FRAME_OUTPUT = 32 * 1024 * 1024
/** All frames of one log together may decode to at most this many bytes (the frame cap alone does not bound a log of many frames). */
export const MAX_TOTAL_OUTPUT = 64 * 1024 * 1024
/**
 * A page may start at most this many messages behind the newest one: a device pages back to read the recent conversation, it cannot dump a
 * whole transcript. A `before` cursor with more than this many messages at or after it gets an empty page (ok, no error).
 */
export const MAX_THREAD_DEPTH = 400
/** The parsed cache keeps this many of the newest messages of a log: the deepest page a device may ask for (MAX_THREAD_DEPTH back, MAX_LIMIT long) plus one, so that page still knows it has an earlier one. */
export const MAX_KEPT_MESSAGES = MAX_THREAD_DEPTH + MAX_LIMIT + 1
/**
 * A log that was read is served from memory for at least this long, for any page: the next read of that file waits until the time is up.
 * The wait grows with the cost: THREAD_COST_FACTOR times the time the last parse of that file took, at most MAX_THREAD_THROTTLE_MS.
 */
export const THREAD_THROTTLE_MS = 3000
export const THREAD_COST_FACTOR = 5
export const MAX_THREAD_THROTTLE_MS = 30_000
const COST_ENTRIES = 64
const CACHE_ENTRIES = 8
const RECENT_ENTRIES = 8

/**
 * A small LRU of the parsed logs, ONE entry per log file (the key is its path; a changed file replaces its entry, there is never a stale version
 * beside the new one): the phone refreshes the thread every 5 s, and an unchanged log must not be read and decompressed again (a big log is
 * tens of milliseconds of blocking work for the host). An entry is { size, mtimeMs, endOffset, recordCount, count, totalOutput, messages }: where
 * the last read ended (the byte offset after the last COMPLETE zstd frame, so a grown log is decoded from there on and a torn tail is read again
 * when it is complete), how many records and chat messages the complete frames hold, how many bytes they decoded to, and only the newest
 * MAX_KEPT_MESSAGES chat messages (each capped at MAX_TEXT), not the parsed records, so a cached log stays small. hits and misses are
 * counters for tests and diagnostics.
 * It also remembers, PER LOG FILE (root + session, whatever page is asked), the messages of the last read (at most recentMax files): the log of a
 * live session changes every few seconds, so the key above misses on every poll; within throttleMs of the moment a file was read, any request for
 * it (any before, any limit) is answered from those messages without touching the disk (recall / remember; throttleMs 0 switches this off).
 * flight() shares one read among the callers that ask for the same file at the same time (inflightSize counts the reads under way).
 * The window of a file is max(throttleMs, THREAD_COST_FACTOR x the duration of its last parse), at most MAX_THREAD_THROTTLE_MS: remember() is given
 * that duration, and keeps it for the file (cost) while later reads are served from the parsed cache and do not measure one.
 * now is the clock (milliseconds), injectable for tests; the cache exposes it so a read measures its duration with the same clock.
 */
export function createThreadCache({ max = CACHE_ENTRIES, throttleMs = THREAD_THROTTLE_MS, recentMax = RECENT_ENTRIES, now = Date.now } = {}) {
  const entries = new Map() // key -> messages; the first key is the least recently used
  const recent = new Map() // file key -> { at, messages }; the first key is the oldest
  const inflight = new Map() // file key -> the promise of the read under way
  const costs = new Map() // file key -> milliseconds the last parse of that file took; the first key is the oldest
  const cache = {
    max, hits: 0, misses: 0, now,
    get size() { return entries.size },
    get recentSize() { return recent.size },
    get inflightSize() { return inflight.size },
    recall(fileKey) {
      const last = recent.get(fileKey)
      if (!last) return undefined
      if (now() - last.at < last.window) return last.messages
      recent.delete(fileKey)
      return undefined
    },
    /** parseMs: how long the read that made messages took; undefined when it was served from the parsed cache (the last measured cost stays). */
    remember(fileKey, messages, parseMs) {
      if (throttleMs <= 0) return
      const at = now()
      if (Number.isFinite(parseMs)) {
        costs.delete(fileKey)
        costs.set(fileKey, Math.max(0, parseMs))
        while (costs.size > Math.max(COST_ENTRIES, recentMax)) costs.delete(costs.keys().next().value)
      }
      const window = Math.min(MAX_THREAD_THROTTLE_MS, Math.max(throttleMs, THREAD_COST_FACTOR * (costs.get(fileKey) ?? 0)))
      for (const [k, last] of recent) if (at - last.at >= last.window) recent.delete(k)
      recent.delete(fileKey)
      recent.set(fileKey, { at, window, messages })
      while (recent.size > recentMax) recent.delete(recent.keys().next().value)
    },
    /** The read under way for this file, or the one start() begins (it must not reject); the entry is removed when the read ends. */
    flight(fileKey, start) {
      let reading = inflight.get(fileKey)
      if (!reading) {
        reading = start().finally(() => { inflight.delete(fileKey) })
        inflight.set(fileKey, reading)
      }
      return reading
    },
    get(key) {
      if (!entries.has(key)) { cache.misses++; return undefined }
      const value = entries.get(key)
      entries.delete(key)
      entries.set(key, value)
      cache.hits++
      return value
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, value)
      while (entries.size > max) entries.delete(entries.keys().next().value)
    },
  }
  return cache
}
const sharedCache = createThreadCache()
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
/** A usable session id: a letter or digit first, then letters, digits, dash and underscore, at most 128 (every id DSH makes). No dot or space: nothing that could end a folder name oddly or leave the sessions folder. */
export const isSessionId = (id) => typeof id === 'string' && SESSION_ID.test(id)

const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text.trim()).filter(Boolean).join('\n\n')

/** A record that stands in for older ones (surfaceOp { op: 'replace', ... } on the record, as DSH logs it, or on its data): not a message of its own. */
const isReplacement = (record) => record?.surfaceOp?.op === 'replace' || record?.data?.surfaceOp?.op === 'replace'

/** One record as a message ({ role, text }), or undefined when it carries no chat text. */
function messageOf(record) {
  if (isReplacement(record)) return undefined
  const d = record?.data
  if (record?.type === 'user/message') {
    const kind = d?.source?.kind
    const text = kind === undefined || kind === 'user' ? textOf(d?.content) : ''
    return text ? { role: 'user', text } : undefined
  }
  if (record?.type === 'assistant/message') {
    const text = textOf(d?.message?.content)
    return text ? { role: 'assistant', text } : undefined
  }
  return undefined
}

/**
 * The newest `limit` messages (before the message id `before`, when given) of a log, oldest first.
 * @returns {{ messages: { id: number, role: 'user' | 'assistant', text: string, time?: number, truncated?: true }[], hasMore: boolean, cursor?: number }}
 *   cursor: the id of the oldest message returned, to pass as `before` for the page before it.
 */
export function messagesFromRecords(records, page) {
  return pageOf(chatMessages(records), page)
}

/** Every chat message of some records, ascending, with the id of the first record as firstId (the part of messagesFromRecords worth caching). */
export function chatMessages(records, firstId = 0) {
  const all = []
  for (let i = 0; i < records.length; i++) {
    const m = messageOf(records[i])
    if (!m) continue
    const id = firstId + i
    const time = records[i].time
    const cut = m.text.length > MAX_TEXT
    all.push({ id, role: m.role, text: cut ? m.text.slice(0, MAX_TEXT) : m.text, ...(Number.isFinite(time) ? { time } : {}), ...(cut ? { truncated: true } : {}) })
  }
  return all
}

/** The page of messages: the newest `limit` ones before the id `before`; empty once `before` lies more than MAX_THREAD_DEPTH messages behind the newest. */
export function pageOf(all, { before, limit } = {}) {
  const size = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT) : DEFAULT_LIMIT
  const older = Number.isFinite(before) ? all.filter((m) => m.id < before) : all
  if (all.length - older.length > MAX_THREAD_DEPTH) return { messages: [], hasMore: false }
  const messages = older.slice(-size)
  return { messages, hasMore: older.length > size, ...(messages.length ? { cursor: messages[0].id } : {}) }
}

/** The log file of a session under the sessions folder (the newest when several project folders hold the id), or undefined. */
export async function findSessionLog(root, sessionId, io = {}) {
  if (!isSessionId(sessionId)) return undefined
  const fs = { readdir, stat, ...io }
  let projects
  try { projects = await fs.readdir(root, { withFileTypes: true }) } catch { return undefined }
  let best
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const file = join(root, project.name, sessionId, SESSION_LOG)
    let info
    try { info = await fs.stat(file) } catch { continue }
    if (!best || info.mtimeMs > best.mtimeMs) best = { file, mtimeMs: info.mtimeMs }
  }
  return best?.file
}

const keepNewest = (messages) => (messages.length > MAX_KEPT_MESSAGES ? messages.slice(-MAX_KEPT_MESSAGES) : messages)
const NOTHING_READ = { size: 0, mtimeMs: 0, endOffset: 0, recordCount: 0, count: 0, totalOutput: 0, messages: [] }

/** The bytes [position, position + length) of a file (fewer when the file ends sooner): the default of the ranged read (fs.readFrom). */
async function readRange(file, position, length) {
  const handle = await open(file, 'r')
  try {
    const out = Buffer.alloc(length)
    let got = 0
    while (got < length) {
      const { bytesRead } = await handle.read(out, got, length - got, position + got)
      if (!bytesRead) break
      got += bytesRead
    }
    return got === length ? out : out.subarray(0, got)
  } finally { await handle.close() }
}

/** Whether these bytes can be the start of whole frames: they begin with the zstd magic (or with the first bytes of it, when only those were written yet). */
const startsFrames = (bytes) => ZSTD_MAGIC.subarray(0, bytes.length).equals(bytes.subarray(0, 4))

/**
 * Decodes the frames in `bytes` (a whole log, or what follows the end of the last complete frame) under the size caps; `total` is what earlier
 * reads of the log already decoded, so the total cap counts the whole log. { parsed, tooLarge, total }.
 */
function decodeFrames(bytes, { unzip, maxFrameBytes, maxTotalBytes, total: before }) {
  let tooLarge = false
  let total = before
  const bounded = (frame) => { // a frame over a cap ends the reading at once (parseLogFrames would otherwise retry it joined with the next piece)
    if (tooLarge) throw new RangeError('frame over the cap')
    const room = maxTotalBytes - total
    if (room <= 0) { tooLarge = true; throw new RangeError('log over the total cap') }
    try {
      const out = unzip(frame, { maxOutputLength: Math.min(maxFrameBytes, room) })
      total += out?.length ?? 0
      return out
    } catch (error) { tooLarge = error?.code === 'ERR_BUFFER_TOO_LARGE'; throw error }
  }
  const parsed = parseLogFrames(bytes, { unzip: bounded })
  return { parsed, tooLarge, total }
}

/**
 * The cache entry after `decoded` (the frames that were read from byte offset `from` on) was added to `prev`, and what to answer with: the
 * messages of the complete frames, plus those of a frame that was complete but had a broken line (they are answered, not kept: that frame is read again).
 */
function extend(prev, decoded, { size, mtimeMs, from }) {
  const { records, complete, end } = decoded.parsed
  const stable = chatMessages(records.slice(0, complete), prev.recordCount)
  const tail = chatMessages(records.slice(complete), prev.recordCount + complete)
  const messages = keepNewest(prev.messages.concat(stable))
  const entry = { size, mtimeMs, endOffset: from + end, recordCount: prev.recordCount + complete, count: prev.count + stable.length, totalOutput: decoded.total, messages }
  return { entry, served: tail.length ? keepNewest(messages.concat(tail)) : messages }
}

/**
 * A log that only grew: reads and decodes just the bytes after the end of the last complete frame. { entry, served }, { error: 'too-large' }, or undefined
 * when the file does not look like plain growth of what was read (the bytes at that end do not start a frame, the read came back short or failed):
 * the caller then parses the whole log.
 */
async function grow({ file, info, entry, io, caps }) {
  try {
    const length = info.size - entry.endOffset
    if (length < 0) return undefined
    const bytes = await io.readFrom(file, entry.endOffset, length)
    if (bytes.length !== length || !startsFrames(bytes)) return undefined
    const decoded = decodeFrames(bytes, { ...caps, total: entry.totalOutput })
    if (decoded.tooLarge) return { error: 'too-large' }
    return extend(entry, decoded, { size: info.size, mtimeMs: info.mtimeMs, from: entry.endOffset })
  } catch { return undefined }
}

/**
 * The newest messages of a session's log, ascending: { all } or { error }. One of these runs per log file at a time (cache.flight), whoever asks.
 * A log that is unchanged since the last read is answered from its cache entry; one that grew (a larger file, whose old end is where a frame starts) is read
 * and decoded from the end of the last complete frame on, the record indexes (= message ids) continuing; any other change reads the whole file.
 * Never throws; a log that cannot be read logs "thread: <code>" once.
 */
async function loadMessages({ root, sessionId, io, maxLogBytes, maxFrameBytes, maxTotalBytes, unzip, cache, fileKey, log }) {
  const file = await findSessionLog(root, sessionId, io)
  if (!file) return { error: 'no-log' }
  try {
    const info = await io.stat(file)
    if (info.size > maxLogBytes) return { error: 'too-large' }
    const entry = cache.get(file)
    let served
    let parseMs // how long this read took to parse; unmeasured when the cache answered
    if (entry && entry.size === info.size && entry.mtimeMs === info.mtimeMs) served = entry.messages
    else {
      const began = cache.now()
      const caps = { unzip, maxFrameBytes, maxTotalBytes }
      let next = entry && info.size > entry.size ? await grow({ file, info, entry, io, caps }) : undefined
      if (!next) {
        const decoded = decodeFrames(await io.readFile(file), { ...caps, total: 0 })
        if (!decoded.tooLarge) next = extend(NOTHING_READ, decoded, { size: info.size, mtimeMs: info.mtimeMs, from: 0 })
        else next = { error: 'too-large' }
      }
      if (next.error) return next
      cache.set(file, next.entry)
      served = next.served
      parseMs = cache.now() - began
    }
    cache.remember(fileKey, served, parseMs)
    return { all: served }
  } catch (error) {
    log?.('thread: ' + String(error?.code ?? error?.name ?? 'error').slice(0, 40)) // the code only: an error message can carry a path or content
    return { error: 'unreadable' }
  }
}

/**
 * Reads the thread of a session from disk. A log whose last frame is half written (a live session) gives what was read.
 * Within the window of the last read of that log (max(THREAD_THROTTLE_MS, THREAD_COST_FACTOR x its duration), at most MAX_THREAD_THROTTLE_MS) any page is served from memory without touching the disk; concurrent reads of one log are one read.
 * @param {{ root: string, sessionId: string, before?: number, limit?: number, maxLogBytes?: number, maxFrameBytes?: number, maxTotalBytes?: number, unzip?: Function | null, fs?: object, cache?: object, log?: (line: string) => void }} opts
 * maxLogBytes defaults to DEFAULT_THREAD_LOG_BYTES, maxFrameBytes to MAX_FRAME_OUTPUT, maxTotalBytes to MAX_TOTAL_OUTPUT; cache to a module-wide createThreadCache().
 * log gets one line for a log that could not be read: "thread: <error code or name>", never the message of the error.
 * @returns {Promise<{ ok: true, messages: object[], hasMore: boolean, cursor?: number } | { ok: false, error: 'no-log' | 'too-large' | 'no-zstd' | 'unreadable' }>}
 */
export async function readThread({ root, sessionId, before, limit, maxLogBytes = DEFAULT_THREAD_LOG_BYTES, maxFrameBytes = MAX_FRAME_OUTPUT, maxTotalBytes = MAX_TOTAL_OUTPUT, unzip = zlib.zstdDecompressSync, fs: over = {}, cache = sharedCache, log }) {
  if (typeof unzip !== 'function') return { ok: false, error: 'no-zstd' }
  if (!isSessionId(sessionId)) return { ok: false, error: 'no-log' }
  const fileKey = JSON.stringify([root, sessionId])
  const remembered = cache.recall(fileKey)
  const loaded = remembered ? { all: remembered } : await cache.flight(fileKey, () => loadMessages({ root, sessionId, io: { readFile, readdir, stat, readFrom: readRange, ...over }, maxLogBytes, maxFrameBytes, maxTotalBytes, unzip, cache, fileKey, log }))
  return loaded.error ? { ok: false, error: loaded.error } : { ok: true, ...pageOf(loaded.all, { before, limit }) }
}
