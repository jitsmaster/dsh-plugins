/**
 * Busy tracking for the idle checks: a session is idle only when nothing is working in it. Busy means: a turn running, a tool call without a result,
 * a prompt queued for the next turn, a running child session (sub-agent), a background job not collected or killed, or an open question/permission
 * card. The idle clock starts at the LAST moment the session was busy, not at its last message.
 */
import { liveBackgroundJobs } from './idle-resume.js'

/** Record types that are real work; a title or metadata record does not move the idle start. */
const WORK = new Set(['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'tool/ptc-dispatch', 'step/end', 'agent/inbox/spliced'])

/**
 * Folds a session log: is work still in it, and when was the last record?
 * Turns and calls from before the app started (startedAt) are stale (a restart ended them), not work.
 * @returns {{ busy: boolean, lastTime?: number }}
 */
export function logBusy(records, { startedAt = 0, now = Date.now } = {}) {
  let openTurn = null // time the open turn started
  const calls = new Map() // callId -> time
  const inbox = []
  let inboxAt = 0
  let lastTime
  const list = Array.isArray(records) ? records : []
  for (const r of list) {
    const d = r?.data ?? {}
    const time = Number.isFinite(r?.time) ? r.time : 0
    if (WORK.has(r?.type) && Number.isFinite(r?.time) && r.time <= now() + 60_000) lastTime = r.time
    switch (r?.type) {
      case 'turn/start': openTurn = time; calls.clear(); break
      case 'turn/end': openTurn = null; calls.clear(); break
      case 'assistant/message': for (const c of d.message?.content ?? []) if (c?.type === 'tool-call') calls.set(c.id, time); break
      case 'tool/result': calls.delete(d.message?.source?.callId); break
      case 'step/end': calls.clear(); break
      case 'agent/inbox/spliced': if (d.target === 'next-turn' && Number.isInteger(d.start) && d.start >= 0 && Array.isArray(d.inserted) && d.inserted.length < 1000) { inbox.splice(d.start, d.removedCount ?? 0, ...d.inserted); inboxAt = time } break
      default:
    }
  }
  const fresh = (time) => time >= startedAt
  const busy = (openTurn !== null && fresh(openTurn))
    || [...calls.values()].some(fresh)
    || (inbox.length > 0 && fresh(inboxAt))
    || liveBackgroundJobs(list, { startedAt }).length > 0
  return { busy, lastTime }
}

/**
 * @param {{ now?: () => number, waitingOf?: (id: string) => boolean, readLog?: (id: string) => Promise<{ records: object[] } | undefined>, startedAt?: number }} deps
 */
export function createBusyTracker({ now = Date.now, waitingOf = () => false, readLog, startedAt = 0 } = {}) {
  const busyAt = new Map() // sessionId -> last time seen busy
  return {
    /** Samples the session list: records the sessions that are busy right now. */
    observe(items) {
      const list = (Array.isArray(items) ? items : []).filter(Boolean)
      const parents = new Set(list.filter((i) => i.running === true && i.parentSessionId).map((i) => String(i.parentSessionId)))
      const t = now()
      const ids = new Set(list.map((i) => i.sessionId))
      for (const id of [...busyAt.keys()]) if (!ids.has(id)) busyAt.delete(id)
      for (const i of list) {
        if (typeof i.sessionId !== 'string') continue
        let waiting = false
        try { waiting = waitingOf(i.sessionId) === true } catch { waiting = false }
        if (i.running === true || parents.has(i.sessionId) || waiting) busyAt.set(i.sessionId, t)
      }
    },
    /** The idle start from the list data: the later of the last update and the last busy sample. */
    sinceOf(item) { return Math.max(Number.isFinite(item?.updatedAt) ? item.updatedAt : 0, busyAt.get(item?.sessionId) ?? 0) },
    /** Adds the log: { busy, since }. A log that cannot be read counts as busy. */
    async inspect(item) {
      const since = this.sinceOf(item)
      if (!readLog) return { busy: false, since }
      try {
        const log = await readLog(item.sessionId)
        if (!log) return { busy: true, since }
        const r = logBusy(log.records, { startedAt, now })
        return { busy: r.busy, since: Math.max(since, Number.isFinite(r.lastTime) ? r.lastTime : 0) }
      } catch { return { busy: true, since } }
    },
  }
}
