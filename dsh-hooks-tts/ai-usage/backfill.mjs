// Backfill: replay DSH session logs (zstd JSONL) through the usage tracker and write the vault notes.
// Usage: node ai-usage/backfill.mjs <YYYY-MM-DD> [vaultDir] [ledgerPath]
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createUsageTracker } from './tracker.js'
import { createLedger } from './ledger.js'
import { writeNotes } from './render.js'

const [day, lastDay = day] = process.argv[2].split('..')
const ticketsOnly = process.env.AIU_TICKETS_ONLY === '1'
const vault = process.argv[3] ?? 'D:\\dev\\Notes\\Dev Tasks'
const ledgerPath = process.argv[4]
const root = join(homedir(), '.dsh', 'sessions')
const dayStart = new Date(`${day}T00:00:00`).getTime()
const dayEnd = new Date(`${lastDay}T00:00:00`).getTime() + 86_400_000

function decode(file) {
  const b = readFileSync(file); const idx = []
  for (let i = 0; i <= b.length - 4; i++) if (b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd) idx.push(i)
  let txt = ''
  for (let k = 0; k < idx.length; k++) { try { txt += zstdDecompressSync(b.subarray(idx[k], idx[k + 1] ?? b.length)).toString('utf8') } catch { /* skip bad frame */ } }
  return txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
const cwdOf = (dir) => dir.replace(/^--|--$/g, '').replace(/^([A-Z])-/, '$1:\\').replace(/-/g, '\\')
const baseTitle = (t) => String(t ?? '').replace(/\s+-\s*\d+$/, '').trim()

const tracker = createUsageTracker()
if (ledgerPath) tracker.onRecord = createLedger(ledgerPath).append
const byGroup = new Map()
for (const dir of readdirSync(root)) {
  const dpath = join(root, dir)
  for (const sid of readdirSync(dpath)) {
    const f = join(dpath, sid, 'session.v4.jsonl.zstd')
    if (!existsSync(f)) continue
    const events = decode(f)
    if (!events.some((e) => e.type === 'assistant/message' && e.time >= dayStart && e.time < dayEnd)) continue
    const hdr = events.find((e) => e.type === 'session')
    const title = events.findLast((e) => e.type === 'session/title')?.data?.title ?? ''
    const cwd = hdr?.cwd ?? cwdOf(dir)
    tracker.meta(sid, { cwd, title })
    // Skill context is carried from earlier days; only usage inside the day window is accounted.
    for (const e of events) {
      if (e.type === 'assistant/message' && !(e.time >= dayStart && e.time < dayEnd)) continue
      tracker.observe(sid, e)
    }
    const key = `${cwd}|${baseTitle(title)}`
    if (!byGroup.has(key)) byGroup.set(key, [])
    byGroup.get(key).push({ sid, first: events.find((e) => e.type === 'assistant/message')?.time ?? 0 })
  }
}
// Handoff chains are inferred from titles: a continuation is "<title> - N" in the same cwd.
for (const list of byGroup.values()) {
  list.sort((a, b) => a.first - b.first)
  for (let i = 1; i < list.length; i++) tracker.link(list[i - 1].sid, list[i].sid)
}
const files = writeNotes(tracker, vault, ticketsOnly ? [] : [day])
if (!ticketsOnly) {
  const { readFileSync: rf, writeFileSync: wf } = await import('node:fs')
  const z = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messages: 0 })
  const sum = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k] ?? 0 }
  const all = z(); const cats = {}; const kinds = {}; const tickets = {}
  for (const s of tracker.sessions().filter((x) => x.kind !== 'untracked')) {
    sum(all, s.totals); sum(kinds[s.kind] ??= z(), s.totals)
    for (const [c, v] of Object.entries(s.byCategory)) sum(cats[c] ??= z(), v)
    for (const [t, v] of Object.entries(s.byTicket)) sum(tickets[t] ??= z(), v)
  }
  const n = (v) => v.toLocaleString('en-US')
  const H = '| | input (incl. cache) | output | total | cache read | cache write | reasoning | messages |\n|---|---|---|---|---|---|---|---|'
  const r = (l, t) => `| ${l} | ${n(t.input)} | ${n(t.output)} | ${n(t.input + t.output)} | ${n(t.cacheRead)} | ${n(t.cacheWrite)} | ${n(t.reasoning)} | ${n(t.messages)} |`
  const tbl = (o) => [H, ...Object.entries(o).map(([k, v]) => r(k, v))].join('\n')
  const top = `# AI usage ${day}\n\n## Day summary (tracked sessions: ticket and DSH work)\n\n${tbl({ ALL: all })}\n\nBy category (code = code changes, review = review skills, skill = other skills, subagent = delegated runs):\n\n${tbl(cats)}\n\nBy session kind:\n\n${tbl(kinds)}\n\nBy ticket ('shared' = messages with no single ticket id):\n\n${tbl(tickets)}\n\nNotes: backfilled from session logs; handoff chains are inferred from "- N" titles in the same folder; "input" includes cache read and write; subagent_claude_code runs are not costed unless the log carries their usage. Per-ticket notes: CTnP/AI Usage by Ticket.\n\n`
  wf(files[0], top + rf(files[0], 'utf8').replace(/^# AI usage [^\n]*\n\n/, ''))
}
console.log(JSON.stringify({ sessions: tracker.sessions().length, files }, null, 1))

