/**
 * Status service: every `refreshIntervalMs` (default 30s) it samples each live
 * agent's worktree, context size and token usage, keeps a persistent 7-day token
 * ledger for the weekly figure, and serves the snapshot as JSON on
 * /hooks-tts/status on the Host web server for the widget (lib/client.js).
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { limitsFromReading } from './claude-limits.js'
import { applyMove, buildGroupsView } from './groups.js'
import { listSpawned } from './spawned.js'
import { applyFollowUp } from './handoffs.js'

export const STATUS_PREFIX = '/hooks-tts'

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

// worktreeOf spawns four git processes; sampling can now run every couple of seconds, so cache per cwd.
const WORKTREE_TTL_MS = 30_000
const worktreeCache = new Map()
async function cachedWorktreeOf(cwd) {
  const hit = worktreeCache.get(cwd)
  if (hit && Date.now() - hit.at < WORKTREE_TTL_MS) return hit.value
  const value = await worktreeOf(cwd)
  // Misses are cached too (a non-git cwd would otherwise spawn git on every sample).
  // Drop expired entries on insert so the map cannot grow with every distinct cwd.
  const now = Date.now()
  for (const [key, entry] of worktreeCache) if (now - entry.at >= WORKTREE_TTL_MS) worktreeCache.delete(key)
  worktreeCache.set(cwd, { at: now, value })
  return value
}

const recordedWorktree = (r) => (r && existsSync(r.root) ? { name: r.name, root: r.root, branch: r.branch, linked: true } : undefined)

const pct = (used, budget) => (budget > 0 ? Math.round((used / budget) * 1000) / 10 : undefined)

export function startStatusService(ctx, config, stateDir, signal, settings, worktrees, groups, { handoffs, followUp, voice } = {}) {
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

  // ---- Claude plan limits (five-hour and weekly windows, the numbers of Claude Code's /usage) ----
  // DSH never calls Anthropic for these. The claude-code LLM provider (option `rateLimitFile`) saves the reading
  // Claude Code reports with every run; this only reads that file (default <stateDir>/claude-rate-limit.json), so the
  // figures are as fresh as the last Claude call and nothing here can be rate limited or spend a token.
  const rateLimitPath = config.claudeRateLimitFile ?? join(stateDir, 'claude-rate-limit.json')
  const claudeEnabled = config.claudeUsage ?? true
  let claude = { enabled: claudeEnabled, limits: [], updatedAt: null, error: claudeEnabled ? 'no reading yet (appears after the next Claude Code call)' : 'disabled' }
  function refreshClaude() {
    if (!claudeEnabled) return
    try {
      const data = JSON.parse(readFileSync(rateLimitPath, 'utf8'))
      const limits = limitsFromReading(data)
      claude = limits.length > 0
        ? { enabled: true, limits, updatedAt: data.updatedAt ?? null, error: null }
        : { ...claude, error: 'the saved reading has no usable window' }
    } catch (error) {
      claude = { ...claude, error: error?.code === 'ENOENT' ? 'no reading yet (appears after the next Claude Code call)' : String(error?.message ?? error) }
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
      const over = ctxTokens !== undefined && ctxTokens >= capTokens
      const entry = {
        cwd,
        cap: capTokens && ctxTokens !== undefined
          ? { tokens: capTokens, warn: over || (Boolean(warnPct) && ctxTokens >= capTokens * warnPct / 100), over, autoResume: settings.get().autoResumeHandoff }
          : undefined,
        // A worktree the session was seen working in outranks its launch directory.
        worktree: recordedWorktree(worktrees?.get(id)) ?? (await cachedWorktreeOf(cwd)) ?? prev?.worktree,
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

  // One sample at a time: the 30s timer and the event-driven requests share this, so two samples can
  // never be in flight and write an older reading over a newer one. A request that arrives mid-sample
  // schedules exactly one follow-up run.
  let inFlight
  let again = false
  const runSample = () => {
    if (inFlight) { again = true; return inFlight }
    inFlight = sample()
      .catch(error => ctx.logger.warn(`hooks-tts: status sample failed: ${String(error)}`))
      .finally(() => {
        inFlight = undefined
        if (again) { again = false; void runSample() }
      })
    return inFlight
  }

  const run = () => {
    void refreshClaude()
    return runSample()
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref?.()

  // Event-driven refresh: re-sample (at most once per MIN_GAP_MS) when a step starts, a tool finishes
  // or a turn ends, so token and context figures follow the conversation instead of the 30s timer.
  const MIN_GAP_MS = 2000
  let sampleTimer
  let lastSampleAt = 0
  const requestSample = () => {
    if (sampleTimer) return
    sampleTimer = setTimeout(() => {
      sampleTimer = undefined
      lastSampleAt = Date.now()
      void runSample()
    }, Math.max(0, MIN_GAP_MS - (Date.now() - lastSampleAt)))
    sampleTimer.unref?.()
  }
  ctx.on('agent/pre-step', (_payload, next) => { requestSample(); return next() })
  ctx.on('tools/post-execute', (_exec, _result, next) => { requestSample(); return next() })
  ctx.on('agent/turn-stopping', () => { requestSample() })

  const workspaceIdOf = (id) => {
    try { return (ctx.get('workspaceRegistry') ?? ctx.workspaceRegistry)?.list().find((w) => w.sessionIds?.includes(id))?.id } catch { return undefined }
  }
  const workspaceList = () => {
    try { return ((ctx.get('workspaceRegistry') ?? ctx.workspaceRegistry)?.list() ?? []).map((w) => ({ id: w.id, title: w.title })) } catch { return [] }
  }
  const liveSessions = () => {
    // One registry scan per request, not one per live session.
    const owner = new Map()
    try { for (const w of (ctx.get('workspaceRegistry') ?? ctx.workspaceRegistry)?.list() ?? []) for (const sid of w.sessionIds ?? []) if (!owner.has(sid)) owner.set(sid, w.id) } catch { /* registry unavailable */ }
    return [...agents].map(([id, agent]) => {
      let title
      try { title = ctx.get('sessionTitle')?.get(agent.session)?.title } catch { /* untitled */ }
      return { id, title, workspaceId: owner.get(id) }
    })
  }

  // Every session that still exists: loaded ones plus those a workspace lists. Undefined while the registry has nothing
  // to say (not ready yet), so a startup race never empties the groups.
  const existingSessionIds = () => {
    try {
      const list = (ctx.get('workspaceRegistry') ?? ctx.workspaceRegistry)?.list() ?? []
      if (list.length === 0) return undefined
      const ids = new Set(agents.keys())
      for (const w of list) for (const sid of w.sessionIds ?? []) ids.add(sid)
      return ids
    } catch { return undefined }
  }

  // The /groups view, plus the sessions whose latest handoff note still exists (the menu offers "Follow-up from handoff").
  const groupsPayload = () => {
    // Sessions deleted since the last look leave their groups; a group with nothing in it goes away.
    const existing = existingSessionIds()
    if (existing) groups?.pruneMissing(existing.has.bind(existing))
    let withHandoff = []
    try { withHandoff = handoffs?.withHandoff() ?? [] } catch { /* best effort */ }
    return { ...buildGroupsView(groups?.list() ?? [], liveSessions(), workspaceList()), handoffs: withHandoff }
  }

  // The API rides the Host's own web server (same origin and port as the page, so the browser, Desktop and the
  // remote-access proxy all reach it). Every request must pass the Host's Host/Origin fence and cookie authentication.
  const handle = (req, res, admit) => {
    const rejection = admit(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    res.setHeader('Cache-Control', 'no-store')
    // Plain string split: URL parsing throws on a malformed request target, which must never reach the host process.
    if ((req.url ?? '').split('?')[0] === '/groups') {
      // Group names can quote the user's first request: other web pages are refused (like /settings). The loopback
      // bind is the real boundary; a local process can still send an Origin header.
      if (!['GET', 'POST'].includes(req.method)) { res.statusCode = 405; res.end(); return }
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST') {
        // Manual move of a session into / out of / between groups.
        let body = ''
        req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy() })
        req.on('end', () => {
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid JSON' })); return }
          const result = groups ? applyMove(groups, parsed, workspaceIdOf, (id) => agents.has(id) || workspaceIdOf(id) !== undefined, workspaceList) : { status: 503, error: 'groups unavailable' }
          res.statusCode = result.status
          res.end(JSON.stringify(result.error ? { error: result.error } : groupsPayload()))
        })
        return
      }
      res.end(JSON.stringify(groupsPayload()))
    } else if ((req.url ?? '').split('?')[0] === '/followup') {
      // "Follow-up from handoff": spawns a session, so only the DSH web page may call it (like /groups).
      if (!['GET', 'POST'].includes(req.method)) { res.statusCode = 405; res.end(); return }
      res.setHeader('Content-Type', 'application/json')
      let body = ''
      req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy() })
      req.on('end', async () => {
        let parsed
        try { parsed = JSON.parse(body || '{}') } catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid JSON' })); return }
        const out = await applyFollowUp(parsed, followUp)
        res.statusCode = out.status
        res.end(JSON.stringify(out.body))
      })
    } else if ((req.url ?? '').split('?')[0] === '/voice') {
      // Voice control state, and push-to-talk: only the DSH web page may call it (like /groups); POST acts on the mic.
      if (!['GET', 'POST'].includes(req.method)) { res.statusCode = 405; res.end(); return }
      res.setHeader('Content-Type', 'application/json')
      const svc = voice?.()
      if (req.method === 'POST') {
        let body = ''
        req.on('data', (d) => { body += d; if (body.length > 1024) req.destroy() })
        req.on('end', async () => {
          try {
            if (!svc) throw new Error('voice control is unavailable')
            await svc.control(String(JSON.parse(body || '{}').action))
            res.end(JSON.stringify(svc.status()))
          } catch (error) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(error?.message ?? error) }))
          }
        })
        return
      }
      res.end(JSON.stringify(svc ? svc.status() : { running: false, connection: 'disconnected', busy: false }))
    } else if (req.url?.startsWith('/settings')) {
      if (!['GET', 'POST'].includes(req.method)) { res.statusCode = 405; res.end(); return }
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
      res.end(JSON.stringify({ ...snapshot, settings: settings.get(), spawned: listSpawned() }))
    } else {
      res.statusCode = 404
      res.end()
    }
  }
  // Mounted under STATUS_PREFIX; the handler routes on the path below it.
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: STATUS_PREFIX,
      handler: (req, res) => {
        req.url = (req.url ?? '/').slice(STATUS_PREFIX.length) || '/'
        handle(req, res, (request) => { const admission = webCtx.connection.admit(request); return 'rejection' in admission ? admission.rejection : undefined })
      },
    }), 'hooks-tts: status routes')
  })

  const stop = () => { clearInterval(timer); clearTimeout(sampleTimer) }
  signal.addEventListener('abort', stop, { once: true })
}
