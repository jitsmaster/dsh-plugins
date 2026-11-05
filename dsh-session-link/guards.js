const HOUR_MS = 60 * 60_000
const KEEP_MS = 30_000
const SWEEP_ABOVE = 256

export const LIMITS = { perMinute: 5, windowMs: 60_000, pairMs: 60_000, waiting: 3, hourly: 3, archiveMs: 60_000 }

export function createGuards({ now = Date.now, limits = LIMITS } = {}) {
  const minutes = new Map() // senderId -> slot timestamps (a slot is reserved before the first await, so parallel calls cannot all pass the limit)
  const hours = new Map() // senderId -> marks
  const kept = new Map() // senderId -> Map(cardId -> time), cards queued a moment ago that a lagging hub mirror may not list yet
  const flights = new Map() // key -> senderId, only while a call is between reservation and its queue/prompt result
  const archives = new Map() // sessionId -> slot timestamps of archive offers (1 per archiveMs; reserved before the first await)
  const archiveMs = () => limits.archiveMs ?? LIMITS.archiveMs

  const prune = (map, id, span) => {
    const t = (map.get(id) ?? []).filter((x) => now() - x < span)
    if (t.length) map.set(id, t); else map.delete(id)
    return t
  }
  // Entries are only pruned when their sender calls again, so a map that grew past SWEEP_ABOVE is swept of senders that never came back.
  const sweep = (map, span, newest) => { if (map.size > SWEEP_ABOVE) for (const [id, v] of map) if (now() - newest(v) >= span) map.delete(id) }
  const newestOf = (a) => Math.max(...a)
  const newestKept = (m) => Math.max(...m.values())
  const drop = (map, id, t) => { const a = map.get(id); if (!a) return; const i = a.indexOf(t); if (i >= 0) a.splice(i, 1); if (!a.length) map.delete(id) }

  return {
    sizes: () => ({ minutes: minutes.size, hours: hours.size, kept: kept.size, flights: flights.size, archives: archives.size }),
    reserveArchive(id) {
      sweep(archives, archiveMs(), newestOf)
      const used = prune(archives, id, archiveMs())
      if (used.length >= 1) return null
      const slot = now()
      used.push(slot)
      archives.set(id, used)
      return slot
    },
    releaseArchive: (id, slot) => drop(archives, id, slot),
    reserveMinute(id) {
      sweep(minutes, limits.windowMs, newestOf)
      const used = prune(minutes, id, limits.windowMs)
      if (used.length >= limits.perMinute) return null
      const slot = now()
      used.push(slot)
      minutes.set(id, used)
      return slot
    },
    releaseMinute: (id, slot) => drop(minutes, id, slot),
    reserveFlight(key, id) {
      if (flights.has(key)) return false
      flights.set(key, id)
      return true
    },
    endFlight: (key) => { flights.delete(key) },
    flightsOf(id) { let n = 0; for (const v of flights.values()) if (v === id) n++; return n },
    hourly: (id) => prune(hours, id, HOUR_MS).length,
    markHour(id, t) { sweep(hours, HOUR_MS, newestOf); const a = prune(hours, id, HOUR_MS); a.push(t); hours.set(id, a) },
    releaseHour: (id, t) => drop(hours, id, t),
    keepCard(id, cardId) { sweep(kept, KEEP_MS, newestKept); const m = kept.get(id) ?? new Map(); m.set(cardId, now()); kept.set(id, m) },
    pendingCards(id, knownIds) {
      const m = kept.get(id)
      if (!m) return []
      for (const [cardId, t] of m) if (knownIds.has(cardId) || now() - t >= KEEP_MS) m.delete(cardId)
      if (!m.size) { kept.delete(id); return [] }
      return [...m.keys()]
    },
  }
}
