/**
 * AI usage tracker: pure, replayable accounting of assistant/message token usage per session.
 * Every state change is emitted through `onRecord` and can be replayed with `apply` (ledger = source of truth).
 * Categories: code, review, skill, subagent. See the vault note "AI Usage Tracking Design Spec".
 */
const REVIEW_SKILLS = new Set(['code-review', 'modes-ai-pitfall-review', 'modes-security-review', 'modes-regressions-analyzer', 'modes-memory-and-performance-analyzer', 'modes:ai-pitfall-review', 'modes:security-review', 'modes:regressions-analyzer', 'modes:memory-and-performance-analyzer'])
const NEUTRAL_SKILLS = new Set(['modes-sparc', 'modes:sparc', 'all-4-1', 'ado-ticket-to-implementation', 'ctnp-sprint-batch-prs'])
const TICKET_SKILLS = new Set(['ado-ticket-to-implementation', 'all-4-1', 'ctnp-sprint-batch-prs', 'ado-pr', 'ado-pr-implement', 'ado-pr-review'])
const REVIEW_RE = /code-review|ai-pitfall|security-review|regressions?-analy|memory-and-performance|\breview\b/i
const EDIT_TOOLS = new Set(['write', 'edit', 'multi_edit'])
const TICKET_RE = /AB#(\d{4,7})/g
const CATS = ['code', 'review', 'skill', 'subagent']

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messages: 0 })
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
const add = (t, u) => {
  t.input += u.input; t.output += u.output; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite
  t.reasoning += u.reasoning; t.messages += u.messages ?? 1
}
const bucket = (obj, key) => (obj[key] ??= zero())
const dayOf = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
const parseArgs = (a) => { if (a && typeof a === 'object') return a; try { return JSON.parse(a) } catch { return {} } }

export function createUsageTracker() {
  const state = new Map()
  const parents = new Map()
  const tracker = { onRecord: undefined }
  const emit = (r) => { try { tracker.onRecord?.(r) } catch { /* sink must not break accounting */ } }

  const get = (id) => {
    let s = state.get(id)
    if (!s) {
      s = { id, cwd: '', title: '', ticketSkill: false, totals: zero(), byCategory: {}, bySkill: {}, byTicket: {}, byDay: {}, tickets: new Set(), subagentCalls: 0, runs: [], ctx: null, pending: new Map(), first: undefined, last: undefined }
      for (const c of CATS) s.byCategory[c] = zero()
      state.set(id, s)
    }
    return s
  }

  const kindOf = (s) => {
    if (s.ticketSkill) return 'ticket'
    if (/(^|[\\/])dsh([\\/-]|$)|dsh-plugins/i.test(s.cwd)) return 'dsh'
    return 'untracked'
  }

  function rootOf(id) {
    const seen = new Set()
    let cur = id
    while (parents.has(cur) && !seen.has(cur)) { seen.add(cur); cur = parents.get(cur) }
    return cur
  }

  function account(s, cat, skill, tickets, u, time) {
    add(s.totals, u); add(s.byCategory[cat], u)
    if (skill) add(bucket(s.bySkill, skill), u)
    add(bucket(s.byDay, dayOf(time)), u)
    const key = tickets.length === 1 ? tickets[0] : 'shared'
    if (s.ticketSkill || tickets.length) add(bucket(s.byTicket, key), u)
    for (const t of tickets) s.tickets.add(t)
    s.first ??= time; s.last = time
  }

  function apply(r) {
    if (!r || typeof r !== 'object') return
    if (r.k === 'meta') { const s = get(r.id); if (r.cwd) s.cwd = r.cwd; if (r.title) s.title = r.title }
    else if (r.k === 'link') { if (r.from !== r.to && !parents.has(r.to)) parents.set(r.to, r.from) }
    else if (r.k === 'msg') {
      const s = get(r.id)
      if (r.ticketSkill) s.ticketSkill = true
      account(s, r.cat, r.skill, r.tickets ?? [], r.u, r.time)
      if (r.sub) s.subagentCalls += r.sub
      if (Array.isArray(r.runs)) s.runs.push(...r.runs.slice(0, 50))
    } else if (r.k === 'sub') {
      const s = get(r.id); account(s, 'subagent', undefined, [], r.u, r.time)
    }
  }

  function observe(id, event) {
    try {
      if (!event || typeof event !== 'object') return
      if (event.type === 'turn/end') { state.get(id) && (state.get(id).ctx = null); return }
      if (event.type === 'tool/result') {
        const s = state.get(id)
        const callId = event.data?.message?.source?.callId
        const mu = event.data?.meta?.usage
        if (s && s.pending.has(callId) && mu && valid(mu.inputTokens) && valid(mu.outputTokens)) {
          s.pending.delete(callId)
          const u = { input: mu.inputTokens + num(mu.cacheReadTokens) + num(mu.cacheWriteTokens), output: mu.outputTokens, cacheRead: num(mu.cacheReadTokens), cacheWrite: num(mu.cacheWriteTokens), reasoning: 0, messages: 1 }
          const rec = { k: 'sub', id, u, time: event.time ?? Date.now() }
          apply(rec); emit(rec)
        }
        return
      }
      if (event.type !== 'assistant/message') return
      const usage = event.data?.usage
      if (!usage || !valid(usage.inputTokens) || !valid(usage.outputTokens)) return
      const s = get(id)
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
      let sub = 0; let edits = false; let text = ''; let ticketSkill = false; let nextCtx = null; const runs = []
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string') text += ' ' + b.text
        if (b.type !== 'tool-call') continue
        const args = parseArgs(b.arguments)
        text += ' ' + (typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? ''))
        if (b.name === 'skill' && typeof args.name === 'string') {
          if (TICKET_SKILLS.has(args.name)) ticketSkill = true
          if (!NEUTRAL_SKILLS.has(args.name)) nextCtx = { name: args.name, review: REVIEW_SKILLS.has(args.name) }
        }
        if (EDIT_TOOLS.has(b.name)) edits = true
        if (b.name === 'subagent_claude_code') {
          sub++; if (b.id) s.pending.set(b.id, true)
          const hay = `${args.name ?? ''} ${args.description ?? ''} ${args.prompt ?? ''}`
          runs.push({ name: String(args.name ?? args.description ?? 'subagent').slice(0, 80), kind: REVIEW_RE.test(hay) ? 'review' : 'other' })
        }
      }
      const tickets = [...new Set([...text.matchAll(TICKET_RE)].map((m) => m[1]))]
      let cat = 'code'; let skill
      if (s.ctx) {
        skill = s.ctx.name
        if (s.ctx.review) cat = 'review'
        else if (!edits) cat = 'skill'
      }
      const cacheRead = num(usage.cacheReadTokens); const cacheWrite = num(usage.cacheWriteTokens)
      const u = { input: usage.inputTokens + cacheRead + cacheWrite, output: usage.outputTokens, cacheRead, cacheWrite, reasoning: num(usage.reasoningTokens), messages: 1 }
      const rec = { k: 'msg', id, cat, skill, tickets, u, sub, ticketSkill, runs, time: Number.isFinite(event.time) ? event.time : Date.now() }
      apply(rec); emit(rec)
      if (nextCtx) s.ctx = nextCtx // a skill takes effect for the messages after the one that loaded it
    } catch { /* an odd event must never reach the host */ }
  }

  return Object.assign(tracker, {
    observe,
    apply,
    meta(id, { cwd, title } = {}) { const rec = { k: 'meta', id, cwd: cwd ?? '', title: title ?? '' }; apply(rec); emit(rec) },
    link(from, to) { const rec = { k: 'link', from, to }; apply(rec); emit(rec) },
    rootOf,
    sessions() {
      return [...state.values()].filter((s) => s.totals.messages > 0).map((s) => ({ ...s, kind: kindOf(s) }))
    },
    chain(root) {
      const all = [...state.values()].filter((s) => s.totals.messages > 0 && rootOf(s.id) === root)
      const totals = zero()
      for (const s of all) add(totals, s.totals)
      return { root, members: all.map((s) => s.id), totals }
    },
  })
}
