/** Renders AI usage notes (daily + per ticket) from a tracker and writes them atomically into the vault. */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const CATS = ['code', 'review', 'skill', 'subagent']
const n = (v) => Number(v ?? 0).toLocaleString('en-US')

export function dailyNotePath(vault, day) {
  const [y, m] = day.split('-')
  return join(vault, 'AI usage', `${y}-${m} ${MONTHS[Number(m) - 1]} ${y}`, `${day}.md`)
}
export const ticketNotePath = (vault, id) => join(vault, 'CTnP', 'AI Usage by Ticket', `AB#${id}.md`)

const row = (label, t) => `| ${label} | ${n(t.input)} | ${n(t.output)} | ${n(t.input + t.output)} | ${n(t.cacheRead)} | ${n(t.cacheWrite)} | ${n(t.reasoning)} | ${n(t.messages)} |`
const HEAD = '| | input | output | total | cache read | cache write | reasoning | messages |\n|---|---|---|---|---|---|---|---|'

function breakdown(s) {
  const lines = [HEAD]
  for (const c of CATS) lines.push(row(c, s.byCategory[c]))
  lines.push(row('all', s.totals))
  const skills = Object.entries(s.bySkill)
  if (skills.length) lines.push('', 'Skills:', '', HEAD, ...skills.map(([k, v]) => row(k, v)))
  return lines.join('\n')
}

export function renderDaily(tracker, day) {
  const out = [`# AI usage ${day}`, '']
  const sessions = tracker.sessions().filter((s) => s.kind !== 'untracked' && s.byDay[day])
  const roots = new Set()
  for (const s of sessions) {
    roots.add(tracker.rootOf(s.id))
    out.push(`## session ${s.id} (${s.kind})`, '', `Title: ${s.title || 'n/a'}`, `Cwd: ${s.cwd || 'n/a'}`)
    if (s.tickets.size) out.push(`Tickets: ${[...s.tickets].map((t) => `[[AB#${t}]]`).join(', ')}`)
    out.push(`Subagent runs: ${s.subagentCalls}`, '', `Usage on ${day}:`, '', HEAD, row(day, s.byDay[day]), '', 'Session breakdown:', '', breakdown(s), '')
  }
  for (const r of roots) {
    const c = tracker.chain(r)
    out.push(`## Chain total (root ${r}, ${c.members.length} session(s))`, '', HEAD, row('chain', c.totals), '')
  }
  return out.join('\n')
}

export function renderTicket(tracker, id) {
  const out = [`# AB#${id} AI usage`, '']
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messages: 0 }
  const lines = []
  for (const s of tracker.sessions()) {
    const t = s.byTicket[id]
    if (!t) continue
    lines.push(row(`${s.id} (chain ${tracker.rootOf(s.id)})`, t))
    for (const k of Object.keys(total)) total[k] += t[k]
  }
  out.push(`Total (sessions attributed to this ticket; shared messages are listed in the daily notes):`, '', HEAD, row('Total', total), '', 'Sessions:', '', HEAD, ...lines, '')
  return out.join('\n')
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

/** Writes the daily notes for `days` and a note per ticket seen in tracked sessions; returns the paths written. */
export function writeNotes(tracker, vault, days) {
  const files = []
  for (const d of days) { const p = dailyNotePath(vault, d); atomicWrite(p, renderDaily(tracker, d)); files.push(p) }
  const ids = new Set()
  for (const s of tracker.sessions()) if (s.kind === 'ticket') for (const t of s.tickets) ids.add(t)
  for (const id of ids) { const p = ticketNotePath(vault, id); atomicWrite(p, renderTicket(tracker, id)); files.push(p) }
  return files
}
