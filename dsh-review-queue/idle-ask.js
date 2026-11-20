/**
 * Idle-session ask: every check (default 10 minutes) looks at the sessions that are NOT working and have been idle for more than an hour of
 * awake time, and asks the user, inside that session, whether to continue it or archive it.
 *   - Idle means: top-level, no turn running, no child session (agent) running, no background job left (when readLog is given; a log that cannot be read
 *     counts as busy), not blank, not archived, not on hold, no open question or permission card.
 *   - Awake time: the time the laptop slept is not counted. A heartbeat (every BEAT_MS) that finds a gap longer than SLEEP_GAP_MS records the gap as sleep.
 *   - The session is prompted (queued) with ASK_PROMPT: it asks with ask_user_question. Continue marked recommended (only when its work is unfinished) is
 *     asked with a timeout, so the existing auto-answer takes the recommended option; no recommended option means no timeout: the question waits forever.
 *   - The idle hour starts at the LAST moment the session was busy (idle-busy.js: turn, tool call, queued prompt, child session, background job, open card), not at its last message.
 *   - A session tied to an open PR is never asked (the dsh-hooks-tts PR guard decides). Without a guard, or when it throws, a session whose title names a PR ("PR 6554", "... - after PR 6554") is skipped instead.
 *   - An answered question that contains "archive" archives the session (registry.archiveSession), unless it polls a PR that is still open (the guard answers); "continue" needs nothing, the session carries on itself.
 * Every idle state (session id + updatedAt) is asked once; the asks are saved through io, so a restart asks nothing twice.
 */
import { randomUUID } from 'node:crypto'
import { isTopLevel } from './userpause.js'
import { createBusyTracker } from './idle-busy.js'

export const ASK_IDLE_MS = 60 * 60_000
export const ASK_CHECK_MS = 10 * 60_000
export const BEAT_MS = 30_000
/** A heartbeat gap longer than this means the machine slept (or the process was frozen). */
export const SLEEP_GAP_MS = 2 * 60_000
export const MAX_AGE_MS = 3 * 24 * 3600_000
export const MAX_PER_PASS = 5
const MAX_LOG_READS = 50
const RETENTION_MS = 7 * 24 * 3600_000
const LIST_TIMEOUT_MS = 10_000
const PROMPT_TIMEOUT_MS = 15_000
/** A PR guard check can be an Azure DevOps request: a hung one protects the session and cannot stall the asker. */
const GUARD_TIMEOUT_MS = 10_000
const GUARD_TIMED_OUT = Symbol('guard timed out')
const NOT_FOUND = 'session/not-found'

export const ASK_PROMPT = 'This session has been idle for more than an hour. Call ask_user_question once and ask me whether to continue this session or archive it, with the options '
  + '"Continue" and "Archive". Put "Continue" first and add "(Recommended)" to its label ONLY if your work here is unfinished and needs nobody\'s answer; in that case pass timeout 600. '
  + 'If the work is finished or you are waiting for me, recommend nothing and pass no timeout, so the question waits for me. '
  + 'If you call it from inside run_code, give that run_code call timeoutMs 600000, because its default deadline of 2 minutes would kill the question; if the run still times out, ask it once more. '
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

/** A session title that names a pull request: "PR 6554", "PR 6554 - Fix: ...", "... - after PR 6554". Such a session belongs to the PR poller. */
export const isPrTitle = (title) => /\bPR\s*#?\d+/i.test(String(title ?? ''))
const titleOf = (item) => { const v = item?.projections?.values?.title; return typeof v === 'string' ? v : (typeof item?.title === 'string' ? item.title : '') }

const archiveWanted = (item) => (item?.resolution?.answers ?? []).some((a) => [...(Array.isArray(a?.selected) ? a.selected : []), a?.custom].some((s) => typeof s === 'string' && /archive/i.test(s)))

export function createIdleAsker({ controllerOf, registryOf = () => undefined, prGuardOf = () => undefined, store, sleep, heldIds = () => new Set(), now = Date.now, idleMs = ASK_IDLE_MS, maxAgeMs = MAX_AGE_MS,
  maxPerPass = MAX_PER_PASS, io, log = () => {}, readLog, startedAt = 0, guardTimeoutMs = GUARD_TIMEOUT_MS }) {
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
  // Sessions with an open question or permission card: listed once per pass or sample (refreshWaiting), not once per session.
  const waitingNow = () => new Set((store?.list?.({ status: 'open' }) ?? []).filter((i) => i.type === 'question' || i.type === 'permission').map((i) => i.sessionId))
  let waitingSet
  const refreshWaiting = () => { try { waitingSet = waitingNow() } catch { waitingSet = undefined } }
  const waiting = (id) => (waitingSet ?? waitingNow()).has(id)

  /** Awake idle time of a session: wall time since its last update minus the machine's sleep. */
  const awakeIdle = (updatedAt) => now() - updatedAt - (sleep?.sleptBetween(updatedAt, now()) ?? 0)

  /** Was this idle state asked already? Same busy-since, or (state saved before the busy clock) nothing newer than the ask itself. */
  const askedFor = (id, since) => { const prev = state[id]; return !!prev && (prev.updatedAt === since || since <= prev.at) }

  // The idle clock starts at the last moment the session was busy (turn, tool call, queued prompt, child session, background job, open card), not at its last message.
  const busy = createBusyTracker({ now, waitingOf: waiting, readLog, startedAt })

  async function list() {
    const controller = controllerOf()
    if (typeof controller?.list !== 'function') return undefined
    try { const items = (await controller.list({}, AbortSignal.timeout(LIST_TIMEOUT_MS)))?.items; return Array.isArray(items) ? items : undefined } catch { return undefined }
  }

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
    refreshWaiting()
    busy.observe(items)
    const idle = items
      .filter((i) => i && typeof i.sessionId === 'string' && isTopLevel(i) && i.running !== true && i.blank !== true && !archived.has(i.sessionId) && !held.has(i.sessionId) && !busyParents.has(i.sessionId)
        && Number.isFinite(i.updatedAt) && t - i.updatedAt <= maxAgeMs && awakeIdle(busy.sinceOf(i)) >= idleMs && !askedFor(i.sessionId, busy.sinceOf(i)) && !waiting(i.sessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt)

    const result = { ok: true, asked: [], skipped: [] }
    let inspected = 0
    for (const raw of idle) {
      if (result.asked.length >= maxPerPass || inspected >= MAX_LOG_READS) break // only the asks are limited; busy sessions cost a log read but not an ask
      // A session tied to a PR that is not merged or abandoned yet (it created it, waits for it, polls it or cleans it up) is never asked: it is idle on purpose.
      // A missing or throwing guard falls back to the PR title (see prOpenOf).
      inspected++ // guard calls count toward the cap too (each can be a network request), not only log reads
      if (await prOpenOf(raw.sessionId, titleOf(raw))) continue
      const seen = await busy.inspect(raw)
      if (seen.busy) { result.skipped.push(raw.sessionId); continue }
      if (awakeIdle(seen.since) < idleMs || askedFor(raw.sessionId, seen.since)) continue
      const item = { ...raw, updatedAt: seen.since } // the idle state is keyed on the last busy moment
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

  /**
   * The guard's verdict when the session polls a PR that is still open (dsh-hooks-tts's prArchiveGuard). The guard is the authority when it answers.
   * Without it (plugin missing) or when it throws, nothing is known, so a session whose title names a PR ("PR 6554", "... - after PR 6554")
   * is still treated as protected: its poller is the reason it is idle. With protectPrSessions off the guard answers "not protected" and that stands.
   * A guard that does not answer within guardTimeoutMs protects the session (cannot tell = open).
   */
  const prOpenOf = async (sessionId, title) => {
    try {
      const guard = prGuardOf()
      if (typeof guard?.check === 'function') {
        let timer
        const late = new Promise((resolve) => { timer = setTimeout(() => resolve(GUARD_TIMED_OUT), guardTimeoutMs); timer.unref?.() })
        const v = await Promise.race([Promise.resolve(guard.check(sessionId)), late]).finally(() => clearTimeout(timer))
        if (v === GUARD_TIMED_OUT) return { protected: true, prId: '?', status: 'unknown' } // cannot tell: treated as open, like the guard's own unreadable status
        return v?.protected ? v : undefined
      }
    } catch { /* the guard failed: fall back to the title below */ }
    return isPrTitle(title) ? { protected: true, prId: /\bPR\s*#?(\d+)/i.exec(title)[1], status: 'title' } : undefined
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
      const open = await prOpenOf(item.sessionId, item.sessionTitle)
      if (open) { log('idle-ask: not archived ' + item.sessionId + ': ' + (open.status === 'handover' ? 'hand-over of PR ' + open.prId + ' is in progress' : 'PR ' + open.prId + ' is still open')); continue }
      try { await registry.archiveSession(item.sessionId, { stopActivity: true }); done.push(item.sessionId); log('idle-ask: archived ' + item.sessionId + ' on your answer') } catch (error) { log('idle-ask: archiving ' + item.sessionId + ' failed: ' + reasonOf(error)) }
    }
    return done
  }

  let running
  let sampling
  return {
    /** One pass: { ok: true, asked: [sessionId] } | { ok: false, error }. Passes never overlap. */
    check() {
      running ??= run().then(async (r) => { await archiveAnswered(); return r }).catch((error) => { log('idle-ask: check failed: ' + reasonOf(error)); return { ok: false, error: 'check-failed' } }).finally(() => { running = undefined })
      return running
    },
    archiveAnswered,
    /** A cheap busy sample (the session list only), run often between checks so a busy state is not missed. */
    sample() {
      sampling ??= list().then((items) => { if (items) { refreshWaiting(); busy.observe(items) } }).finally(() => { sampling = undefined })
      return sampling
    },
  }
}
