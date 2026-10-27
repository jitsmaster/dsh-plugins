/**
 * Whether a session is the poll session of a pull request that is still open. Archiving such a session silently ends the
 * PR comment poll, so every archive path asks this first (see README, "Archiving PR sessions").
 *
 * A PR that is completed, abandoned or does not exist is not protected. A status that cannot be read (network, no token, odd answer) counts
 * as still open: a hiccup must never let the session be lost. Statuses are cached for a minute, a final one for good.
 */
const TTL_MS = 60_000
/** Most statuses kept; the oldest goes first. */
const MAX_CACHED = 500
/** Statuses that settle it for good: the PR is over, or this repository has no such PR (a stray "PR <n>" title). */
const FINAL = new Set(['completed', 'abandoned', 'notFound'])

/**
 * @param {object} deps
 * @param {() => boolean} [deps.enabled] - the protectPrSessions setting.
 * @param {(sessionId: string) => Promise<string | undefined> | string | undefined} deps.prIdOf - the PR a session polls, if any.
 * @param {(prId: string) => Promise<string | undefined>} deps.statusOf - the Azure DevOps status of the PR ("notFound" for HTTP 404); may throw.
 * @param {(prId: string) => boolean} [deps.finished] - PRs already known to be over (no lookup needed).
 */
export function createPrArchiveGuard({ enabled = () => true, prIdOf, statusOf, finished = () => false, now = Date.now, ttlMs = TTL_MS, maxCached = MAX_CACHED }) {
  /** prId -> { status, at } of the last successful lookup. */
  const cache = new Map()
  /** prId -> the lookup in flight, shared by concurrent checks. */
  const inflight = new Map()

  async function statusFor(prId) {
    const hit = cache.get(prId)
    if (hit && (FINAL.has(hit.status) || now() - hit.at < ttlMs)) return hit.status
    if (!inflight.has(prId)) {
      const lookup = Promise.resolve().then(() => statusOf(prId)).then((status) => {
        const value = typeof status === 'string' ? status : 'unknown'
        if (value !== 'unknown') {
          cache.delete(prId) // re-inserted last, so Map order is age order
          cache.set(prId, { status: value, at: now() })
          while (cache.size > maxCached) cache.delete(cache.keys().next().value)
        }
        return value
      }, () => 'unknown').finally(() => inflight.delete(prId))
      inflight.set(prId, lookup)
    }
    return inflight.get(prId)
  }

  return {
    /** { protected, prId?, status? }; never rejects. */
    async check(sessionId) {
      if (!enabled()) return { protected: false }
      let prId
      try { prId = await prIdOf(String(sessionId)) } catch { return { protected: false } }
      if (!prId) return { protected: false }
      prId = String(prId)
      if (finished(prId)) return { protected: false, prId }
      const status = await statusFor(prId)
      return { protected: !FINAL.has(status), prId, status }
    },
  }
}
