/**
 * Paused sessions: top-level DSH sessions that a restart or crash cut off in the middle of work, found in the persisted
 * session logs (~/.dsh/sessions/--<cwd>--/<id>/session.v4.jsonl.zstd; see the vault note "How To Tell A DSH Session Was
 * Cut Off"). The agent (this plugin) scans at startup and on demand; every cut-off session becomes an open item of type
 * 'paused' that the desktop card can resume or dismiss. A session is cut off when
 *   - its last turn has no turn/end (open-turn), or the last turn/end is 'interrupted' with no later turn (interrupted),
 *   - a message queued for the next turn was never consumed (pending-inbox), or its last log frame is half written (torn).
 * Subagents (origin 'subagent') are never listed. A session that is live now is never listed: an open turn counts only
 * when the log was last written before this app started (a restart) or at least STALE_MS ago, and never for a session
 * this app has seen or has loaded. Reading is cheap: a log is read only when its last-write time is inside the window,
 * the session is not live and the quiet rule holds; the work yields to the event loop between logs.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

/** The prompt that resumes a cut-off session (the only place the text lives). */
export const RESUME_PROMPT = 'Resume the work this session was doing when it was cut off. First check git status and '
  + 'git log in its worktree and the last tool calls, because the last tool may have half-applied, then continue.'
/** An open turn written to less than this long ago is live work, not a cut. */
export const STALE_MS = 2 * 60 * 1000
/** Sessions last written longer ago than this are ignored. */
export const MAX_AGE_MS = 3 * 24 * 3600 * 1000
/** Resume all keeps this many sessions working at a time. */
export const RESUME_CONCURRENCY = 3
export const MAX_LOG_BYTES = 64 * 1024 * 1024
const DISMISS_RETENTION_MS = 7 * 24 * 3600 * 1000
export const SESSION_LOG = 'session.v4.jsonl.zstd'
/** The first bytes of every zstd frame. */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const CLIP = 160

const clip = (s, n = CLIP) => (s.length > n ? s.slice(0, n) + '…' : s)
const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((c) => c?.type === 'text').map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim()

// ---- reading a log -------------------------------------------------------------------------------------------------

/**
 * The records of a log: concatenated zstd frames, one JSON event per line. A decompressor stops after the first frame, so the
 * frames are cut at the zstd magic number; a cut inside a frame (the magic bytes by chance) is repaired by joining the pieces.
 * A frame that cannot be read to the end of the file (a write that was cut short) ends the reading: torn.
 * @returns {{ records: object[], torn: boolean }}
 */
export function parseLog(bytes, opts) {
  const { records, torn } = parseLogFrames(bytes, opts)
  return { records, torn }
}

/**
 * parseLog that also says where the complete frames end: end is the byte offset after the last frame that decoded and whose lines all parsed,
 * complete the number of records up to it. A reader that appends to a log can continue from end later (thread.js); a frame cut short, or one with
 * a broken line, is not counted in either (its records before the break are still in records).
 * @returns {{ records: object[], torn: boolean, end: number, complete: number }}
 */
export function parseLogFrames(bytes, { unzip = zlib.zstdDecompressSync } = {}) {
  if (typeof unzip !== 'function') throw new Error('no zstd codec in this runtime')
  const starts = []
  for (let i = bytes.indexOf(ZSTD_MAGIC); i >= 0; i = bytes.indexOf(ZSTD_MAGIC, i + 4)) starts.push(i)
  if (!starts.length) return { records: [], torn: bytes.length > 0, end: 0, complete: 0 }
  const records = []
  let end = 0
  let complete = 0
  for (let k = 0; k < starts.length; k++) {
    let text
    let frameEnd = 0
    for (let j = k + 1; j <= starts.length && text === undefined; j++) {
      frameEnd = j < starts.length ? starts[j] : bytes.length
      try {
        text = unzip(bytes.subarray(starts[k], frameEnd)).toString('utf8')
        k = j - 1
      } catch { /* a frame cut at a false magic: join the next piece */ }
    }
    if (text === undefined) return { records, torn: true, end, complete }
    for (const line of text.split('\n')) {
      if (!line) continue
      try { records.push(JSON.parse(line)) } catch { return { records, torn: true, end, complete } }
    }
    end = frameEnd
    complete = records.length
  }
  return { records, torn: false, end, complete }
}

// ---- classifying a log ---------------------------------------------------------------------------------------------

/**
 * Folds the records of one session: is its last work cut off, and what did it look like.
 * @returns {{ head?: { id?: string, cwd?: string, origin?: string, parent?: string }, kinds: string[], turn: number,
 *   endKind?: string, pending: number, title?: string, danglingCalls: string[], lastUser: string, lastAssistant: string,
 *   lastTime?: number }}
 */
export function classifyLog(records, { torn = false } = {}) {
  let openTurn = null
  let lastTurn = 0
  let lastEnd = null
  let title
  let lastUser = ''
  let lastAssistant = ''
  const calls = new Map()
  const inbox = []
  for (const r of records) {
    const d = r?.data ?? {}
    switch (r?.type) {
      case 'turn/start': openTurn = d.turn; lastTurn = d.turn; lastEnd = null; calls.clear(); break
      case 'turn/end': openTurn = null; lastEnd = d.reason ?? null; calls.clear(); break
      case 'session/title': title = d.title; break
      case 'user/message': {
        const kind = d.source?.kind
        const text = kind === undefined || kind === 'user' ? textOf(d.content) : ''
        if (text) lastUser = text
        break
      }
      case 'assistant/message': {
        const content = d.message?.content ?? []
        const text = textOf(content)
        if (text) lastAssistant = text
        for (const c of content) if (c?.type === 'tool-call') calls.set(c.id, c.name)
        break
      }
      case 'tool/result': calls.delete(d.message?.source?.callId); break
      case 'step/end': calls.clear(); break
      case 'agent/inbox/spliced':
        // Only what was queued for the next TURN counts: notices left for the next step (hooks, reminders, the working
        // directory) stay in a finished session's inbox all the time and say nothing about a cut.
        if (d.target === 'next-turn') inbox.splice(d.start, d.removedCount ?? 0, ...(d.inserted ?? []))
        break
      default:
    }
  }
  const first = records[0]
  const head = first?.type === 'session'
    ? { id: first.id, cwd: first.cwd, origin: first.origin, parent: first.parentSession }
    : undefined
  const kinds = []
  if (openTurn !== null) kinds.push('open-turn')
  else if (lastEnd?.kind === 'interrupted') kinds.push('interrupted')
  if (inbox.length > 0) kinds.push('pending-inbox')
  if (torn) kinds.push('torn')
  return {
    head, kinds, turn: lastTurn, endKind: lastEnd?.kind, pending: inbox.length, title,
    danglingCalls: [...calls.values()], lastUser: clip(lastUser), lastAssistant: clip(lastAssistant),
    lastTime: records.at(-1)?.time,
  }
}

/** Why a session is listed, in words for the card. */
export function reasonText({ kinds, pending }) {
  const parts = []
  if (kinds.includes('open-turn')) parts.push('Cut off in the middle of a turn')
  if (kinds.includes('interrupted')) parts.push('The last turn was interrupted by a crash or restart')
  if (kinds.includes('pending-inbox')) {
    parts.push(pending + (pending === 1 ? ' queued message never ran' : ' queued messages never ran'))
  }
  if (kinds.includes('torn')) parts.push('The log ends in a half-written entry')
  return parts.join('; ')
}

// ---- scanning the session folders ----------------------------------------------------------------------------------

const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Finds the cut-off top-level sessions under root (the sessions folder).
 * @param {{ root: string, now?: number, startedAt?: number, staleMs?: number, maxAgeMs?: number, liveIds?: Set<string>,
 *   skipIds?: Set<string>, maxLogBytes?: number, unzip?: Function | null, fs?: object }} opts
 *   startedAt: when this app started; a log last written before it was written by a process that is gone.
 *   liveIds: sessions this app has seen or has loaded; skipIds: archived sessions.
 * @returns {Promise<{ ok: true, scanned: number, candidates: object[] } | { ok: false, error: string }>}
 */
export async function scanSessionLogs({
  root, now = Date.now(), startedAt, staleMs = STALE_MS, maxAgeMs = MAX_AGE_MS, liveIds = new Set(),
  skipIds = new Set(), maxLogBytes = MAX_LOG_BYTES, unzip = zlib.zstdDecompressSync, fs: over = {},
}) {
  if (typeof unzip !== 'function') return { ok: false, error: 'no-zstd' }
  const io = { readFile, readdir, stat, ...over }
  let projects
  try { projects = await io.readdir(root, { withFileTypes: true }) } catch { return { ok: false, error: 'no-sessions-dir' } }
  const candidates = []
  let scanned = 0
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let ids
    try { ids = await io.readdir(join(root, project.name)) } catch { continue }
    for (const id of ids) {
      if (liveIds.has(id) || skipIds.has(id)) continue
      const file = join(root, project.name, id, SESSION_LOG)
      let info
      try { info = await io.stat(file) } catch { continue }
      const lastWrite = Math.round(info.mtimeMs)
      if (now - lastWrite > maxAgeMs || info.size > maxLogBytes) continue
      const restarted = startedAt !== undefined && lastWrite < startedAt
      if (!restarted && now - lastWrite < staleMs) continue
      let parsed
      try { parsed = parseLog(await io.readFile(file), { unzip }) } catch { continue }
      scanned++
      await tick()
      const c = classifyLog(parsed.records, { torn: parsed.torn })
      if (!c.head || c.head.origin === 'subagent' || !c.kinds.length) continue
      candidates.push({
        sessionId: id, cwd: c.head.cwd ?? '', title: c.title ?? '', lastWrite, kinds: c.kinds, reason: reasonText(c),
        turn: c.turn, danglingCalls: c.danglingCalls, pending: c.pending, lastUser: c.lastUser, lastAssistant: c.lastAssistant,
      })
    }
  }
  candidates.sort((a, b) => a.lastWrite - b.lastWrite || a.sessionId.localeCompare(b.sessionId))
  return { ok: true, scanned, candidates }
}

// ---- dismissed sessions --------------------------------------------------------------------------------------------

/**
 * Sessions the user dismissed or resumed, by session id and the log's last-write time: a session is quiet while its log has not
 * been written since; a newer write (it ran again and was cut again) is a new case. Persisted through io ({ read, write }).
 */
export function createDismissals({ io, now = Date.now, retentionMs = DISMISS_RETENTION_MS } = {}) {
  let items = {}
  const prune = () => {
    for (const [id, rec] of Object.entries(items)) if (now() - rec.at > retentionMs) delete items[id]
  }
  try {
    const data = JSON.parse(io?.read() ?? 'null')
    if (data?.v === 1 && data.items && typeof data.items === 'object') {
      for (const [id, rec] of Object.entries(data.items)) {
        if (Number.isFinite(rec?.lastWrite) && Number.isFinite(rec?.at)) items[id] = { lastWrite: rec.lastWrite, at: rec.at }
      }
    }
  } catch { items = {} }
  prune()
  return {
    has: (sessionId, lastWrite) => items[sessionId] !== undefined && lastWrite <= items[sessionId].lastWrite,
    add(sessionId, lastWrite) {
      items[sessionId] = { lastWrite: Math.max(lastWrite, items[sessionId]?.lastWrite ?? 0), at: now() }
      prune()
      try { io?.write(JSON.stringify({ v: 1, items })) } catch { /* kept in memory for this run */ }
    },
    get size() { return Object.keys(items).length },
  }
}

// ---- the list ------------------------------------------------------------------------------------------------------

const payloadOf = (c) => ({
  lastWrite: c.lastWrite, kinds: c.kinds, reason: c.reason, turn: c.turn, danglingCalls: c.danglingCalls,
  pending: c.pending, lastUser: c.lastUser, lastAssistant: c.lastAssistant,
})

/**
 * Keeps the open 'paused' items of the store in step with a scan: a new cut-off session gets an item, a changed one is updated in
 * place, one that is not cut off any more (or was dismissed) is resolved. A failed scan changes nothing. Scans never overlap.
 * @param {{ store: any, scan: () => Promise<any>, dismissals: ReturnType<typeof createDismissals>, log?: (line: string) => void }} deps
 */
export function createPausedTracker({ store, scan, dismissals, log = () => {} }) {
  let running
  async function run() {
    let result
    try { result = await scan() } catch (error) {
      log('paused scan failed: ' + String(error?.message ?? error))
      return { ok: false, error: 'scan-failed' }
    }
    if (!result?.ok) return { ok: false, error: result?.error ?? 'scan-failed' }
    const wanted = result.candidates.filter((c) => !dismissals.has(c.sessionId, c.lastWrite))
    const open = new Map(store.list({ status: 'open' }).filter((i) => i.type === 'paused').map((i) => [i.sessionId, i]))
    let added = 0
    let updated = 0
    let resolved = 0
    for (const c of wanted) {
      const have = open.get(c.sessionId)
      open.delete(c.sessionId)
      if (!have) {
        store.add({ type: 'paused', sessionId: c.sessionId, sessionTitle: c.title, workspace: c.cwd, payload: payloadOf(c) })
        added++
      } else if (JSON.stringify(have.payload) !== JSON.stringify(payloadOf(c))) {
        store.update(have.id, { sessionTitle: c.title, workspace: c.cwd, payload: payloadOf(c) })
        updated++
      }
    }
    // A card of the idle check (kinds ['idle']) is about a session that is NOT cut off: the scan never closes it (the user, a resume or the session itself does).
    for (const gone of open.values()) if (!gone.payload?.kinds?.includes('idle') && store.resolve(gone.id, { kind: 'recovered', by: 'scan' })) resolved++
    if (added || resolved) log('paused sessions: ' + added + ' new, ' + resolved + ' no longer cut off')
    return { ok: true, added, updated, resolved, total: wanted.length }
  }
  return {
    scan() {
      running ??= run().finally(() => { running = undefined })
      return running
    },
    /** The item was resumed or dismissed: its session stays out of the list until its log is written again. */
    markHandled(item) {
      if (typeof item?.sessionId === 'string' && Number.isFinite(item.payload?.lastWrite)) {
        dismissals.add(item.sessionId, item.payload.lastWrite)
      }
    },
  }
}
