/**
 * A sliding-window rate limiter keyed by string (a device, an address, "global"). take() either lets the call through and counts
 * it, or refuses it and says how long until the oldest counted call leaves the window; a refused call is not counted, so hammering
 * does not extend the wait. At most maxKeys keys are remembered (the least recently used go first), so memory stays bounded.
 */
export function createRateLimiter({ now = Date.now, limit, windowMs, maxKeys = 1000 }) {
  /** @type {Map<string, number[]>} insertion order = least recently used first */
  const hits = new Map()

  return {
    /** @returns {{ ok: true } | { ok: false, retryAfterMs: number }} */
    take(key) {
      const t = now()
      const recent = (hits.get(key) ?? []).filter((at) => at > t - windowMs)
      hits.delete(key)
      if (recent.length >= limit) {
        hits.set(key, recent)
        return { ok: false, retryAfterMs: recent[0] + windowMs - t }
      }
      recent.push(t)
      hits.set(key, recent)
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value)
      return { ok: true }
    },
    size: () => hits.size,
  }
}
