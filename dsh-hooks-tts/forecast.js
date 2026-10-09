/**
 * Estimates how much context the next chunk of work (one turn) will add, so a session can hand off BEFORE it
 * starts a turn that would run past the limit, instead of being cut off in the middle of it.
 * The estimate is the largest growth of the session's last few finished turns: crude, but it follows the
 * kind of work the session is doing, and it stays quiet until it has seen enough turns.
 */
const KEEP = 3
const MIN_SAMPLES = 2

export function createGrowthTracker() {
  /** session id -> { started?: number, growths: number[] } */
  const sessions = new Map()
  const entry = (id) => { let e = sessions.get(id); if (!e) sessions.set(id, e = { growths: [] }); return e }
  return {
    turnStart(id, tokens) { entry(id).started = tokens },
    turnEnd(id, tokens) {
      const e = entry(id)
      if (e.started === undefined) return // no start seen (session opened mid-turn, restart): nothing to measure
      const growth = tokens - e.started
      e.started = undefined
      if (growth < 0) { e.growths = []; return } // compaction or a new baseline: earlier growths no longer apply
      e.growths.push(growth)
      if (e.growths.length > KEEP) e.growths.shift()
    },
    /** Tokens the next turn is expected to add; undefined until MIN_SAMPLES turns have finished. */
    estimate(id) {
      const g = sessions.get(id)?.growths ?? []
      return g.length >= MIN_SAMPLES ? Math.max(...g) : undefined
    },
    forget(id) { sessions.delete(id) },
  }
}

/** The limit the next turn must fit under: the cap, or the model window when that is smaller. */
export function effectiveLimit(cap, window) {
  return window && window > 0 ? Math.min(cap, window) : cap
}

/** True when the context is still under the limit but the estimated next turn would use up what is left. */
export function handOffAhead({ tokens, limit, estimate }) {
  return estimate !== undefined && estimate > 0 && tokens < limit && estimate >= limit - tokens
}
