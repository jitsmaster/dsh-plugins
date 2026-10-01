/**
 * Status service: every `refreshIntervalMs` (default 30s) it samples each live
 * agent's worktree, context size and token usage, keeps a persistent 7-day token
 * ledger for the weekly figure, and serves the snapshot as JSON on
 * http://127.0.0.1:3081/status for the browser widget (lib/client.js).
 */
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const STATUS_PORT = 3081

const git = (cwd, args) => new Promise((res) => {
  execFile('git', ['-C', cwd, ...args], { timeout: 5000, windowsHide: true }, (err, out) => res(err ? undefined : out.trim()))
})

async function worktreeOf(cwd) {
  if (!cwd) return undefined
  const [top, gitDir, common, branch] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']),
    git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']),
    git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  if (!top) return undefined
  return {
    name: top.split(/[\\/]/).filter(Boolean).at(-1),
    root: top,
    branch: branch && branch !== 'HEAD' ? branch : '(detached)',
    linked: Boolean(gitDir && common && gitDir !== common),
  }
}

const recordedWorktree = (r) => (r && existsSync(r.root) ? { name: r.name, root: r.root, branch: r.branch, linked: true } : undefined)

const pct = (used, budget) => (budget > 0 ? Math.round((used / budget) * 1000) / 10 : undefined)

export function startStatusService(ctx, config, stateDir, signal, settings, worktrees) {
  const intervalMs = config.refreshIntervalMs ?? 30_000
  const sessionBudget = config.sessionBudgetTokens ?? 30_000_000
  const weeklyBudget = config.weeklyBudgetTokens ?? 200_000_000
  const ledgerPath = join(stateDir, 'usage-ledger.json')

  // sessions: last seen cumulative total per session; events: [timestampMs, tokenDelta] for 7 days.
  let ledger = { sessions: {}, events: [] }
  try { ledger = { ...ledger, ...JSON.parse(readFileSync(ledgerPath, 'utf8')) } } catch { /* first run */ }
  if (!Array.isArray(ledger.events)) ledger.events = []
  // v2: first-sight baselining. Drop v1 events, which included whole-session history as one delta.
  if (ledger.v !== 2) ledger = { v: 2, sessions: ledger.sessions ?? {}, events: [] }

  const agents = new Map()
  ctx.on('agent/created', ({ agent }) => { agents.set(agent.id, agent) })
  ctx.on('agent/disposed', (payload) => { agents.delete(payload?.agent?.id ?? payload?.id) })

  let snapshot = { updatedAt: null, sessions: {}, usage: { fiveHour: { tokens: 0, budget: sessionBudget, pct: 0 }, weekly: { tokens: 0, budget: weeklyBudget, pct: 0 } } }

  const projection = (agent, key) => {
    // snapshot() returns the schema-validated client views; stateOf() would return raw fold state.
    try { return ctx.get('sessionProjections')?.snapshot(agent.session, [key])?.values?.[key] } catch { return undefined }
  }

  const retained = new Map() // id -> { entry, seenAt }

  // ---- Claude plan limits (same numbers as Claude Code's /usage) ----
  // Reads Claude Code's own OAuth token (read-only; Claude Code refreshes it) and asks the
  // plan usage endpoint. On failure the last good reading is kept and `error` is set.
  const credPath = config.claudeCredentialsPath ?? join(homedir(), '.claude', '.credentials.json')
  const claudeEnabled = config.claudeUsage ?? true
  let claude = { enabled: claudeEnabled, limits: [], updatedAt: null, error: claudeEnabled ? 'not fetched yet' : 'disabled' }
  const limitLabel = (l) => {
    if (l.kind === 'session') return 'Current session'
    if (l.kind === 'weekly_all') return 'Current week (all models)'
    if (l.kind === 'weekly_scoped') return `Current week (${l.scope?.model?.display_name ?? l.scope?.surface ?? 'scoped'})`
    return l.kind
  }
  async function refreshClaude() {
    if (!claudeEnabled) return
    try {
      const token = JSON.parse(readFileSync(credPath, 'utf8'))?.claudeAiOauth?.accessToken
      if (!token) throw new Error('no Claude Code login found')
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(res.status === 401 ? 'Claude token expired (open Claude Code to refresh)' : `HTTP ${res.status}`)
      const data = await res.json()
      const limits = (data.limits ?? []).map(l => ({
        kind: l.kind, label: limitLabel(l), percent: l.percent, resetsAt: l.resets_at, severity: l.severity,
      }))
      claude = { enabled: true, limits, updatedAt: new Date().toISOString(), error: null }
    } catch (error) {
      claude = { ...claude, enabled: true, error: String(error?.message ?? error) }
    }
    snapshot = { ...snapshot, claude }
  }

  async function sample() {
    const sessions = {}
    for (const [id, agent] of agents) {
      const usage = projection(agent, 'tokenUsage') ?? {}
      const total = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
        + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0)
      // First sight of a session is a baseline only: history from before the plugin
      // watched it must not land in the current 5h/weekly window as one big delta.
      const last = ledger.sessions[id] ?? total
      if (total > last) ledger.events.push([Date.now(), total - last])
      ledger.sessions[id] = Math.max(total, last)

      const pressure = projection(agent, 'contextPressure') ?? {}
      const prev = retained.get(id)?.entry
      // The projection can be momentarily empty (right after compaction/resume); keep the last reading.
      const ctxTokens = pressure.projectedTokens ?? pressure.pressureTokens ?? prev?.context.tokens
      const window = pressure.contextWindow ?? prev?.context.window
      const cwd = agent.session?.header?.cwd
      const capTokens = settings?.get().contextCapTokens
      const warnPct = settings?.get().warnPercent
      const entry = {
        cwd,
        // Lifetime billed tokens (input + cache + output) for this session, same basis as DSH's "tok" figure.
        sessionTokens: total,
        cap: capTokens && ctxTokens !== undefined
          ? { tokens: capTokens, warn: Boolean(warnPct) && ctxTokens >= capTokens * warnPct / 100, over: ctxTokens >= capTokens, autoResume: settings.get().autoResumeHandoff }
          : undefined,
        // A worktree the session was seen working in outranks its launch directory.
        worktree: recordedWorktree(worktrees?.get(id)) ?? (await worktreeOf(cwd)) ?? prev?.worktree,
        context: {
          tokens: ctxTokens,
          window,
          pct: ctxTokens !== undefined && window ? pct(ctxTokens, window) : undefined,
        },
      }
      retained.set(id, { entry, seenAt: Date.now() })
    }
    // Keep sessions whose agent was disposed/re-created for 6h so the widget never blanks.
    for (const [id, { entry, seenAt }] of retained) {
      if (Date.now() - seenAt > 6 * 3_600_000) retained.delete(id)
      else sessions[id] = entry
    }
    // Usage is cross-session: rolling 5h "session" window and rolling 7-day week, like Claude's usage bars.
    const now = Date.now()
    ledger.events = ledger.events.filter(([t]) => t > now - 7 * 86_400_000)
    const sumSince = ms => ledger.events.filter(([t]) => t > now - ms).reduce((a, [, d]) => a + d, 0)
    const fiveHour = sumSince(5 * 3_600_000)
    const weekly = sumSince(7 * 86_400_000)
    snapshot = {
      updatedAt: new Date(now).toISOString(),
      sessions,
      claude,
      usage: {
        fiveHour: { tokens: fiveHour, budget: sessionBudget, pct: pct(fiveHour, sessionBudget) },
        weekly: { tokens: weekly, budget: weeklyBudget, pct: pct(weekly, weeklyBudget) },
      },
    }
    try { writeFileSync(ledgerPath, JSON.stringify(ledger)) } catch { /* non-fatal */ }
  }

  const run = () => {
    void refreshClaude()
    return sample().catch(error => ctx.logger.warn(`hooks-tts: status sample failed: ${String(error)}`))
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref?.()

  // Settings writes are accepted only from the DSH web page itself (never from other sites).
  const webUrl = new URL(process.env.DSH_WEB_URL || 'http://127.0.0.1:3080')
  const allowedOrigins = new Set(['127.0.0.1', 'localhost'].map(h => `${webUrl.protocol}//${h}:${webUrl.port}`).concat(webUrl.origin))

  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-store')
    if (req.url?.startsWith('/settings')) {
      const origin = req.headers.origin
      if (!origin || !allowedOrigins.has(origin)) { res.statusCode = 403; res.end(); return }
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Vary', 'Origin')
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST') {
        let body = ''
        req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy() })
        req.on('end', () => {
          try {
            const saved = settings.set(JSON.parse(body || '{}'))
            snapshot = { ...snapshot, settings: saved }
            res.end(JSON.stringify(saved))
          } catch (error) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(error?.message ?? error) }))
          }
        })
        return
      }
      res.end(JSON.stringify(settings.get()))
    } else if (req.url?.startsWith('/status')) {
      res.setHeader('Content-Type', 'application/json')
      // Settings are read fresh on every request, so edits to settings.json show up immediately.
      res.end(JSON.stringify({ ...snapshot, settings: settings.get() }))
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  server.on('error', error => ctx.logger.warn(`hooks-tts: status server failed: ${String(error)}`))
  server.listen(STATUS_PORT, '127.0.0.1')

  const stop = () => { clearInterval(timer); server.close() }
  signal.addEventListener('abort', stop, { once: true })
}
