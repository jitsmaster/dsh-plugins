/**
 * Context cap: when a session's context grows past `contextCapTokens` (default
 * 400k), the next step is entered with an instruction to stop the current work
 * and write a handoff note immediately. Checked before every step
 * (agent/pre-step) and again when a turn is about to close (agent/turn-stopping),
 * so the agent never keeps working past the cap.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { isPrSession, PR_TITLE } from './pr.js'
import { firstRequest } from './groups.js'
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

/** True when the session loaded the modes:sparc skill text (its content block carries this marker). */
function ranSparc(agent) {
  try { return /Boomerang Commander Mode|modes:sparc skill content/.test(JSON.stringify(agent.session.snapshotEvents())) } catch { return false }
}

/** A resumed session that hits the cap within this long counts as a "short" session. */
const SHORT_SESSION_MS = 20 * 60 * 1000
/** This many consecutive short resumed sessions switch the next handoff to forward mode. */
const SHORT_STREAK_FOR_FORWARD = 3

function instruction(tokens, cap, path, forward, previousNote, prLines = [], headline) {
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
    headline ?? `CONTEXT CAP REACHED: this session's context is ${k(tokens)} tokens, over the ${k(cap)} limit.`,
    'Stop the current work immediately — do not start or continue any task, tool exploration, or edit beyond what the handoff needs.',
    `Write a handoff note NOW to: ${path}`,
    'Directly under the title put one line: "Mode: sparc" if this session is running under the modes:sparc / sparcr skill (SPARC mode), otherwise "Mode: plain". The resuming session uses this line to decide whether to continue in SPARC mode.',
    ...sections,
    ...(prLines.length ? ['In "## Current State" include these lines verbatim (each on its own line) so a resuming session can re-register the PR comment poll:', ...prLines] : []),
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
function notice(tokens, cap, over, prState = false, prLines = []) {
  // A session in PR state is never handed off, whatever the global setting says.
  const why = prState ? 'This session is in PR state (titled "PR <n>"), so it is never handed off automatically' : 'Automatic handoff is OFF'
  return [
    over
      ? `CONTEXT NOTICE: this session's context is ${kTokens(tokens)} tokens, over the ${kTokens(cap)} cap. ${why}, so you will NOT be stopped: the session continues past the cap and no new session opens.`
      : `CONTEXT NOTICE: this session's context is ${kTokens(tokens)} tokens, nearing the ${kTokens(cap)} cap. ${why}, so you will NOT be stopped when it is reached: the session continues past the cap and no new session opens.`,
    'In your next reply, tell the user briefly that you will keep working past the cap, and recommend handing off (compacting the conversation or starting a new session) as soon as it is convenient. Never say or imply that the session will stop at the cap. Do not write a handoff note unless the user asks, and continue the current work normally.',
    ...(prLines.length ? ['If you do write a handoff note yourself, include these lines verbatim so a resuming session can re-register the PR comment poll:', ...prLines] : []),
  ].join('\n')
}

export function installContextCap(ctx, config, { skip, makeMessage, settings, prHandoff, groups }) {
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
    // A session titled "PR <n>" is never handed off or respawned; the global setting itself is left alone.
    const prState = isPrSession(ctx, agent)
    const prLines = prHandoff?.(agent) ?? []
    const autoResume = settings.get().autoResumeHandoff && !prState
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
        return makeMessage(autoResume ? warning(tokens, cap, Math.round(tokens / cap * 100)) : notice(tokens, cap, false, prState, prLines))
      }
      return undefined
    }
    if (instructed.has(agent.id)) return undefined
    if (!autoResume) {
      // Auto-handoff is off: tell the user once that the cap is passed, but never stop the agent or request a note.
      if (!allowWarn) return undefined
      instructed.add(agent.id)
      trace(`over cap, auto-handoff off: notice only for ${agent.id} (${tokens}/${cap})`)
      return makeMessage(notice(tokens, cap, true, prState, prLines))
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
    return makeMessage(instruction(tokens, cap, path, forward, origin?.note, prLines))
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
  function resumePrompt(path, fromPr = false, prId, sourceSparc = false, forceMode) {
    let note = ''
    try { note = readFileSync(path, 'utf8') } catch { /* fall through to plain */ }
    // An explicit "Mode:" line in the note decides; without one, follow the source session (SPARC in, SPARC out).
    const modeLine = /^\s*mode\s*:\s*(sparc|plain)\b/im.exec(note)?.[1]?.toLowerCase()
    const sparc = forceMode ? forceMode === 'sparc' : modeLine ? modeLine === 'sparc' : sourceSparc
    // The note's PR-POLL line is repeated on its own line; the PR poller re-registers from it (pr.js).
    // Not for a spawn out of a merged PR: that session must not re-enter PR state.
    // A hand-over after PR creation always starts the poll in the new session.
    const prMarker = prId ? `PR-POLL: ${prId}` : fromPr ? undefined : /^PR-POLL:.*$/m.exec(note)?.[0]
    const withMarker = (value) => (prMarker ? `${value}\n${prMarker.trim()}` : value)
    if (!sparc) {
      return { sparc: false, value: withMarker(`Resume the work from this handoff note. Read it first, then continue with its "What's Left" items. First read the "Worktree:" line (in "Current State", or "Context Carried Forward" in a forward-mode note) and run every command and edit in that absolute path (use it as workdir; do not create a new worktree). Keep the same worktree in any further handoff:\n${path}`) }
    }
    const file = config.sparcCommandPath ?? join(homedir(), '.claude', 'commands', 'modes', 'sparc.md')
    let body = ''
    try { body = readFileSync(file, 'utf8').replace(/^---[\s\S]*?\n---\s*/, '') } catch (error) { trace(`could not read ${file}: ${error}`) }
    const head = [
      `Continue from handoff at ${path}.`,
      'This is the /sparcr flow: the user already selected this handoff, so treat it as the answer to Step -1 and go directly to the "Resuming from a Handoff" steps of modes:sparc below (skip the handoff listing; do not run Step 0 onward until the handoff says so).',
      'Remain in SPARC mode for the whole session, including writing the next handoff in the sparc format when needed.',
    ].join('\n')
    return { sparc: true, value: withMarker(body ? `${head}\n\n--- modes:sparc skill content ---\n${body}` : `${head}\nInvoke Skill(modes:sparc) if available.`) }
  }

  /** The workspace the session belongs to, if the registry knows it. */
  function workspaceOf(agent) {
    try {
      const registry = ctx.get('workspaceRegistry') ?? ctx.workspaceRegistry
      return registry?.list().find((w) => w.sessionIds?.includes(agent.id))?.id
    } catch (error) { trace(`workspace lookup failed: ${error}`); return undefined }
  }

  /**
   * The session's group, created when it has none (PR creation and handoff both start one). Named after the
   * session: its title if it names the work, else a summary of its first request.
   */
  function groupFor(agent) {
    if (!groups) return undefined
    try {
      // Naming scans the whole conversation, so it is built only when a group is actually created.
      const naming = () => ({ title: ctx.get('sessionTitle')?.get(agent.session)?.title, request: () => firstRequest(agent), cwd: agent.session?.header?.cwd })
      const group = groups.ensureGroup(agent.id, workspaceOf(agent), naming)
      trace(`group for ${agent.id}: ${group.id}, ${group.sessionIds.length} member(s)`)
      return group
    } catch (error) { trace(`group failed: ${error?.stack ?? error}`); return undefined }
  }

  /** Once the handoff note exists, open a fresh session in the same folder that resumes from it. */
  async function spawnResume(agent) {
    const job = pending.get(agent.id)
    if (!job) return
    if (job.prId) return handleHandover(agent, job)
    // Checked live: a rename to "PR <n>" after the handoff was requested still cancels the respawn.
    if (isPrSession(ctx, agent)) { pending.delete(agent.id); trace(`PR-state session ${agent.id}: no auto-respawn`); return }
    if (!existsSync(job.path)) { trace(`turn ended for ${agent.id}; note not found yet: ${job.path}`); return }
    pending.delete(agent.id)
    if (!settings.get().autoResumeHandoff) { trace('autoResumeHandoff is off'); return }
    await spawnSession(agent, job)
  }

  const prHandovers = new Set()
  const NO_REMAINING = /^\s*NO-REMAINING-WORK\s*$/

  /**
   * A session just created PR `id`. At the end of its turn it writes TWO notes (the PR note and the remaining-work
   * note); two new sessions then take over: "PR <id>" (polls the PR comments, never respawned at the cap) and
   * "<title> - after PR <id>" (asks the user before doing anything). Spawned whatever the auto-resume setting says.
   */
  async function prCreated(agent, id) {
    if (skip(agent) || isPrSession(ctx, agent) || prHandovers.has(agent.id)) return
    prHandovers.add(agent.id)
    groupFor(agent) // the PR starts the group; the spawned PR and follow-up sessions join it
    const base = handoffPath(dir, agent).replace(/-\d{8}-\d{4}-handoff\.md$/, '')
    const stamp = /(-\d{8}-\d{4})-handoff\.md$/.exec(handoffPath(dir, agent))?.[1] ?? ''
    // The notes are requested when the turn ends (handleHandover), so the rest of the PR skill (reviewer,
    // auto-complete, work item, notification) still runs in this session first.
    pending.set(agent.id, {
      prId: id, attempts: 0, cwd: agent.session?.header?.cwd, streak: 0,
      pr: `${base}-pr-${id}${stamp}-handoff.md`, rest: `${base}-after-pr-${id}${stamp}-handoff.md`,
    })
    trace(`PR ${id} created in ${agent.id}: hand-over notes are requested at the end of the turn`)
  }

  const prInstruction = (job) => [
    `PR ${job.prId} WAS JUST CREATED. Two new sessions take over from this one, so write TWO handoff notes now, then stop. Do not do any other work.`,
    `PR handoff note path: ${job.pr}`,
    `Remaining-work handoff note path: ${job.rest}`,
    '',
    `1) PR handoff note: cover ONLY PR ${job.prId} and nothing about remaining work. Title "# PR ${job.prId} Handoff", then the line "Mode: plain". Include the PR URL, source and target branch, and "Worktree: <absolute path> · branch <branch>" (the directory your commands and edits actually run in; verify with \`git rev-parse --show-toplevel\`, \`git branch --show-current\` and \`git worktree list\`). Its only job is to poll the PR's review comments (the plugin does the polling) and run the ado-pr-implement skill on new comments up to its approval gate.`,
    `2) Remaining-work handoff note: ONLY the tasks still remaining after this PR. Use the sparc handoff sections ("# <short title> Handoff", "## Previous Work (summary only)", "## Key Decisions", "## Current State", "## What's Left" with numbered concrete steps, "## Open Questions"). Directly under the title put "Mode: sparc" if this session runs under the modes:sparc / sparcr skill, otherwise "Mode: plain". Mark every task that needs code from PR ${job.prId} with "(after merge)". The resuming session creates its own worktree from origin/develop, so the "Worktree:" line must read: "Worktree: none (the resuming session creates its own from origin/develop)". If nothing remains, write the file with the single line NO-REMAINING-WORK.`,
    'Be specific (file paths, commands, ids). Create the folder if it is missing. When both files are written, reply with the two paths and a two-line summary, then stop.',
  ].join('\n')

  /** PR hand-over state machine: ask once, remind once, then spawn what exists (the PR session is the priority). */
  async function handleHandover(agent, job) {
    if (job.attempts === 0) {
      job.attempts = 1
      agent.steer(makeMessage(prInstruction(job)))
      trace(`requested hand-over notes for PR ${job.prId} from ${agent.id}`)
      return
    }
    const missing = [['PR handoff note', job.pr], ['Remaining-work handoff note', job.rest]].filter(([, p]) => !existsSync(p))
    if (missing.length && job.attempts === 1) {
      job.attempts = 2
      agent.steer(makeMessage(`REMINDER: these PR ${job.prId} hand-over notes are still missing, write them now and then stop:\n${missing.map(([label, p]) => `${label} path: ${p}`).join('\n')}`))
      trace(`reminded ${agent.id} about ${missing.length} missing hand-over note(s)`)
      return
    }
    pending.delete(agent.id)
    if (!existsSync(job.pr)) {
      try {
        writeFileSync(job.pr, `# PR ${job.prId} Handoff\nMode: plain\n\nPR ${job.prId} was created. Worktree: ${job.cwd ?? 'unknown'} · branch (check \`git branch --show-current\`)\n\nOnly job: poll the PR's review comments and run ado-pr-implement on new ones up to its approval gate.\n`)
        trace(`PR note missing: wrote fallback ${job.pr}`)
      } catch (error) { trace(`fallback PR note failed: ${error}`); return }
    }
    const rest = existsSync(job.rest) ? readFileSync(job.rest, 'utf8') : undefined
    const extra = rest === undefined
      ? '\n\nNote: the previous session\'s remaining-work handoff was not written (or not found). Tell the user; the remaining work may need to be handed over manually.'
      : ''
    await spawnSession(agent, { ...job, path: job.pr, kind: 'pr', extra })
    if (rest !== undefined && !NO_REMAINING.test(rest)) await spawnSession(agent, { ...job, path: job.rest, kind: 'after' })
  }

  /** The first message of the remaining-work session: it asks before doing anything. */
  const afterPrPrompt = (job, resume) => [
    `PR ${job.prId} was just created by the session this one continues. Do NOT start any work yet and do not read or edit anything.`,
    `Use the \`ask_user_question\` tool now to ask the user: "PR ${job.prId} was created. Start the remaining work now, or wait for PR approval (merge)?" with exactly two options: "Start now" / "Wait for PR approval".`,
    '- If the user answers "Start now": start as described below.',
    `- If the user answers "Wait for PR approval": run this shell command and nothing else: \`echo PR-WAIT: ${job.prId}\`, then stop and do nothing. A later message will tell you when PR ${job.prId} is merged or abandoned; then ask the user again and start on Yes.`,
    `When you start: FIRST create your own git worktree from the latest origin/develop in the repository the handoff names (\`git fetch origin develop\`, \`git worktree add <new path> -b <new branch> origin/develop\`, then \`pnpm install\` in it) and work ONLY there; ignore any other Worktree line. Tasks marked "(after merge)" need PR ${job.prId}'s code: do the others first, and for those wait until PR ${job.prId} is merged, then rebase onto origin/develop. Your work lands in a NEW follow-up PR from your own branch.`,
    '',
    resume,
  ].join('\n')

  /** Create the continuation session for a handoff note. Returns the new session id, or undefined on failure. */
  async function spawnSession(agent, job) {
    try {
      const sc = ctx.get('sessionController') ?? ctx.sessionController
      trace(`spawning from ${job.path}; controller=${sc ? 'found' : 'MISSING'}`)
      // Prefer the source session's workspace so the new session is grouped with it (not "Ungrouped").
      const workspaceId = workspaceOf(agent)
      trace(`workspace: ${workspaceId ?? 'none (using cwd)'}`)
      const created = await sc.create(workspaceId ? { workspaceId } : job.cwd ? { cwd: job.cwd } : {})
      // Handoff and PR continuations all live in the group of the session they come from (created if it has none).
      const group = groupFor(agent)
      if (group) groups.addToGroup(group.id, created.sessionId)
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
          // A numbered "PR 12 - 2" would itself be PR-titled (never respawned, polled), so prefix instead.
          const next = job.kind === 'pr' ? `PR ${job.prId}` : job.kind === 'after' ? `${old} - after PR ${job.prId}` : PR_TITLE.test(old) ? `Continue ${old}` : m ? `${m[1]} - ${Number(m[2]) + 1}` : `${old} - 2`
          await sc.rename({ sessionId: created.sessionId, title: next })
          trace(`renamed "${old}" -> "${next}"`)
        } else trace('source has no title; not renaming')
      } catch (error) { trace(`rename failed: ${error?.stack ?? error}`) }
      let text
      if (job.kind === 'pr') {
        text = {
          sparc: false,
          value: [
            `This is the PR session for PR ${job.prId}. Read the handoff note first: ${job.path}`,
            `Your ONLY job: the plugin polls PR ${job.prId}'s review comments and queues new ones into this session; when a message reports new comments, run the ado-pr-implement skill on PR ${job.prId} up to its user-approval gate. Do not start any other work. Reply with one line confirming you are ready, then wait.${job.extra ?? ''}`,
            `PR-POLL: ${job.prId}`,
          ].join('\n'),
        }
      } else if (job.kind === 'after') {
        const resume = resumePrompt(job.path, undefined, undefined, true, 'sparc')
        text = { sparc: true, value: afterPrPrompt(job, resume.value) }
      } else text = resumePrompt(job.path, undefined, undefined, ranSparc(agent))
      trace(`prompt kind: ${job.kind ?? (text.sparc ? 'sparc' : 'plain')}`)
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
      return created.sessionId
    } catch (error) {
      trace(`FAILED: ${error?.stack ?? error}`)
      ctx.logger.warn(`hooks-tts: could not spawn resume session: ${String(error)}`)
      return undefined
    }
  }

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    await spawnResume(agent)
    const message = check(agent, false)
    if (message) agent.steer(message)
  })

  return { prCreated }
}
