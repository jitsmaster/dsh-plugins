/**
 * titlesOf(ids) -> Map(id -> title) for the session titles the follow-up list, the todo suggestion and the tip topics show. Reading a title decodes part of a session
 * log, so a read of many sessions can take longer than the callers wait (3 s): a read that is given up on by its caller still finishes here and fills the cache, and the
 * next call finds the titles there instead of timing out again (the list then showed every session as "Untitled session"). Calls that overlap share one read of the same id. What a read gave (counts, error codes only) is logged when a log is given. Never throws.
 *
 * @param {() => { readTitleSnapshots?: (ids: string[]) => Promise<{ status: string, value?: { title?: { title?: unknown } } }[]> } | undefined} queryOf the session query service
 * @param {{ now?: () => number, ttlMs?: number, untitledTtlMs?: number, max?: number, log?: (line: string) => void }} [opts] ttlMs: how long a title is reused (a renamed session shows its new name after that)
 */
export function createTitleReader(queryOf, { now = Date.now, ttlMs = 120_000, untitledTtlMs = 30_000, max = 500, log = () => {} } = {}) {
  const cache = new Map() // id -> { title, at } (title undefined: read fine, but the session has no title yet)
  const pending = new Map() // id -> the read that is asking for it
  const codeOf = (e) => String(typeof e === 'string' ? e : e?.code ?? e?.name ?? 'error').replace(/[^A-Za-z0-9_:. /-]/g, '?').slice(0, 40) // never the message: it can carry a path
  const say = (line) => { try { log(line) } catch { /* the log is a bonus too */ } }
  async function read(ids) {
    const started = now()
    try {
      const query = queryOf()
      if (typeof query?.readTitleSnapshots !== 'function') { say('titles: no session query service'); return }
      const results = await query.readTitleSnapshots(ids)
      let titled = 0
      const rejected = new Map()
      results.forEach((r, i) => {
        if (r?.status === 'rejected') { const code = codeOf(r.reason); rejected.set(code, (rejected.get(code) ?? 0) + 1); return }
        if (r?.status !== 'fulfilled') return
        const title = typeof r.value?.title?.title === 'string' ? r.value.title.title : undefined
        if (title !== undefined) titled++
        cache.delete(ids[i]) // re-inserted last: the oldest entries go first
        cache.set(ids[i], { title, at: now() }) // no title yet is remembered too (briefly): else every call re-reads it and waits for it
      })
      while (cache.size > max) cache.delete(cache.keys().next().value)
      const bad = [...rejected.values()].reduce((a, b) => a + b, 0)
      say(`titles: read ${ids.length} in ${now() - started} ms: ${titled} titled, ${ids.length - titled - bad} untitled, ${bad} rejected${bad ? ' (' + [...rejected.keys()].join(', ') + ')' : ''}`)
    } catch (error) { say('titles: read failed: ' + codeOf(error)) } // titles are a bonus
  }
  return async function titlesOf(ids) {
    const titles = new Map()
    const waits = new Set()
    const fresh = []
    for (const id of ids) {
      const hit = cache.get(id)
      if (hit && now() - hit.at < (hit.title === undefined ? untitledTtlMs : ttlMs)) { if (hit.title !== undefined) titles.set(id, hit.title) }
      else if (pending.has(id)) waits.add(pending.get(id))
      else fresh.push(id)
    }
    if (fresh.length) {
      const run = read(fresh).finally(() => { for (const id of fresh) pending.delete(id) })
      for (const id of fresh) pending.set(id, run)
      waits.add(run)
    }
    if (!waits.size) return titles
    await Promise.all(waits)
    for (const id of ids) {
      const hit = cache.get(id)
      if (hit?.title !== undefined && !titles.has(id)) titles.set(id, hit.title)
    }
    return titles
  }
}
