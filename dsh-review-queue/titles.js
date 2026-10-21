/**
 * titlesOf(ids) -> Map(id -> title) for the session titles the follow-up list, the todo suggestion and the tip topics show. Reading a title decodes part of a session
 * log, so a read of many sessions can take longer than the callers wait (3 s): a read that is given up on by its caller still finishes here and fills the cache, and the
 * next call finds the titles there instead of timing out again (the list then showed every session as "Untitled session"). Never throws.
 *
 * @param {() => { readTitleSnapshots?: (ids: string[]) => Promise<{ status: string, value?: { title?: { title?: unknown } } }[]> } | undefined} queryOf the session query service
 * @param {{ now?: () => number, ttlMs?: number, max?: number }} [opts] ttlMs: how long a title is reused (a renamed session shows its new name after that)
 */
export function createTitleReader(queryOf, { now = Date.now, ttlMs = 120_000, max = 500 } = {}) {
  const cache = new Map() // id -> { title, at }
  return async function titlesOf(ids) {
    const titles = new Map()
    const missing = []
    for (const id of ids) {
      const hit = cache.get(id)
      if (hit && now() - hit.at < ttlMs) titles.set(id, hit.title)
      else missing.push(id)
    }
    if (!missing.length) return titles
    try {
      const query = queryOf()
      if (typeof query?.readTitleSnapshots !== 'function') return titles
      const results = await query.readTitleSnapshots(missing)
      results.forEach((r, i) => {
        const title = r?.status === 'fulfilled' ? r.value?.title?.title : undefined
        if (typeof title !== 'string') return
        cache.delete(missing[i]) // re-inserted last: the oldest entries go first
        cache.set(missing[i], { title, at: now() })
        titles.set(missing[i], title)
      })
      while (cache.size > max) cache.delete(cache.keys().next().value)
    } catch { /* titles are a bonus */ }
    return titles
  }
}
