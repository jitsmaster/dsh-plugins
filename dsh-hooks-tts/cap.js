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

function instruction(tokens, cap, path) {
  const k = n => `${Math.round(n / 1000)}k`
  return [
    `CONTEXT CAP REACHED: this session's context is ${k(tokens)} tokens, over the ${k(cap)} limit.`,
    'Stop the current work immediately — do not start or continue any task, tool exploration, or edit beyond what the handoff needs.',
    `Write a handoff note NOW to: ${path}`,
    'Directly under the title put one line: "Mode: sparc" if this session is running under the modes:sparc / sparcr skill (SPARC mode), otherwise "Mode: plain". The resuming session uses this line to decide whether to continue in SPARC mode.',
    'Use exactly these sections: "# <short title> Handoff", "## Previous Work (summary only)", "## Key Decisions", "## Current State" (branch, repo/worktree, commits, uncommitted changes, running processes), "## What\'s Left" (numbered, concrete next actions), "## Open Questions".',
    'In "## Current State" the FIRST line must be "Worktree: <absolute path> · branch <branch>": the directory your commands and edits actually run in (may differ from the session launch directory, e.g. a .claude/worktrees/<name> checkout). Verify with `git rev-parse --show-toplevel`, `git branch --show-current` and `git worktree list`; if no linked worktree is used write "Worktree: none (main checkout <path>, branch <branch>)". The resuming session continues in exactly that worktree.',
    'Be specific (file paths, commands, ids) so a fresh session can resume without this conversation. Create the folder if it is missing.',
    'After the file is written, reply with the file path and a two-line summary, then stop. A new session should pick the work up from the note.',
  ].join('\n')
}

export function installContextCap(ctx, config, { skip, makeMessage, settings }) {
  const dir = config.handoffDir ?? DEFAULT_HANDOFF_DIR
  const instructed = new Set()
  /** agent.id -> { path, cwd } for handoffs requested but not yet picked up by a new session. */
  const pending = new Map()
  let lastCap
  /** Diagnostic trail for the auto-resume flow: <stateDir>/spawn.log. */
  const trace = (line) => {
    try { appendFileSync(join(dirname(settings.path), 'spawn.log'), `${new Date().toISOString()} ${line}\n`) } catch { /* best effort */ }
  }

  /** The instruction message for this agent when over the cap and not yet told; else undefined. */
  const check = (agent) => {
    if (skip(agent)) return undefined
    // Read the live setting on every check, so a change applies from the very next step.
    const cap = settings.get().contextCapTokens
    if (cap !== lastCap) { lastCap = cap; instructed.clear() } // a changed cap re-arms every session
    if (!cap) return undefined // 0 = disabled
    const tokens = contextTokens(ctx, agent)
    if (tokens === undefined) return undefined
    // Re-arm once context drops well below the cap (compaction, a new baseline).
    if (tokens < cap * 0.9) { instructed.delete(agent.id); return undefined }
    if (tokens < cap || instructed.has(agent.id)) return undefined
    instructed.add(agent.id)
    const path = handoffPath(dir, agent)
    pending.set(agent.id, { path, cwd: agent.session?.header?.cwd })
    ctx.logger.warn(`hooks-tts: context ${tokens} exceeds cap ${cap}; requesting handoff`)
    trace(`handoff requested for ${agent.id} (${tokens}/${cap}) -> ${path}`)
    return makeMessage(instruction(tokens, cap, path))
  }

  /** "Always allow full access": force every session to full access / never ask, checked each step. */
  function enforceFullAccess(agent) {
    if (!settings.get().alwaysFullAccess) return
    try {
      const session = agent.session
      const events = session.snapshotEvents()
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
      return { sparc: false, value: `Resume the work from this handoff note. Read it first, then continue with its "What's Left" items. First read the "Worktree:" line in "Current State" and run every command and edit in that absolute path (use it as workdir; do not create a new worktree). Keep the same worktree in any further handoff:\n${path}` }
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
      ctx.logger.info(`hooks-tts: spawned ${created.sessionId} from handoff ${job.path}`)
      trace(`spawned ${created.sessionId}`)
    } catch (error) {
      trace(`FAILED: ${error?.stack ?? error}`)
      ctx.logger.warn(`hooks-tts: could not spawn resume session: ${String(error)}`)
    }
  }

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    await spawnResume(agent)
    const message = check(agent)
    if (message) agent.steer(message)
  })
}
