/**
 * "N working / M open": how many sessions of this DSH app have a turn running (working) and how many are open (every top-level session that is
 * not archived, not blank). The numbers come from the session controller's list, the same one Pause all uses (userpause.js), so a session is "top level" by
 * the same rule. A list call is not free, so the answer is cached for 2 s and one call is in flight at most.
 *
 * Nobody is asked while nobody looks: the list is only fetched when touch() was called in the last 60 s (a snapshot request of an open overlay or of the
 * phone, or the hub saying somebody looks); the last numbers stay meanwhile. current() never waits: it gives the last numbers (undefined while they are
 * unknown: no controller, or no answer yet) and starts a refresh when they are older than the cache time. refresh() is what a timer can call. Listeners hear a change of the numbers only, at most once per minEmitMs (a change
 * that comes sooner is told by the next refresh after that); a count change never touches the queue's snapshotId.
 */
import { isTopLevel } from './userpause.js'

export const SESSIONS_TTL_MS = 2000
export const SESSIONS_MIN_EMIT_MS = 3000
export const SESSIONS_INTEREST_MS = 60_000
export const SESSIONS_LIST_GRACE_MS = 1000 // a list call that ignores its signal is given up this long after the signal's time
const LIST_TIMEOUT_MS = 10_000

const safe = (fn) => { try { return fn() } catch { return undefined } }
/** "<working>/<open>" of the numbers, '' while they are unknown: the one form of them that long-poll tokens, the agent and the hub compare. */
export const sessionsKey = (v) => (Number.isFinite(v?.working) && Number.isFinite(v?.open) ? v.working + '/' + v.open : '')

/**
 * @param {{ controllerOf: () => any, registryOf?: () => any, now?: () => number, ttlMs?: number, minEmitMs?: number, timeoutMs?: number, log?: (line: string) => void }} deps
 * @returns {{ current: () => { working: number, open: number } | undefined, refresh: () => Promise<void>, onChange: (l: () => void) => () => void }}
 */
export function createSessionCounter({ controllerOf, registryOf = () => undefined, now = Date.now, ttlMs = SESSIONS_TTL_MS, minEmitMs = SESSIONS_MIN_EMIT_MS, interestMs = SESSIONS_INTEREST_MS, timeoutMs = LIST_TIMEOUT_MS, graceMs = SESSIONS_LIST_GRACE_MS, log = () => {} }) {
  let value
  let startedAt = -Infinity
  let touchedAt = -Infinity // when somebody last looked
  let inflight
  let generation = 0 // a call that was given up has an older number: its late answer is ignored
  let lastEmitAt = -Infinity
  let dirty = false // a change that was not told yet (it came inside the rate limit)
  const listeners = new Set()

  const emit = () => {
    lastEmitAt = now()
    dirty = false
    for (const l of [...listeners]) { try { l() } catch { /* one bad listener must not stop the others */ } }
  }

  async function load() {
    const controller = safe(controllerOf)
    if (typeof controller?.list !== 'function') { value = undefined; return }
    const listed = await controller.list({}, AbortSignal.timeout(timeoutMs))
    const archived = new Set((safe(() => registryOf()?.archivedSessionIds) ?? []).map(String))
    if (!Array.isArray(listed?.items)) return undefined
    // A session entry: an object with an id, top level, not blank (a session running its first turn is not blank in the Host list), not archived. Anything else is skipped, never thrown on.
    const open = listed.items.filter((i) => i && typeof i === 'object' && typeof i.sessionId === 'string' && isTopLevel(i) && i.blank !== true && !archived.has(i.sessionId))
    return { working: open.filter((i) => i.running === true).length, open: open.length }
  }

  async function run(mine) {
    const before = sessionsKey(value)
    try {
      const next = await load()
      if (mine !== generation) return
      if (next) value = next
    } catch (error) {
      if (mine !== generation) return
      // The code only: an error message can carry a path or content. The last known numbers stay.
      log('sessions: count failed (' + String(error?.code ?? error?.name ?? 'error').slice(0, 40) + ')')
    }
    if (sessionsKey(value) !== before) dirty = true
    if (dirty && now() - lastEmitAt >= minEmitMs) emit()
  }

  function refresh() {
    if (inflight) return inflight
    if (now() - touchedAt > interestMs || now() - startedAt < ttlMs) return Promise.resolve()
    startedAt = now()
    const mine = ++generation
    // The call is bounded by its signal, but a controller may ignore it: without this limit one call that never answers would freeze the numbers for good.
    let timer
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => { log('sessions: count failed (timeout)'); resolve() }, timeoutMs + graceMs)
      timer.unref?.()
    })
    inflight = Promise.race([run(mine), limit]).finally(() => { clearTimeout(timer); if (generation === mine) inflight = undefined })
    return inflight
  }

  return {
    /** Somebody looks at the numbers now (keeps them fresh for the next minute). */
    touch() { touchedAt = now() },
    current() {
      void refresh()
      return value
    },
    refresh,
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
