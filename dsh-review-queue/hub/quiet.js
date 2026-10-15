/**
 * Quiet hours of one phone ({ enabled, start 'HH:MM', end 'HH:MM', tz }, validated by lib/mobile/push-client.js): is a moment inside the
 * window, and when does the window end. The wall clock of the phone's time zone is read with Intl; an unknown zone means no quiet
 * hours (a push that arrives at night beats one that is lost).
 */
const MINUTE_MS = 60_000
const DAY_MIN = 24 * 60

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** Minutes since local midnight in the zone, with the seconds as a fraction; undefined for an unknown zone. */
function localMinutes(tz, at) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
    const n = (type) => Number(parts.find((p) => p.type === type)?.value)
    return n('hour') * 60 + n('minute') + n('second') / 60
  } catch { return undefined }
}

/** @returns {number | undefined} when the quiet window that contains `at` ends (ms since epoch), undefined when it is not quiet */
export function quietEndsAt(quiet, at) {
  if (!quiet || quiet.enabled !== true) return undefined
  const local = localMinutes(quiet.tz, at)
  if (local === undefined) return undefined
  const [start, end] = [minutesOf(quiet.start), minutesOf(quiet.end)]
  const inside = start < end ? local >= start && local < end : local >= start || local < end
  return inside ? Math.round(at + ((end - local + DAY_MIN) % DAY_MIN) * MINUTE_MS) : undefined
}
