/**
 * PR state for a session. A session titled "PR <n>" is in PR state: it is never auto-respawned
 * (see cap.js) and, while the "Poll PR comments" setting is on, its Azure DevOps pull request is polled
 * every 10 minutes. With the host's Schedule service the trigger is ONE visible Automation task per session named
 * "PR <id> comment poll", whose tick this plugin handles itself (see pr-schedule.js); otherwise, or when the task
 * cannot be created, a timer is the trigger. New or changed review threads are queued into the SAME session as a
 * message that starts the `ado-pr-implement` skill up to its own user-approval gate.
 *
 * The poll ends only when the PR is completed or abandoned: an approval or a clean CI review does not stop it, since
 * later comments, pushes and CI runs still need handling before the merge.
 *
 * A session enters PR state when it creates a PR (tools/post-execute sees `az repos pr create` output with
 * a `pullRequestId`, or a `PR-CREATED: <id>` marker) and is renamed to `PR <id>`. State survives a handoff
 * through `PR-POLL: <id> seen=<thread>:<lastComment>,...` lines: a message carrying that marker re-registers
 * the poll in the resumed session.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stripHold } from './hold.js'
import { createPrSchedule, installPrScheduleHooks, taskTitle, textOf } from './pr-schedule.js'

export const PR_TITLE = /^PR \d+/
/**
 * The title the Task list (dsh-review-queue) gives a session started from an Azure DevOps ticket: "Fix: <ticket title> - <ticket number>",
 * with the numbered-continuation suffix (" - 2") the plugin may have added. The ticket number has 3 or more digits, a counter at most 2.
 */
export const TICKET_TITLE = /^(Fix: .+ - \d{3,9})(?: - (\d{1,2}))?$/

/**
 * The title of the session that continues a PR: "PR <id>"; for ticket work ("Fix: <title> - <number>") the PR number is put in front of
 * the original title: "PR <id> - Fix: <title> - <number>" (still a PR title, so the poll, the never-respawn rule and the PR lookups apply).
 */
export function prTitleFor(old, prId) {
  const title = (stripHold(typeof old === 'string' ? old : '') ?? '').trim()
  return TICKET_TITLE.test(title) && !PR_TITLE.test(title) ? `PR ${prId} - ${title}` : `PR ${prId}`
}
const ADO_REPO = 'https://dev.azure.com/ingeniuxdev/Ingeniux/_apis/git/repositories/6dc5d0bc-703d-4add-8785-e9fd2c55f4fc'
/** Definition id of the CI AI-review pipeline ("AI review pipeline 80"). */
const CI_PIPELINE_ID = 80
const POLL_INTERVAL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000
/** Thread statuses that mean the reviewer's point is settled. */
const RESOLVED = new Set(['fixed', 'closed', 'wontFix', 'byDesign'])
const SHELL_TOOLS = /^(bash|pwsh|powershell|shell)$/i
const POLL_MARKER = /^PR-POLL:[ \t]*(\d+)(?:[ \t]+seen=([\w:,]*))?(?:[ \t]+resume=(suggested|spawned))?[ \t]*$/m
/** Printed by the agent (`echo PR-RESUME-APPROVED: <id>`) after the user answered Yes to the merged-PR suggestion. */
const RESUME_MARKER = /^PR-RESUME-APPROVED:[ \t]*(\d+)[ \t\r]*$/m
/** Printed by the remaining-work session (`echo PR-WAIT: <id>`) after the user chose to wait for the PR. */
const RESUME_WAIT = /^PR-WAIT:[ \t]*(\d+)[ \t\r]*$/m

/** The message that starts a follow-up ("... - after PR n") session once PR `prId` is merged. */
export function mergedStartText(prId) {
  return [
    `PR ${prId} was merged.`,
    'Start the remaining work now, as described in your first message (no question needed): if you have not started yet, create your own worktree from the latest origin/develop and work only there; if you already started, rebase onto origin/develop for the tasks marked "(after merge)". Continue in SPARC mode.',
  ].join('\n')
}

/** The session's current title, read live on every call; undefined when unavailable. */
function titleOf(ctx, agent) {
  try { return stripHold(ctx.get('sessionTitle')?.get(agent.session)?.title) } catch { return undefined }
}

/** True when the session is titled "PR <n>". */
export function isPrSession(ctx, agent) {
  return PR_TITLE.test(titleOf(ctx, agent) ?? '')
}

/** PR id created by a shell command, from `az repos pr create` JSON output or a `PR-CREATED: <id>` marker. */
export function parsePrCreated(command, output) {
  const marker = /PR-CREATED:[ \t]*(\d+)/.exec(output ?? '')
  if (marker) return marker[1]
  if (!/\baz\s+repos\s+pr\s+create\b/.test(command ?? '')) return undefined
  return /"pullRequestId"\s*:\s*(\d+)/.exec(output ?? '')?.[1]
}

/** `PR-POLL: <id> seen=<thread>[:<lastComment>],... [resume=suggested|spawned]` -> { id, seen: [[thread, lastComment|null]], resume? }. */
export function parsePollMarker(text) {
  const m = POLL_MARKER.exec(text ?? '')
  if (!m) return undefined
  const seen = (m[2] ?? '').split(',').filter(Boolean).map((e) => {
    const [thread, last] = e.split(':')
    return [thread, last || null]
  })
  return { id: m[1], seen, ...(m[3] ? { resume: m[3] } : {}) }
}

/** Id from an approved-resume marker standing on its own line of shell output, else undefined. */
export const parseResumeApproved = (output) => RESUME_MARKER.exec(output ?? '')?.[1]

/**
 * Threads that need attention: not deleted/resolved, with at least one human comment, and unseen or with a
 * different last comment than recorded. `notify: false` marks a resumed bare id whose last comment was not
 * recorded, or a last comment written by the PR author (`selfId`): adopted silently instead of announced.
 */
export function detectNewThreads(threads, seen, selfId) {
  const found = []
  for (const t of threads ?? []) {
    if (t.isDeleted || RESOLVED.has(t.status)) continue
    const human = (t.comments ?? []).filter((c) => !c.isDeleted && c.commentType !== 'system')
    if (!human.length) continue
    const last = human.reduce((a, c) => ((Number(c.id) || 0) >= (Number(a.id) || 0) ? c : a))
    const lastCommentId = String(Number(last.id) || 0)
    const threadId = String(t.id)
    if (seen.has(threadId) && seen.get(threadId) === lastCommentId) continue
    // The PR author's own last comment (e.g. a reply posted by ado-pr-implement) is not a review request.
    const own = selfId != null && last.author?.id != null && String(last.author.id) === String(selfId)
    found.push({ threadId, lastCommentId, notify: !own && seen.get(threadId) !== null })
  }
  return found
}

const formatSeen = (seen) => [...seen].map(([t, c]) => (c ? `${t}:${c}` : t)).join(',')

/** Asks the agent to put the spawn decision to the user; only the user's Yes leads to the marker. */
function suggestionMessage(prId) {
  return [
    `PR ${prId} is merged (status completed).`,
    `Use the \`ask_user_question\` tool now to ask the user: "PR ${prId} is merged. Spawn a new session to continue from the last handoff?" with exactly two options: Yes / No.`,
    `If the user answers Yes, run this shell command and nothing else: \`echo PR-RESUME-APPROVED: ${prId}\`.`,
    'If the user answers No, do nothing.',
  ].join('\n')
}

/** One line naming the active CI review runs. */
export function ciRunningLine(prId, builds) {
  const list = builds.map((b) => `build ${b.buildNumber ?? b.id}, ${b.status}`).join('; ')
  return `CI review pipeline is running on PR ${prId} (${list}); its findings will arrive as new comment threads.`
}

/** One line telling the session the PR cannot merge (and the CI review cannot run) until the conflicts are resolved. */
export function conflictLine(prId, pr) {
  const target = String(pr?.targetRefName ?? '').replace(/^refs\/heads\//, '') || 'the target branch'
  return [
    `PR ${prId} has MERGE CONFLICTS with ${target}: it cannot be merged and the CI review pipeline cannot run until they are resolved.`,
    `Resolve them locally in this session: merge or rebase origin/${target} into the PR branch, fix the conflicts, run the relevant tests, and commit.`,
    'Do NOT push until the user has approved.',
  ].join('\n')
}

function queuedMessage(prId, threadIds, ciBuilds = [], conflict = '') {
  return [
    ...(conflict ? [conflict] : []),
    ...(ciBuilds.length ? [ciRunningLine(prId, ciBuilds)] : []),
    `New review comments on PR ${prId} (thread${threadIds.length > 1 ? 's' : ''} ${threadIds.join(', ')}).`,
    `Run the \`ado-pr-implement\` skill on PR ${prId} now, in this session, and take it only up to its user-approval gate: evaluate each comment, then implement fixes and update tests locally.`,
    'Do NOT commit, push, post replies or resolve threads until the user has approved at that gate.',
  ].join('\n')
}

/**
 * Register the PR hooks and return a handle (used by cap.js for handoff lines and by tests).
 * @param {object} deps
 * @param {{ get(): object, path: string }} deps.settings - runtime settings (pollPrComments is re-read per poll).
 * @param {typeof fetch} [deps.fetchImpl] - injectable for tests.
 */
export function installPrPoller(ctx, _config, { settings, skip = () => false, fetchImpl = globalThis.fetch, intervalMs = POLL_INTERVAL_MS, env = process.env, signal, onResumeApproved, onPrCreated, onPrMerged } = {}) {
  /** agent.id -> { agent, prId, seen: Map<threadId, lastCommentId|null>, timer, inFlight }. */
  const entries = new Map()
  /** agent.id -> { prId, seen, suggested, spawned }: survives stop(), so a merged PR's suggestion is never re-sent. */
  const states = new Map()
  /**
   * prId -> seen map of a stopped entry (disposed, archived, replaced), kept for the process lifetime so that a session
   * that registers again does not announce every unresolved thread a second time. Bounded: the oldest PR goes first.
   */
  const retainedSeen = new Map()
  const MAX_RETAINED_SEEN = 200
  /** Diagnostic trail shared with the auto-resume flow: <stateDir>/spawn.log. Never receives credentials. */
  const trace = (line) => {
    try { appendFileSync(join(dirname(settings.path), 'spawn.log'), `${new Date().toISOString()} pr-poll ${line}\n`) } catch { /* best effort */ }
  }
  // Security: scrub the PAT (and its Basic-auth encoding) from anything that reaches the trace.
  const scrub = (value) => {
    let out = String(value?.message ?? value)
    const pat = env.AZURE_DEVOPS_EXT_PAT
    if (pat) {
      for (const secret of [pat, Buffer.from(`:${pat}`).toString('base64')]) out = out.split(secret).join('***')
    }
    return out
  }

  // PRs that are over (merged or abandoned). A session titled "PR <n>" is re-registered on its
  // next step and after every restart, so without this record a finished PR would be polled again and again.
  const finishedFile = join(dirname(settings.path), 'pr-finished.json')
  const finishedPrs = new Set()
  try { for (const id of JSON.parse(readFileSync(finishedFile, 'utf8'))) finishedPrs.add(String(id)) } catch { /* none yet */ }
  function markFinished(prId) {
    if (finishedPrs.has(String(prId))) return
    finishedPrs.add(String(prId))
    try { writeFileSync(finishedFile, JSON.stringify([...finishedPrs].slice(-500))) } catch (error) { trace(`could not save finished PRs: ${scrub(error)}`) }
  }
  // The 10-minute trigger: one Automation task per PR session (absent Schedule service: the setInterval fallback below).
  const prSchedule = createPrSchedule({ getSchedule: () => ctx.get('schedule'), stateDir: dirname(settings.path), trace: (line) => trace(scrub(line)), intervalSeconds: Math.round(intervalMs / 1000) })
  const reportTask = (what) => (error) => trace(`${what}: ${scrub(error)}`)
  /** The setInterval trigger of an entry: the fallback when there is no Schedule service or its task cannot be created. */
  function armTimer(entry) {
    if (entry.timer) return
    entry.timer = setInterval(() => { void poll(entry.agent.id) }, intervalMs)
    entry.timer.unref?.()
  }
  function disarmTimer(entry) {
    if (!entry.timer) return
    clearInterval(entry.timer)
    entry.timer = undefined
  }
  /**
   * Fire-and-forget (never awaited from a listener): make sure the session's poll task exists. A failure (or a service that
   * went away) arms the timer for that entry so the session is still polled; a task that exists again clears it.
   */
  function ensureTask(sessionId, prId) {
    const current = () => { const entry = entries.get(sessionId); return entry?.prId === String(prId) ? entry : undefined }
    prSchedule.ensureTask(sessionId, prId).then((taskId) => {
      const entry = current()
      if (!entry) return
      if (taskId === undefined) armTimer(entry)
      else disarmTimer(entry)
    }, (error) => {
      reportTask(`could not create the poll task of ${sessionId}; polling by timer instead`)(error)
      const entry = current()
      if (entry) armTimer(entry)
    })
  }
  /** Whether the entry's trigger is the Automation task (service present, setting on, no timer fallback). */
  const taskTriggered = (entry) => prSchedule.available() && settings.get().pollPrComments && !entry.timer
  const dropTasks = (sessionId) => { void prSchedule.deleteTasks(sessionId).catch(reportTask(`could not delete the poll task of ${sessionId}`)) }

  /** Stop the poll of a PR that is over, and remember that. */
  function finish(id, reason) {
    const entry = entries.get(id)
    if (entry) markFinished(entry.prId)
    stop(id, reason)
    dropTasks(id)
  }

  function stop(id, reason) {
    const entry = entries.get(id)
    if (!entry) return
    clearInterval(entry.timer)
    entries.delete(id)
    retainedSeen.delete(entry.prId)
    retainedSeen.set(entry.prId, entry.seen)
    if (retainedSeen.size > MAX_RETAINED_SEEN) retainedSeen.delete(retainedSeen.keys().next().value)
    trace(`stopped polling PR ${entry.prId} for ${id}: ${reason}`)
  }

  const stopAll = () => { for (const id of [...entries.keys()]) stop(id, 'plugin shutdown') }
  signal?.addEventListener('abort', stopAll, { once: true })

  /** Register (or extend) the poll for a session. Re-registering the same PR only merges seen entries. */
  function register(agent, prId, seenEntries = [], resume, restored = false) {
    if (finishedPrs.has(String(prId))) { trace(`PR ${prId} is already finished; not polling it for ${agent.id}`); return }
    const existing = entries.get(agent.id)
    if (existing && existing.prId === String(prId)) {
      for (const [t, c] of seenEntries) if (!existing.seen.has(t)) existing.seen.set(t, c)
      // Neither a timer nor a task (the task was deleted, the session was unarchived, the setting was switched on by hand): create it again.
      if (taskTriggered(existing) && !prSchedule.hasTasks(agent.id)) ensureTask(agent.id, existing.prId)
      return
    }
    if (existing) stop(agent.id, 'replaced by another PR')
    // What an earlier registration of this PR already announced wins over the marker's list.
    const seen = new Map(retainedSeen.get(String(prId)) ?? [])
    for (const [t, c] of seenEntries) if (!seen.has(t)) seen.set(t, c)
    const entry = { agent, prId: String(prId), seen, ciReported: new Set(), conflictFor: undefined, timer: undefined, inFlight: undefined, restored }
    // A resumed marker carrying resume=suggested/spawned means the merged-PR suggestion was already made.
    // An existing state for the same PR (poll stopped after the merge, then re-registered) is kept, never reset.
    const prior = states.get(agent.id)?.prId === entry.prId ? states.get(agent.id) : undefined
    states.set(agent.id, {
      prId: entry.prId,
      seen: entry.seen,
      suggested: Boolean(prior?.suggested || resume),
      spawned: Boolean(prior?.spawned || resume === 'spawned'),
    })
    entries.set(agent.id, entry)
    if (prSchedule.available()) {
      // The Automation task is the trigger; with the setting off nothing is created (switching it on restores the tasks).
      if (settings.get().pollPrComments) ensureTask(agent.id, entry.prId)
      trace(`polling PR ${entry.prId} for ${agent.id} every ${Math.round(intervalMs / 1000)}s by Automation task "${taskTitle(entry.prId)}"`)
      return
    }
    armTimer(entry)
    trace(`polling PR ${entry.prId} for ${agent.id} every ${Math.round(intervalMs / 1000)}s`)
  }

  async function getJson(url, pat) {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return res.json()
  }

  /** Active (queued or running) CI review builds for the PR; undefined when the lookup failed (traced). */
  async function activeCiBuilds(entry, pat) {
    try {
      const url = `https://dev.azure.com/ingeniuxdev/Ingeniux/_apis/build/builds?definitions=${CI_PIPELINE_ID}&branchName=${encodeURIComponent(`refs/pull/${entry.prId}/merge`)}&statusFilter=inProgress,notStarted&api-version=7.1`
      const data = await getJson(url, pat)
      return (data?.value ?? []).filter((b) => b?.id != null && (b.status === 'inProgress' || b.status === 'notStarted'))
    } catch (error) {
      trace(`CI build lookup for PR ${entry.prId} failed: ${scrub(error)}`)
      return undefined
    }
  }

  async function queueMessage(entry, text) {
    const sc = ctx.get('sessionController') ?? ctx.sessionController
    // A restored session is not live after a restart: activate it first (best effort; the prompt itself may also do it).
    try { await sc.resolveAgent?.(entry.agent.id) } catch (error) { trace(`could not activate ${entry.agent.id}: ${scrub(error)}`) }
    await sc.prompt({
      requestId: `pr-poll-${randomUUID()}`,
      sessionId: entry.agent.id,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, AbortSignal.timeout(FETCH_TIMEOUT_MS)) // the Remote method requires a caller signal
  }

  /** Once per PR: ask the agent to put the spawn decision to the user. Recorded only after the queue accepted it. */
  async function suggestResume(entry) {
    const state = states.get(entry.agent.id)
    if (!state || state.suggested) return
    await queueMessage(entry, suggestionMessage(entry.prId))
    state.suggested = true
    trace(`PR ${entry.prId} completed: queued resume suggestion into ${entry.agent.id}`)
  }

  async function pollOnce(id) {
    const entry = entries.get(id)
    if (!entry) return
    if (!settings.get().pollPrComments) {
      if (prSchedule.available()) dropTasks(id) // Poll PR comments is off: the task has no purpose
      return
    }
    const pat = env.AZURE_DEVOPS_EXT_PAT
    if (!pat) { trace(`no AZURE_DEVOPS_EXT_PAT; skipping PR ${entry.prId}`); return }
    try {
      const base = `${ADO_REPO}/pullRequests/${encodeURIComponent(entry.prId)}`
      const pr = await getJson(`${base}?api-version=7.1`, pat)
      // A session restored after a restart whose PR is already merged is stopped quietly: its suggestion (if any) was
      // made before the restart, and old PR sessions must not be asked again.
      const quiet = entry.restored
      entry.restored = false
      void quiet
      if (pr?.status === 'completed') { finish(id, 'PR completed'); void serial(() => handleMerged(entry.prId, [id])); void checkWaits(); return } // start the waiting "... - after PR n" session now and offer to archive the PR session
      if (pr?.status === 'abandoned') { finish(id, 'PR abandoned'); void checkWaits(); return }
      const data = await getJson(`${base}/threads?api-version=7.1`, pat)
      const found = detectNewThreads(data?.value, entry.seen, pr?.createdBy?.id)
      for (const t of found.filter((f) => !f.notify)) entry.seen.set(t.threadId, t.lastCommentId)
      const fresh = found.filter((f) => f.notify)
      trace(`polled PR ${entry.prId}: ${data?.value?.length ?? 0} threads, ${fresh.length} new`)
      // Merge conflicts block both the merge and the CI review, so they are reported like a comment: once per head commit
      // (a new push that still conflicts is reported again; a resolved conflict resets it so a later one is reported).
      const conflicted = pr?.mergeStatus === 'conflicts'
      const head = String(pr?.lastMergeSourceCommit?.commitId ?? 'unknown')
      if (!conflicted) entry.conflictFor = undefined
      const conflictText = conflicted && entry.conflictFor !== head ? conflictLine(entry.prId, pr) : ''
      const builds = await activeCiBuilds(entry, pat)
      const newBuilds = (builds ?? []).filter((b) => !entry.ciReported.has(String(b.id)))
      if (!fresh.length) {
        if (newBuilds.length || conflictText) {
          await queueMessage(entry, [conflictText, newBuilds.length ? ciRunningLine(entry.prId, newBuilds) : ''].filter(Boolean).join('\n'))
          // recorded only after the queue accepted it
          for (const b of newBuilds) entry.ciReported.add(String(b.id))
          if (conflictText) entry.conflictFor = head
          trace(`reported ${conflictText ? 'merge conflicts' : ''}${conflictText && newBuilds.length ? ' and ' : ''}${newBuilds.length ? `active CI review build(s) ${newBuilds.map((b) => b.id).join(',')}` : ''} on PR ${entry.prId}`)
        }
        // Approval and a clean CI review do not end the poll: only a merged or abandoned PR does.
        return
      }
      await queueMessage(entry, queuedMessage(entry.prId, fresh.map((t) => t.threadId), newBuilds, conflictText))
      for (const b of newBuilds) entry.ciReported.add(String(b.id))
      if (conflictText) entry.conflictFor = head
      // Recorded only after the message was queued, so a failed hand-over is retried next poll.
      for (const t of fresh) entry.seen.set(t.threadId, t.lastCommentId)
      trace(`queued PR ${entry.prId} comments (threads ${fresh.map((t) => t.threadId).join(',')}) into ${id}`)
    } catch (error) {
      trace(`poll of PR ${entry.prId} failed: ${scrub(error)}`)
    }
  }

  /** One poll at a time per session: a poll that arrives while one is running shares its result. */
  function poll(id) {
    const entry = entries.get(id)
    if (!entry) return Promise.resolve()
    entry.inFlight ??= pollOnce(id).finally(() => { entry.inFlight = undefined })
    return entry.inFlight
  }

  /** Rename to "PR <id>" (ticket work: "PR <id> - <title>") unless the title already is a PR title. Returns true when renamed. */
  async function renameToPr(agent, prId) {
    const old = titleOf(ctx, agent) ?? ''
    if (PR_TITLE.test(old)) return false
    try {
      const sc = ctx.get('sessionController') ?? ctx.sessionController
      const title = prTitleFor(old, prId)
      await sc.rename({ sessionId: agent.id, title })
      trace(`renamed ${agent.id} to "${title}"`)
      return true
    } catch (error) {
      trace(`rename failed: ${scrub(error)}`)
      return false
    }
  }

  ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id ?? payload?.id
    stop(id, 'session disposed')
    states.delete(id)
  })

  /**
   * A user-approved resume. Security: the marker is plain shell output, so it is honoured only when this session
   * is titled "PR <same id>" and that PR was observed completed with the suggestion queued; at most once per PR.
   */
  async function handleResumeApproved(agent, id) {
    const state = states.get(agent.id)
    const titleId = /\d+/.exec(PR_TITLE.exec(titleOf(ctx, agent) ?? '')?.[0] ?? '')?.[0]
    if (!onResumeApproved || !state || state.prId !== id || titleId !== id || !state.suggested || state.spawned) {
      trace(`ignored resume marker for PR ${id} in ${agent.id}`)
      return
    }
    state.spawned = true // before the await: a repeated marker can never start a second spawn
    trace(`resume approved for PR ${id} in ${agent.id}`)
    try {
      await onResumeApproved(agent, id)
    } catch (error) {
      trace(`resume failed for PR ${id}: ${scrub(error)}`)
    }
  }

  // A resumed session re-registers from a PR-POLL marker; a session already titled "PR <n>" is picked up
  // on its next step (covers a host restart, which loses the in-memory poll list, an archive followed by an unarchive, and a
  // task the user deleted in the Automation UI or that could not be created: the first step of a turn checks the task).
  ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
    if (!skip(agent)) {
      try {
        const marker = parsePollMarker((messages ?? []).map((m) => textOf(m.content)).join('\n'))
        if (marker) {
          await renameToPr(agent, marker.id)
          register(agent, marker.id, marker.seen, marker.resume)
        } else {
          const m = PR_TITLE.exec(titleOf(ctx, agent) ?? '')
          const prId = m ? /\d+/.exec(m[0])[0] : undefined
          const had = entries.get(agent.id)
          if (prId && (!had || had.prId === prId)) {
            // register() itself re-creates a missing task of a task-triggered entry; otherwise check it on the first step of a turn.
            const registerCreates = had && taskTriggered(had) && !prSchedule.hasTasks(agent.id)
            register(agent, prId)
            if (had && !registerCreates && (step ?? 1) <= 1 && prSchedule.available() && settings.get().pollPrComments) ensureTask(agent.id, prId)
          }
        }
      } catch (error) { trace(`pre-step registration failed: ${scrub(error)}`) }
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const agent = exec.agent
    if (agent && !skip(agent) && SHELL_TOOLS.test(exec.name ?? '') && !result?.isError) {
      const id = parsePrCreated(JSON.stringify(exec.arguments ?? {}), textOf(result?.content))
      // Idempotent: a session already titled "PR <n>" is never renamed or re-pointed.
      if (id && !isPrSession(ctx, agent)) {
        if (onPrCreated) {
          // The PR continues in a NEW session titled "PR <id>" (spawned by cap.js); this one is neither renamed nor polled.
          try { await onPrCreated(agent, id) } catch (error) { trace(`hand-over to a PR session failed: ${scrub(error)}`) }
        } else {
          await renameToPr(agent, id) // a failed rename is traced; the poll still starts
          register(agent, id)
        }
      }
      // `echo PR-WAIT: <id>` from a session titled "... - after PR <id>": wait for that PR to be merged/abandoned.
      const waitId = RESUME_WAIT.exec(textOf(result?.content))?.[1]
      const afterId = /- after PR (\d+)$/.exec(titleOf(ctx, agent) ?? '')?.[1]
      if (waitId && afterId === waitId) addWait(agent.id, waitId)
    }
    return next()
  })

  /**
   * After a server restart the in-memory polls are gone: re-register every session titled "PR <n>" and poll once
   * straight away (open comments are queued into the session, which is resumed by the prompt). Returns how many
   * sessions were registered; 0 when the host services are not available yet.
   */
  const restoredIds = new Set()
  async function restore() {
    let ids
    let query
    try {
      const registry = ctx.get('workspaceRegistry')
      query = ctx.get('sessionQuery')
      if (!registry?.list || !query?.readTitleSnapshots) return 0
      const archived = new Set((registry.archivedSessionIds ?? []).map(String))
      ids = [...new Set(registry.list().flatMap((w) => w.sessionIds ?? []))].filter((id) => !archived.has(String(id)))
    } catch (error) { trace(`restore unavailable: ${scrub(error)}`); return 0 }
    let restored = 0
    for (let i = 0; i < ids.length; i += 50) { // batches keep a large session list from stalling the host
      const batch = ids.slice(i, i + 50)
      let results
      try { results = await query.readTitleSnapshots(batch) } catch (error) { trace(`restore title read failed: ${scrub(error)}`); continue }
      results.forEach((r, j) => {
        const prId = r?.status === 'fulfilled' ? /\d+/.exec(PR_TITLE.exec(r.value?.title?.title ?? '')?.[0] ?? '')?.[0] : undefined
        const id = batch[j]
        if (!prId || entries.has(id) || restoredIds.has(id)) return
        restoredIds.add(id) // one restore per session: the retries only pick up sessions that were not ready before
        register({ id }, prId, [], undefined, true)
        void poll(id)
        restored++
      })
    }
    if (restored) trace(`restored ${restored} PR session poll(s) after restart`)
    return restored
  }

  // ---- remaining-work sessions waiting for their PR (persisted, so a restart re-arms them) ----
  const waitFile = join(dirname(settings.path), 'pr-waits.json')
  /** sessionId -> prId. */
  const waitMap = new Map()
  try { for (const [id, pr] of Object.entries(JSON.parse(readFileSync(waitFile, 'utf8')))) waitMap.set(id, String(pr)) } catch { /* none yet */ }
  const saveWaits = () => { try { writeFileSync(waitFile, JSON.stringify(Object.fromEntries(waitMap))) } catch (error) { trace(`could not save waits: ${scrub(error)}`) } }
  let waitTimer
  const armWaits = () => {
    if (waitTimer || !waitMap.size) return
    waitTimer = setInterval(() => { void checkWaits() }, Math.min(intervalMs, 60_000)) // merges are noticed within a minute
    waitTimer.unref?.()
  }
  function addWait(sessionId, prId) {
    waitMap.set(sessionId, String(prId))
    saveWaits()
    armWaits()
    trace(`session ${sessionId} waits for PR ${prId} to finish`)
    void checkWaits() // the PR may already be over
  }

  /** Re-ask the waiting session once its PR is merged or abandoned; kept (and retried) when the hand-over fails. */
  // Checks run one after another, so a merge seen by two triggers (poll, wait timer) never re-asks a session twice.
  let waitsChain = Promise.resolve()
  /** Run `fn` after everything queued before it (merge handling and wait checks never overlap). */
  const serial = (fn) => { waitsChain = waitsChain.then(fn).catch(() => {}); return waitsChain }

  // ---- merged PRs: start the follow-up session, offer to archive the PR session ----
  const mergedFile = join(dirname(settings.path), 'pr-merged.json')
  /** PRs whose merge was fully handled (follow-ups told, archive offer made): never handled twice, also across restarts. */
  const mergedDone = new Set()
  try { for (const id of JSON.parse(readFileSync(mergedFile, 'utf8'))) mergedDone.add(String(id)) } catch { /* none yet */ }
  const saveMerged = () => { try { writeFileSync(mergedFile, JSON.stringify([...mergedDone].slice(-500))) } catch (error) { trace(`could not save merged PRs: ${scrub(error)}`) } }

  /** id -> title of every known, non-archived session (best effort: empty when the host services are not there). */
  async function sessionTitles() {
    const titles = new Map()
    try {
      const registry = ctx.get('workspaceRegistry')
      const query = ctx.get('sessionQuery')
      if (!registry?.list || !query?.readTitleSnapshots) return titles
      const archived = new Set((registry.archivedSessionIds ?? []).map(String))
      const ids = [...new Set(registry.list().flatMap((w) => w.sessionIds ?? []))].filter((id) => !archived.has(String(id)))
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50)
        const results = await query.readTitleSnapshots(batch)
        results.forEach((r, j) => { if (r?.status === 'fulfilled' && typeof r.value?.title?.title === 'string') titles.set(batch[j], stripHold(r.value.title.title)) })
      }
    } catch (error) { trace(`title lookup failed: ${scrub(error)}`) }
    return titles
  }

  /**
   * PR `prId` is merged. 1) The follow-up ("... - after PR n") session is located (its recorded wait, plus any session
   * titled that way whose wait was lost) and told to start; it says what to do if it already started. 2) The PR session
   * ("PR n") is reported through `onPrMerged` so the task list can offer to archive it. A follow-up that could not be
   * reached keeps (or gets) a wait, so the wait timer retries, and the report is made only once all of them are told.
   * Runs inside the wait chain; once per PR.
   */
  async function handleMerged(prId, knownPrSessionIds = []) {
    const id = String(prId)
    if (mergedDone.has(id)) return
    const titles = await sessionTitles()
    const prSessions = new Set(knownPrSessionIds)
    const followUps = new Set([...waitMap].filter(([, p]) => p === id).map(([s]) => s))
    for (const [sid, title] of titles) {
      if (new RegExp(`^PR ${id}(?!\\d)`).test(title)) prSessions.add(sid)
      else if (new RegExp(`\\s-\\s+after PR ${id}$`, 'i').test(title)) followUps.add(sid)
    }
    for (const [eid, e] of [...entries]) if (e.prId === id) prSessions.add(eid)
    const started = []
    let failed = false
    for (const sid of followUps) {
      try {
        await queueMessage({ agent: { id: sid } }, mergedStartText(id))
        waitMap.delete(sid)
        started.push(sid)
        trace(`PR ${id} merged: told follow-up session ${sid} to start`)
      } catch (error) {
        failed = true
        waitMap.set(sid, id) // retried by the wait timer
        trace(`could not start follow-up ${sid} for PR ${id}: ${scrub(error)}`)
      }
    }
    saveWaits()
    if (failed) { armWaits(); return }
    mergedDone.add(id)
    saveMerged()
    const named = (sid) => ({ id: sid, title: titles.get(sid) ?? '' })
    try { await onPrMerged?.({ prId: id, prSessions: [...prSessions].map(named), followUps: started.map(named) }) } catch (error) { trace(`merged report for PR ${id} failed: ${scrub(error)}`) }
  }

  function checkWaits() {
    const pat = env.AZURE_DEVOPS_EXT_PAT
    if (!pat) return Promise.resolve()
    waitsChain = waitsChain.then(() => checkWaitsOnce(pat)).catch(() => {})
    return waitsChain
  }
  async function checkWaitsOnce(pat) {
    for (const [sessionId, prId] of [...waitMap]) {
      try {
        const pr = await getJson(`${ADO_REPO}/pullRequests/${encodeURIComponent(prId)}?api-version=7.1`, pat)
        const merged = pr?.status === 'completed'
        if (!merged && pr?.status !== 'abandoned') continue
        // The PR is over: nothing left to poll for it in any PR session.
        markFinished(prId)
        const prSessionIds = []
        for (const [eid, e] of [...entries]) if (e.prId === String(prId)) { prSessionIds.push(eid); stop(eid, merged ? 'PR merged (wait check)' : 'PR abandoned (wait check)'); dropTasks(eid) }
        if (merged) { await handleMerged(prId, prSessionIds); continue }
        const text = [
          `PR ${prId} was abandoned.`,
          `Use the \`ask_user_question\` tool now to ask the user: "PR ${prId} was abandoned. Continue anyway?" with exactly two options: Yes / No.`,
          'If the user answers Yes, start the remaining work as described in your first message: create your own worktree from the latest origin/develop and work only there; treat tasks marked "(after merge)" as needing the user\'s decision. Continue in SPARC mode.',
          'If the user answers No, do nothing.',
        ].join('\n')
        await queueMessage({ agent: { id: sessionId } }, text)
        waitMap.delete(sessionId)
        saveWaits()
        trace(`PR ${prId} abandoned: re-asked ${sessionId}`)
      } catch (error) { trace(`wait check for PR ${prId} failed: ${scrub(error)}`) }
    }
    if (!waitMap.size && waitTimer) { clearInterval(waitTimer); waitTimer = undefined }
  }
  armWaits()
  signal?.addEventListener('abort', () => { if (waitTimer) clearInterval(waitTimer) }, { once: true })

  // ---- Automation task wiring (see pr-schedule.js): tick -> poll, archive / rename / setting clean-up ----
  /** Whether the workspace registry lists the session as archived (false when the registry is missing or throws). */
  function isArchived(sessionId) {
    try {
      const ids = ctx.get('workspaceRegistry')?.archivedSessionIds
      return Array.isArray(ids) ? ids.map(String).includes(String(sessionId)) : (ids?.has?.(String(sessionId)) ?? false)
    } catch { return false }
  }
  /** A tick of our task: poll now. A finished PR or the setting being off deletes the task instead; a session that is not registered yet (e.g. after a restart) is registered first. */
  function onScheduleTick(sessionId, prId, agent) {
    // The interceptor runs before the archived-session gate, so an archived session's leftover tick is dropped here: no
    // registration, no poll, and its tasks go. A failing lookup is not "archived".
    if (isArchived(sessionId)) { trace(`dropped a tick of ${sessionId}: session is archived`); dropTasks(sessionId); return }
    // A tick is only ever polled for the session that received it; never key an entry by another agent.
    if (agent?.id !== sessionId) { trace(`skipped a tick of ${sessionId} delivered to ${agent?.id ?? 'no agent'}`); return }
    if (!settings.get().pollPrComments || finishedPrs.has(String(prId))) { dropTasks(sessionId); return }
    if (!entries.has(sessionId)) register(agent, prId)
    void poll(sessionId)
  }
  installPrScheduleHooks(ctx, {
    schedule: prSchedule,
    onTick: onScheduleTick,
    onTitleAway: (sessionId) => { stop(sessionId, 'title is no longer a PR title'); dropTasks(sessionId) },
    onArchived: (sessionId) => stop(sessionId, 'session archived'),
    isPrTitle: (title) => PR_TITLE.test(stripHold(typeof title === 'string' ? title : '') ?? ''),
    archivedIds: () => ctx.get('workspaceRegistry')?.archivedSessionIds,
    trace: (line) => trace(scrub(line)),
  })
  // Poll PR comments on -> off deletes every task of ours; off -> on brings them back for the live and the restored PR sessions.
  const unsubscribeSettings = settings.subscribe?.((next, previous) => {
    if (!prSchedule.available() || Boolean(next.pollPrComments) === Boolean(previous.pollPrComments)) return
    if (!next.pollPrComments) {
      for (const sessionId of new Set([...prSchedule.sessionIds(), ...entries.keys()])) dropTasks(sessionId)
      return
    }
    for (const [sessionId, entry] of entries) ensureTask(sessionId, entry.prId)
    restoredIds.clear()
    void restore().catch((error) => trace(`restore after switching the poll on failed: ${scrub(error)}`))
  }, reportTask('settings listener failed'))
  signal?.addEventListener('abort', () => unsubscribeSettings?.(), { once: true })

  return {
    register,
    restore,
    addWait,
    checkWaits,
    waits: () => [...waitMap],
    poll,
    stopAll,
    has: (id) => entries.has(id),
    /** Lines a handoff note carries so a resumed session can re-register the poll. */
    handoffLines(id) {
      // Still available after the poll stopped (merged PR), so the suggested/spawned state travels in the handoff.
      const entry = entries.get(id) ?? states.get(id)
      if (!entry) return []
      const state = states.get(id)
      const resume = state?.spawned ? ' resume=spawned' : state?.suggested ? ' resume=suggested' : ''
      return [`PR: ${entry.prId}`, `PR-POLL: ${entry.prId} seen=${formatSeen(entry.seen)}${resume}`]
    },
  }
}
