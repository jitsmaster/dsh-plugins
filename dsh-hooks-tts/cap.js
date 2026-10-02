/**
 * Context cap: when a session's context grows past `contextCapTokens` (default
 * 400k), the next step is entered with an instruction to stop the current work
 * and write a handoff note immediately. Checked before every step
 * (agent/pre-step) and again when a turn is about to close (agent/turn-stopping),
 * so the agent never keeps working past the cap.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { recordSpawn } from './spawned.js'
const DEFAULT_HANDOFF_DIR = join(homedir(), '.dsh', 'handoffs')

export function contextTokens(ctx, agent) {
  try {
    const view = ctx.get('sessionProjections')?.snapshot(agent.session, ['contextPressure'])?.values?.contextPressure
    return view?.projectedTokens ?? view?.pressureTokens
  } catch {
    return undefined
  }
}

function handoffPath(dir, agent) {
  const cwd = agent.session?.header?.cwd ?? ''
  const project = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? 'session'
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  return join(dir, `${project}-${stamp}-handoff.md`)
}

/** A resumed session that hits the cap within this long counts as a "short" session. */
const SHORT_SESSION_MS = 20 * 60 * 1000
/** This many consecutive short resumed sessions switch the next handoff to forward mode. */
const SHORT_STREAK_FOR_FORWARD = 3

function instruction(tokens, cap, path, forward, previousNote) {
  const k = n => `${Math.round(n / 1000)}k`
  const sections = forward
    ? [
      'FORWARD MODE: the last several sessions each hit the cap within 20 minutes, so keep this handoff lean (the modes:sparc "Forward Mode" format). Do NOT write Previous Work, Key Decisions or a narrative Current State.',
      'Use exactly these sections: "# <short title> Handoff", "## Context Carried Forward", "## What\'s Left" (numbered, concrete next actions), and "## Open Questions" only if something still blocks execution.',
      `"## Context Carried Forward" starts with the line "Worktree: <absolute path> · branch <branch>" (the directory your commands and edits actually run in; verify with \`git rev-parse --show-toplevel\`, \`git branch --show-current\` and \`git worktree list\`; if no linked worktree is used write "Worktree: none (main checkout <path>, branch <branch>)"), then "Supersedes: ${previousNote ?? 'none'}" (history lives there and in git log, not repeated), then only facts the next session cannot re-derive from the code or git log (tokens, env quirks, transient blockers, anomalies in git status/log).`,
      'Also tell the user in your final reply that sessions are hitting the cap quickly and the context cap may be too low or the resume too heavy.',
    ]
    : [
      'Use exactly these sections: "# <short title> Handoff", "## Previous Work (summary only)", "## Key Decisions", "## Current State" (branch, repo/worktree, commits, uncommitted changes, running processes), "## What\'s Left" (numbered, concrete next actions), "## Open Questions".',
      'In "## Current State" the FIRST line must be "Worktree: <absolute path> · branch <branch>": the directory your commands and edits actually run in (may differ from the session launch directory, e.g. a .claude/worktrees/<name> checkout). Verify with `git rev-parse --show-toplevel`, `git branch --show-current` and `git worktree list`; if no linked worktree is used write "Worktree: none (main checkout <path>, branch <branch>)". The resuming session continues in exactly that worktree.',
    ]
  return [
    `CONTEXT CAP REACHED: this session's context is ${k(tokens)} tokens, over the ${k(cap)} limit.`,
    'Stop the current work immediately — do not start or continue any task, tool exploration, or edit beyond what the handoff needs.',
    `Write a handoff note NOW to: ${path}`,
    'Directly under the title put one line: "Mode: sparc" if this session is running under the modes:sparc / sparcr skill (SPARC mode), otherwise "Mode: plain". The resuming session uses this line to decide whether to continue in SPARC mode.',
    ...sections,
    'Be specific (file paths, commands, ids) so a fresh session can resume without this conversation. Create the folder if it is missing.',
    'After the file is written, reply with the file path and a two-line summary, then stop. A new session should pick the work up from the note.',
  ].join('\n')
}

const kTokens = n => `${Math.round(n / 1000)}k`

/** Heads-up before the cap, with auto-handoff ON: the agent will stop and hand off at the cap. */
function warning(tokens, cap, pct) {
  return [
    `CONTEXT CAP WARNING: this session's context is ${kTokens(tokens)} tokens, ${pct}% of the way to the ${kTokens(cap)} handoff limit.`,
    `In your next reply, tell the user plainly that the session is nearing the limit and that at ${kTokens(cap)} you will stop, write a handoff note and a new session will open automatically to continue it.`,
    'Suggest they wrap up or redirect now if they want a clean stopping point. Finish the current step cleanly; do not start large new tasks. Do not write the handoff note yet.',
  ].join('\n')
}

/** Notice with auto-handoff OFF: nothing will stop or hand off on its own, so only inform the user. */
function notice(tokens, cap, over) {
  return [
    over
      ? `CONTEXT NOTICE: this session's context is ${kTokens(tokens)} tokens, over the ${kTokens(cap)} cap. Automatic handoff is OFF, so you will NOT be stopped: the session continues past the cap and no new session opens.`
      : `CONTEXT NOTICE: this session's context is ${kTokens(tokens)} tokens, nearing the ${kTokens(cap)} cap. Automatic handoff is OFF, so you will NOT be stopped when it is reached: the session continues past the cap and no new session opens.`,
    'In your next reply, tell the user briefly that you will keep working past the cap, and recommend handing off (compacting the conversation or starting a new session) as soon as it is convenient. Never say or imply that the session will stop at the cap. Do not write a handoff note unless the user asks, and continue the current work normally.',
  ].join('\n')
}

export function installContextCap(ctx, config, { skip, makeMessage, settings }) {
  const dir = config.handoffDir ?? DEFAULT_HANDOFF_DIR
  const instructed = new Set()
  const warned = new Set()
  /** agent.id -> { path, cwd } for handoffs requested but not yet picked up by a new session. */
  const pending = new Map()
  /** Resumed session id -> { startedAt, streak, note }: streak = consecutive short sessions before it; note = the handoff it resumed from. */
  const resumed = new Map()
  let lastCap
  /** Diagnostic trail for the auto-resume flow: <stateDir>/spawn.log. */
  const trace = (line) => {
    try { appendFileSync(join(dirname(settings.path), 'spawn.log'), `${new Date().toISOString()} ${line}\n`) } catch { /* best effort */ }
  }

  /**
   * The message to add for this agent, or undefined. With auto-handoff on: a heads-up near the cap, then the
   * stop-and-write-a-handoff instruction over it. With auto-handoff off: only informational notices, never an
   * instruction to stop or write a note. `allowWarn` is false when a turn is stopping (a steer would restart it).
   */
  const check = (agent, allowWarn = true) => {
    if (skip(agent)) return undefined
    // Read the live setting on every check, so a change applies from the very next step.
    const cap = settings.get().contextCapTokens
    if (cap !== lastCap) { lastCap = cap; instructed.clear(); warned.clear() } // a changed cap re-arms every session
    if (!cap) return undefined // 0 = disabled
    const tokens = contextTokens(ctx, agent)
    if (tokens === undefined) return undefined
    const autoResume = settings.get().autoResumeHandoff
    const warnPct = settings.get().warnPercent
    const warnAt = warnPct ? cap * warnPct / 100 : undefined
    // Re-arm once context drops well below the cap or the warning point (compaction, a new baseline).
    if (tokens < cap * 0.9) instructed.delete(agent.id)
    if (warnAt === undefined || tokens < warnAt * 0.9) warned.delete(agent.id)
    if (tokens < cap) {
      // Once per session, only when entering a step.
      if (allowWarn && warnAt !== undefined && tokens >= warnAt && !warned.has(agent.id)) {
        warned.add(agent.id)
        trace(`cap warning for ${agent.id} (${tokens}/${cap}, autoResume ${autoResume})`)
        return makeMessage(autoResume ? warning(tokens, cap, Math.round(tokens / cap * 100)) : notice(tokens, cap, false))
      }
      return undefined
    }
    if (instructed.has(agent.id)) return undefined
    if (!autoResume) {
      // Auto-handoff is off: tell the user once that the cap is passed, but never stop the agent or request a note.
      if (!allowWarn) return undefined
      instructed.add(agent.id)
      trace(`over cap, auto-handoff off: notice only for ${agent.id} (${tokens}/${cap})`)
      return makeMessage(notice(tokens, cap, true))
    }
    instructed.add(agent.id)
    const path = handoffPath(dir, agent)
    // Short-session streak: only a session that was itself spawned from a handoff can count; its
    // age is time since the spawn. Under 20 min extends the streak, otherwise it resets.
    const origin = resumed.get(agent.id)
    const ageMs = origin ? Date.now() - origin.startedAt : undefined
    const streak = origin && ageMs < SHORT_SESSION_MS ? origin.streak + 1 : 0
    const forward = streak >= SHORT_STREAK_FOR_FORWARD
    pending.set(agent.id, { path, cwd: agent.session?.header?.cwd, streak })
    ctx.logger.warn(`hooks-tts: context ${tokens} exceeds cap ${cap}; requesting handoff`)
    trace(`handoff requested for ${agent.id} (${tokens}/${cap}) -> ${path}; session age ${ageMs === undefined ? 'n/a (not a resumed session)' : `${Math.round(ageMs / 60000)}min`}, short streak ${streak}, mode ${forward ? 'FORWARD' : 'normal'}`)
    return makeMessage(instruction(tokens, cap, path, forward, origin?.note))
  }

  const fullAccessChecked = new Set()
  const PERMISSION_EVENT_TYPES = new Set(['permission/preset', 'sandbox/mode', 'approval/policy'])

  /**
   * "Always allow full access": start NEW sessions at full access / never ask. Runs once per session
   * and only while the session has no finished turn and no permission change beyond the initial pin,
   * so a mode the user picks later (or an existing/resumed session) is never reset.
   */
  function enforceFullAccess(agent) {
    if (!settings.get().alwaysFullAccess) return
    if (fullAccessChecked.has(agent.id)) return
    fullAccessChecked.add(agent.id)
    try {
      const session = agent.session
      const events = session.snapshotEvents()
      if (events.some((e) => e.type === 'turn/end')) return
      const permissionEvents = events.filter((e) => PERMISSION_EVENT_TYPES.has(e.type))
      const perType = (type) => permissionEvents.filter((e) => e.type === type).length
      if ([...PERMISSION_EVENT_TYPES].some((type) => perType(type) > 1)) return
      const last = (type) => events.findLast((e) => e.type === type)?.data
      if (last('permission/preset')?.preset !== 'danger-full-access') session.append('permission/preset', { preset: 'danger-full-access' })
      if (last('sandbox/mode')?.mode !== 'danger-full-access') session.append('sandbox/mode', { mode: 'danger-full-access' })
      if (last('approval/policy')?.policy !== 'never') session.append('approval/policy', { policy: 'never' })
    } catch (error) { trace(`full access enforce failed: ${error?.stack ?? error}`) }
  }

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    enforceFullAccess(agent)
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    const message = check(agent)
    return message ? { ...downstream, messages: [...downstream.messages, message] } : downstream
  })

  /**
   * Build the first prompt of the resumed session. The handoff's "Mode:" line decides:
   * sparc -> the sparcr flow (the note is already the chosen handoff, so go straight to
   * modes:sparc "Resuming from a Handoff"), with the modes:sparc command text inlined because
   * DSH exposes no Skill for it; plain -> a simple resume instruction.
   */
  function resumePrompt(path) {
    let note = ''
    try { note = readFileSync(path, 'utf8') } catch { /* fall through to plain */ }
    const sparc = /^\s*mode\s*:\s*sparc\b/im.test(note)
    if (!sparc) {
      return { sparc: false, value: `Resume the work from this handoff note. Read it first, then continue with its "What's Left" items. First read the "Worktree:" line (in "Current State", or "Context Carried Forward" in a forward-mode note) and run every command and edit in that absolute path (use it as workdir; do not create a new worktree). Keep the same worktree in any further handoff:\n${path}` }
    }
    const file = config.sparcCommandPath ?? join(homedir(), '.claude', 'commands', 'modes', 'sparc.md')
    let body = ''
    try { body = readFileSync(file, 'utf8').replace(/^---[\s\S]*?\n---\s*/, '') } catch (error) { trace(`could not read ${file}: ${error}`) }
    const head = [
      `Continue from handoff at ${path}.`,
      'This is the /sparcr flow: the user already selected this handoff, so treat it as the answer to Step -1 and go directly to the "Resuming from a Handoff" steps of modes:sparc below (skip the handoff listing; do not run Step 0 onward until the handoff says so).',
      'Remain in SPARC mode for the whole session, including writing the next handoff in the sparc format when needed.',
    ].join('\n')
    return { sparc: true, value: body ? `${head}\n\n--- modes:sparc skill content ---\n${body}` : `${head}\nInvoke Skill(modes:sparc) if available.` }
  }

  /** Once the handoff note exists, open a fresh session in the same folder that resumes from it. */
  async function spawnResume(agent) {
    const job = pending.get(agent.id)
    if (!job) return
    if (!existsSync(job.path)) { trace(`turn ended for ${agent.id}; note not found yet: ${job.path}`); return }
    pending.delete(agent.id)
    if (!settings.get().autoResumeHandoff) { trace('autoResumeHandoff is off'); return }
    try {
      const sc = ctx.get('sessionController') ?? ctx.sessionController
      trace(`spawning from ${job.path}; controller=${sc ? 'found' : 'MISSING'}`)
      // Prefer the source session's workspace so the new session is grouped with it (not "Ungrouped").
      let workspaceId
      try {
        const registry = ctx.get('workspaceRegistry') ?? ctx.workspaceRegistry
        workspaceId = registry?.list().find((w) => w.sessionIds?.includes(agent.id))?.id
      } catch (error) { trace(`workspace lookup failed: ${error}`) }
      trace(`workspace: ${workspaceId ?? 'none (using cwd)'}`)
      const created = await sc.create(workspaceId ? { workspaceId } : job.cwd ? { cwd: job.cwd } : {})
      // Same access level as the source: copy its last permission/preset, sandbox/mode and approval/policy.
      // Session.append writes the log only, so no other side effects are triggered.
      try {
        const resolved = await sc.resolveAgent(created.sessionId)
        if (!resolved.agent) throw new Error(`resolveAgent returned no agent: ${JSON.stringify(resolved.error ?? resolved)}`)
        const target = resolved.agent.session
        const events = agent.session.snapshotEvents()
        for (const type of ['permission/preset', 'sandbox/mode', 'approval/policy']) {
          const last = events.findLast((e) => e.type === type)
          if (last) {
            const { source, ...data } = last.data ?? {}
            target.append(type, data)
            trace(`copied ${type}: ${JSON.stringify(data)}`)
          }
        }
      } catch (error) { trace(`access copy failed: ${error?.stack ?? error}`) }
      // Numbered title: "x" -> "x - 2", "x - 2" / "x -2" -> "x - 3".
      try {
        const titles = ctx.get('sessionTitle')
        const old = titles?.get(agent.session)?.title
        if (old) {
          const m = /^(.*?)\s*-\s*(\d+)$/.exec(old)
          const next = m ? `${m[1]} - ${Number(m[2]) + 1}` : `${old} - 2`
          await sc.rename({ sessionId: created.sessionId, title: next })
          trace(`renamed "${old}" -> "${next}"`)
        } else trace('source has no title; not renaming')
      } catch (error) { trace(`rename failed: ${error?.stack ?? error}`) }
      const text = resumePrompt(job.path)
      trace(`prompt kind: ${text.sparc ? 'sparc' : 'plain'}`)
      await sc.prompt({
        requestId: `handoff-${randomUUID()}`,
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: text.value }],
      }, AbortSignal.timeout(30_000)) // the Remote method requires a caller signal
      resumed.set(created.sessionId, { startedAt: Date.now(), streak: job.streak ?? 0, note: job.path })
      recordSpawn(agent.id, created.sessionId)
      ctx.logger.info(`hooks-tts: spawned ${created.sessionId} from handoff ${job.path}`)
      trace(`spawned ${created.sessionId}`)
    } catch (error) {
      trace(`FAILED: ${error?.stack ?? error}`)
      ctx.logger.warn(`hooks-tts: could not spawn resume session: ${String(error)}`)
    }
  }

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    await spawnResume(agent)
    const message = check(agent, false)
    if (message) agent.steer(message)
  })
}
