const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
// Copy of follow-up-shared.js (dsh-review-queue) ticket rules; test/parity.test.mjs keeps the two in step.
const REF = /(?<![A-Za-z])(?:AB#|PR\s*#?|pull\s+request\s*#?|work\s+item\s*#?|ticket\s*#?)\s*(\d{1,9})(?!\d)|#\s*(\d{1,9})(?!\d)/gi
const hasWholeNumber = (title, n) => new RegExp('(?<!\\d)(?<!\\d[-./:])' + n + '(?!\\d)(?![-./:]\\d)').test(title)

export const tokensOf = (text) => String(text ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** True when the edit distance of a and b is at most max (early exit per row). */
export function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > max) return false
    prev = cur
  }
  return prev[b.length] <= max
}

/** Haystack tokens: the split ones plus each whole word, so "ctnp" also finds "CTnP-Final" (split: ctn, p, final). */
const hayOf = (text) => [...new Set([...tokensOf(text), ...String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)])]

function tokenScore(q, h) {
  if (q === h) return 3
  if (q.length >= 3 && h.startsWith(q)) return 2
  const max = q.length >= 8 ? 2 : q.length >= 4 ? 1 : 0
  return max > 0 && within(q, h, max) ? 1 : 0
}

export function matchSessions(query, sessions) {
  const text = String(query ?? '').trim()
  const none = { kind: 'none', matches: [], near: [] }
  if (!text) return none
  const own = SESSION_ID.test(text) ? sessions.find((s) => s.sessionId === text) : undefined
  if (own) return { kind: 'one', matches: [{ session: own, score: Infinity }], near: [] }
  const refs = [...new Set([...text.matchAll(REF)].map((m) => m[1] ?? m[2]))]
  const words = tokensOf(text.replace(REF, ' '))
  const need = words.length + refs.length
  if (!need) return none
  const rows = sessions.map((session) => {
    const hay = hayOf((session.title ?? '') + ' ' + (session.workspace ?? ''))
    let matched = 0
    let score = 0
    for (const q of words) {
      const best = Math.max(0, ...hay.map((h) => tokenScore(q, h)))
      if (best > 0) matched++
      score += best
    }
    const refHits = refs.filter((n) => hasWholeNumber(String(session.title ?? ''), n)).length
    return { session, hits: matched + refHits, score: score + refHits * 5 }
  })
  const order = (a, b) => b.score - a.score || (b.session.updatedAt ?? -Infinity) - (a.session.updatedAt ?? -Infinity)
  const full = rows.filter((r) => r.hits === need).sort(order)
  if (full.length === 1) return { kind: 'one', matches: [{ session: full[0].session, score: full[0].score }], near: [] }
  if (full.length > 1) return { kind: 'many', matches: full.map((r) => ({ session: r.session, score: r.score })), near: [] }
  const near = rows.filter((r) => r.hits > 0).sort((a, b) => b.hits - a.hits || order(a, b)).slice(0, 3).map((r) => r.session)
  return { kind: 'none', matches: [], near }
}
