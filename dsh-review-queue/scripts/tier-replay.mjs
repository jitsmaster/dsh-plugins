// Read-only replay of stored review-queue cards through the tier matrix (slice 0.8).
// Usage: node scripts/tier-replay.mjs [stateDir]   (default ~/.dsh/review-queue). Prints JSON; writes nothing.
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { severityOf, urgencyOf, tierOf } from '../tier.js'

/** Code facts recoverable from one triage-log row. */
export function factsFromLog(row) {
  const facts = {}
  if (!row) return facts
  if (Array.isArray(row.reasons) && row.reasons.includes('needs-user')) facts.needsUser = true
  const j = row.judgment
  if (j) {
    const flags = []
    if (j.reversible === false) flags.push('irreversible')
    if (j.touches_outside_workspace === true) flags.push('outside-workspace')
    if (flags.length) facts.riskFlags = flags
  }
  return facts
}

const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function replay({ items, log, now = Date.now() }) {
  const last = new Map()
  for (const row of log || []) if (row?.itemId) last.set(row.itemId, row)
  const rows = (items || []).map((item) => {
    const row = last.get(item.id)
    const input = { item, facts: factsFromLog(row), judgment: row?.judgment }
    const severity = severityOf(input)
    const tier = tierOf(severity, urgencyOf(item))
    const wait = (item.resolvedAt ?? now) - item.createdAt
    return { id: item.id, createdAt: item.createdAt, severity, tier, wait, risky: input.facts.riskFlags?.length > 0 }
  })
  const byAge = [...rows].sort((a, b) => a.createdAt - b.createdAt)
  const byTier = [...rows].sort((a, b) => a.tier - b.tier || a.createdAt - b.createdAt)
  const out = { total: rows.length, byTier: {}, risky: [] }
  for (let t = 0; t <= 4; t++) {
    const g = rows.filter((r) => r.tier === t)
    out.byTier[t] = { count: g.length, medianWaitMs: median(g.map((r) => r.wait)) }
  }
  const ageRank = new Map(byAge.map((r, i) => [r, i + 1]))
  const tierRank = new Map(byTier.map((r, i) => [r, i + 1]))
  for (const r of rows.filter((x) => x.risky)) {
    out.risky.push({ id: r.id, tier: r.tier, oldestFirstRank: ageRank.get(r), tierRank: tierRank.get(r) })
  }
  return out
}

/** Every stored item of a state dir: queue.json (a normal install) plus local/*.json (hub-era files); first copy of an id wins; missing files are fine. */
export function loadItems(dir) {
  const items = []
  const seen = new Set()
  const take = (file) => {
    try {
      for (const it of JSON.parse(readFileSync(file, 'utf8')).items || []) if (it?.id && !seen.has(it.id)) { seen.add(it.id); items.push(it) }
    } catch { /* missing or corrupt state file */ }
  }
  take(join(dir, 'queue.json'))
  let names = []
  try { names = readdirSync(join(dir, 'local')).filter((n) => n.endsWith('.json')) } catch { /* no local dir */ }
  for (const f of names) take(join(dir, 'local', f))
  return items
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] || join(homedir(), '.dsh', 'review-queue')
  const items = loadItems(dir)
  let log = []
  try { log = readFileSync(join(dir, 'triage-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return undefined } }).filter(Boolean) } catch { /* no log */ }
  const r = replay({ items, log })
  r.risky = { count: r.risky.length, sample: r.risky.slice(0, 20) }
  console.log(JSON.stringify(r, null, 2))
}
