/**
 * Idle-session ask: every check (default 10 minutes) looks at the sessions that are NOT working and have been idle for more than an hour of
 * awake time, and asks the user, inside that session, whether to continue it or archive it.
 *   - Idle means: top-level, no turn running, no child session running, not blank, not archived, not on hold, no open question or permission card.
 *   - Awake time: the time the laptop slept is not counted. A heartbeat (every BEAT_MS) that finds a gap longer than SLEEP_GAP_MS records the gap as sleep.
 *   - The session is prompted (queued) with ASK_PROMPT: it asks with ask_user_question. Continue marked recommended (only when its work is unfinished) is
 *     asked with a timeout, so the existing auto-answer takes the recommended option; no recommended option means no timeout: the question waits forever.
 *   - An answered question that contains "archive" archives the session (registry.archiveSession); "continue" needs nothing, the session carries on itself.
 * Every idle state (session id + updatedAt) is asked once; the asks are saved through io, so a restart asks nothing twice.
 */
import { randomUUID } from 'node:crypto'
import { isTopLevel } from './userpause.js'

export const ASK_IDLE_MS = 60 * 60_000
export const ASK_CHECK_MS = 10 * 60_000
export const BEAT_MS = 30_000
/** A heartbeat gap longer than this means the machine slept (or the process was frozen). */
export const SLEEP_GAP_MS = 2 * 60_000
export const MAX_AGE_MS = 3 * 24 * 3600_000
export const MAX_PER_PASS = 5
const RETENTION_MS = 7 * 24 * 3600_000
const LIST_TIMEOUT_MS = 10_000
const PROMPT_TIMEOUT_MS = 15_000
const NOT_FOUND = 'session/not-found'

export const ASK_PROMPT = 'This session has been idle for more than an hour. Call ask_user_question once and ask me whether to continue this session or archive it, with the options '
  + '"Continue" and "Archive". Put "Continue" first and add "(Recommended)" to its label ONLY if your work here is unfinished and needs nobody\'s answer; in that case pass timeout 600. '
  + 'If the work is finished or you are waiting for me, recommend nothing and pass no timeout, so the question waits for me. '
  + 'If I pick Continue, check git status and the last tool calls and carry on with the task; start nothing new. If I pick Archive, reply with one line that the session is being archived and stop.'

/** Tracks the time the machine slept: beat() is called often; a long gap between two beats is a sleep. */
export function createSleepTracker({ now = Date.now, gapMs = SLEEP_GAP_MS, io } = {}) {
  let intervals = []
  let last
  try { const d = JSON.parse(io?.read?.() ?? 'null'); if (d?.v === 1 && Array.isArray(d.intervals)) intervals = d.intervals.filter((i) => Number.isFinite(i?.from) && Number.isFinite(i?.to) && i.to > i.from) } catch { intervals = [] }
  const save = () => { try { io?.write?.(JSON.stringify({ v: 1, intervals })) } catch { /* memory only */ } }
  return {
    beat() {
      const t = now()
      if (last !== undefined && t - last > gapMs) {
        intervals.push({ from: last, to: t })
        intervals = intervals.filter((i) => t - i.to < RETENTION_MS)
        save()
      }
      last = t
    },
    /** Milliseconds of recorded sleep inside [from, to]. */
    sleptBetween(from, to) {
      let total = 0
      for (const i of intervals) total += Math.max(0, Math.min(to, i.to) - Math.max(from, i.from))
      return total
    },
  }
}

const archiveWanted = (item) => (item?.resolution?.answers ?? []).some((a) => [...(Array.isArray(a?.selected) ? a.selected : []), a?.custom].some((s) => typeof s === 'string' && /archive/i.test(s)))

export function createIdleAsker({ controllerOf, registryOf = () => undefined, store, sleep, heldIds = () => new Set(), now = Date.now, idleMs = ASK_IDLE_MS, maxAgeMs = MAX_AGE_MS,
  maxPerPass = MAX_PER_PASS, io, log = () => {} }) {
  let state = {} // sessionId -> { updatedAt, at, archived? }
  try {
    const d = JSON.parse(io?.read?.() ?? 'null')
    if (d?.v === 1 && d.items && typeof d.items === 'object') for (const [id, r] of Object.entries(d.items)) if (Number.isFinite(r?.updatedAt) && Number.isFinite(r?.at)) state[id] = { updatedAt: r.updatedAt, at: r.at, archived: r.archived === true }
  } catch { state = {} }
  const save = () => {
    for (const [id, r] of Object.entries(state)) if (now() - r.at > RETENTION_MS) delete state[id]
    try { io?.write?.(JSON.stringify({ v: 1, items: state })) } catch { /* memory only */ }
  }
  const reasonOf = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200)
  const waiting = (id) => (store?.list?.({ status: 'open' }) ?? []).some((i) => i.sessionId === id && (i.type === 'question' || i.type === 'permission'))

  /** Awake idle time of a session: wall time since its last update minus the machine's sleep. */
  const awakeIdle = (updatedAt) => now() - updatedAt - (sleep?.sleptBetween(updatedAt, now()) ?? 0)

  async function run() {
    const controller = controllerOf()
    if (typeof controller?.list !== 'function' || typeof controller?.prompt !== 'function') return { ok: false, error: 'no-controller' }
    let items
    try { items = (await controller.list({}, AbortSignal.timeout(LIST_TIMEOUT_MS)))?.items } catch (error) { log('idle-ask: listing the sessions failed: ' + reasonOf(error)); return { ok: false, error: 'list-failed' } }
    if (!Array.isArray(items)) return { ok: false, error: 'list-failed' }
    const archived = new Set((() => { try { return registryOf()?.archivedSessionIds ?? [] } catch { return [] } })().map(String))
    const busyParents = new Set(items.filter((i) => i?.running === true && i.parentSessionId).map((i) => String(i.parentSessionId)))
    const held = heldIds()
    const t = now()
    const candidates = items
      .filter((i) => i && typeof i.sessionId === 'string' && isTopLevel(i) && i.running !== true && i.blank !== true && !archived.has(i.sessionId) && !held.has(i.sessionId) && !busyParents.has(i.sessionId)
        && Number.isFinite(i.updatedAt) && t - i.updatedAt <= maxAgeMs && awakeIdle(i.updatedAt) >= idleMs && state[i.sessionId]?.updatedAt !== i.updatedAt && !waiting(i.sessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxPerPass)
    const result = { ok: true, asked: [] }
    for (const item of candidates) {
      try {
        await controller.prompt({ requestId: 'idle-ask-' + randomUUID(), sessionId: item.sessionId, mode: 'queue', content: [{ type: 'text', text: ASK_PROMPT }] }, AbortSignal.timeout(PROMPT_TIMEOUT_MS))
      } catch (error) {
        if (error?.code === NOT_FOUND) { state[item.sessionId] = { updatedAt: item.updatedAt, at: now() }; save() }
        log('idle-ask: asking ' + item.sessionId + ' failed: ' + reasonOf(error))
        continue
      }
      state[item.sessionId] = { updatedAt: item.updatedAt, at: now() }
      save()
      result.asked.push(item.sessionId)
      log('idle-ask: asked ' + item.sessionId + ' (idle ' + Math.round(awakeIdle(item.updatedAt) / 60_000) + ' min awake)')
    }
    return result
  }

  /** Archives the asked sessions whose question the user answered with Archive (once per ask). */
  async function archiveAnswered() {
    const done = []
    for (const item of store?.list?.({}) ?? []) {
      const rec = state[item.sessionId]
      if (!rec || rec.archived || item.type !== 'question' || item.status === 'open' || item.createdAt < rec.at || !archiveWanted(item)) continue
      const registry = registryOf()
      if (typeof registry?.archiveSession !== 'function') continue
      rec.archived = true
      save()
      try { await registry.archiveSession(item.sessionId, { stopActivity: true }); done.push(item.sessionId); log('idle-ask: archived ' + item.sessionId + ' on your answer') } catch (error) { log('idle-ask: archiving ' + item.sessionId + ' failed: ' + reasonOf(error)) }
    }
    return done
  }

  let running
  return {
    /** One pass: { ok: true, asked: [sessionId] } | { ok: false, error }. Passes never overlap. */
    check() {
      running ??= run().then(async (r) => { await archiveAnswered(); return r }).catch((error) => { log('idle-ask: check failed: ' + reasonOf(error)); return { ok: false, error: 'check-failed' } }).finally(() => { running = undefined })
      return running
    },
    archiveAnswered,
  }
}
