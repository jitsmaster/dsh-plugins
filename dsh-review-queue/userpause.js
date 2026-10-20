/**
 * Pause all: puts every running top-level session on pause on purpose and remembers which ones, so that after the DSH desktop
 * is closed they come back in the Task list as paused sessions (type 'paused', with the Resume / Resume all buttons).
 *
 * A stop on purpose leaves a log that paused.js does not call cut off (the turn ended cleanly), so the sessions are written to a
 * small record file (paused-by-user.json in the state directory) and the paused scan adds them as extra candidates until the
 * session runs again, is archived, or the record is older than a week. A session that ran again is told by its log's last write
 * (more than RAN_AGAIN_GRACE_MS after the pause).
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const RETENTION_MS = 7 * 24 * 3600 * 1000
/** A log written this long after the pause means the session ran again. */
export const RAN_AGAIN_GRACE_MS = 60_000
/** How long Pause all waits for the cancelled turns to end before it records and quits anyway. */
export const SETTLE_MS = 8000
const POLL_MS = 250
const SESSION_LOG = 'session.v4.jsonl.zstd'
export const PAUSED_BY_USER = 'paused-by-user'
export const REASON = 'Paused on purpose with Pause all and quit'

/** A session of the user's own (not a subagent or a child session): the ones Pause all and the session count are about. */
export const isTopLevel = (i) => !i?.parentSessionId && i?.origin !== 'subagent'

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The remembered pauses, persisted through io ({ read, write }). Shape on disk: { v: 1, items: { [sessionId]: { pausedAt, title, cwd } } }. */
export function createPauseRecord({ io, now = Date.now, retentionMs = RETENTION_MS } = {}) {
  let items = {}
  const prune = () => { for (const [id, rec] of Object.entries(items)) if (now() - rec.pausedAt > retentionMs) delete items[id] }
  const persist = () => { try { io?.write(JSON.stringify({ v: 1, items })) } catch { /* kept in memory for this run */ } }
  try {
    const data = JSON.parse(io?.read() ?? 'null')
    if (data?.v === 1 && data.items && typeof data.items === 'object') {
      for (const [id, rec] of Object.entries(data.items)) {
        if (Number.isFinite(rec?.pausedAt)) items[id] = { pausedAt: rec.pausedAt, title: typeof rec.title === 'string' ? rec.title : '', cwd: typeof rec.cwd === 'string' ? rec.cwd : '' }
      }
    }
  } catch { items = {} }
  prune()
  return {
    /** Remembers sessions: [{ sessionId, title?, cwd? }] paused at pausedAt. */
    add(sessions, pausedAt = now()) {
      for (const s of sessions) items[s.sessionId] = { pausedAt, title: s.title ?? '', cwd: s.cwd ?? '' }
      prune()
      persist()
    },
    forget(sessionId) { if (delete items[sessionId]) persist() },
    entries() { prune(); return Object.entries(items).map(([sessionId, rec]) => ({ sessionId, ...rec })) },
    get size() { return Object.keys(items).length },
  }
}

/** The last-write time of a session's log under the sessions folder (root/--cwd--/<id>/session.v4.jsonl.zstd), or undefined. */
export async function logMtimeOf(root, sessionId, { fs: over = {} } = {}) {
  const io = { readdir, stat, ...over }
  let projects
  try { projects = await io.readdir(root, { withFileTypes: true }) } catch { return undefined }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    try { return Math.round((await io.stat(join(root, project.name, sessionId, SESSION_LOG))).mtimeMs) } catch { /* not in this project folder */ }
  }
  return undefined
}

/**
 * The remembered pauses as paused-scan candidates (the shape scanSessionLogs returns). A session that ran again since the pause, or is
 * skipped (archived), is dropped from the record.
 * @param {{ record: ReturnType<typeof createPauseRecord>, logMtime?: (id: string) => Promise<number | undefined>, skipIds?: Set<string> }} deps
 */
export async function pausedByUserCandidates({ record, logMtime = async () => undefined, skipIds = new Set() }) {
  const out = []
  for (const e of record.entries()) {
    if (skipIds.has(e.sessionId)) { record.forget(e.sessionId); continue }
    let mtime
    try { mtime = await logMtime(e.sessionId) } catch { mtime = undefined }
    if (mtime !== undefined && mtime > e.pausedAt + RAN_AGAIN_GRACE_MS) { record.forget(e.sessionId); continue }
    out.push({
      sessionId: e.sessionId, cwd: e.cwd, title: e.title, lastWrite: e.pausedAt, kinds: [PAUSED_BY_USER], reason: REASON, turn: 0,
      danglingCalls: [], pending: 0, lastUser: '', lastAssistant: '',
    })
  }
  return out
}

/** Adds the remembered pauses to a log scan's result. A session both scans find keeps the scan's details and takes the clearer reason. A failed scan is returned as it is. */
export function mergeCandidates(result, extra) {
  if (!result?.ok || !extra.length) return result
  const byId = new Map(result.candidates.map((c) => [c.sessionId, c]))
  for (const x of extra) {
    const have = byId.get(x.sessionId)
    byId.set(x.sessionId, have ? { ...have, kinds: [...new Set([...have.kinds, PAUSED_BY_USER])], reason: REASON + '; ' + have.reason } : x)
  }
  return { ...result, candidates: [...byId.values()].sort((a, b) => a.lastWrite - b.lastWrite || a.sessionId.localeCompare(b.sessionId)) }
}

/** The running top-level sessions of this app (no subagent or child sessions), from the session controller; throws when the list call fails. */
export async function listRunningSessions(controller, timeoutMs = 15_000) {
  const listed = await controller.list({}, AbortSignal.timeout(timeoutMs))
  return (listed?.items ?? []).filter((i) => i?.running === true && isTopLevel(i))
}

/**
 * Cancels the active turn of every running top-level session, waits (up to settleMs) until they stopped, and remembers them.
 * Never throws. A session that cannot be cancelled is still remembered (it will be cut off by the quit).
 * @param {{ controller: { list: Function, cancel: Function }, record: ReturnType<typeof createPauseRecord>, titlesOf?: (ids: string[]) => Promise<Map<string, string>>,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>, settleMs?: number, pollMs?: number, log?: (line: string) => void }} deps
 * @returns {Promise<{ ok: true, paused: number, stillRunning: number, sessions: object[] } | { ok: false, error: string }>}
 */
export async function pauseRunningSessions({ controller, record, titlesOf, now = Date.now, sleep = sleepFor, settleMs = SETTLE_MS, pollMs = POLL_MS, log = () => {} }) {
  if (typeof controller?.list !== 'function' || typeof controller?.cancel !== 'function') return { ok: false, error: 'no-controller' }
  const running = () => listRunningSessions(controller)
  let before
  try { before = await running() } catch (error) { return { ok: false, error: 'cannot list sessions: ' + String(error?.message ?? error).slice(0, 160) } }
  const ids = before.map((i) => String(i.sessionId))
  await Promise.all(ids.map(async (sessionId) => {
    try { await controller.cancel({ sessionId }) } catch (error) { log('pause all: cancel of ' + sessionId + ' failed: ' + String(error?.message ?? error)) }
  }))
  let left = ids.length
  for (let waited = 0; left > 0 && waited < settleMs; waited += pollMs) {
    await sleep(pollMs)
    try { left = (await running()).filter((i) => ids.includes(String(i.sessionId))).length } catch { break }
  }
  let titles = new Map()
  try { if (titlesOf && ids.length) titles = await titlesOf(ids) } catch { /* titles are a bonus */ }
  const sessions = before.map((i) => ({ sessionId: String(i.sessionId), title: titles.get(String(i.sessionId)) ?? '', cwd: typeof i.cwd === 'string' ? i.cwd : '' }))
  record.add(sessions, now())
  log('pause all: ' + sessions.length + ' session(s) paused, ' + left + ' still running after ' + settleMs + ' ms')
  return { ok: true, paused: sessions.length, stillRunning: left, sessions }
}
