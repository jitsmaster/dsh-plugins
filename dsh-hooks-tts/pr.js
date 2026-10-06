/**
 * PR state for a session. A session titled "PR <n>" is in PR state: it is never auto-respawned
 * (see cap.js) and, while the "Poll PR comments" setting is on, its Azure DevOps pull request is polled
 * every 10 minutes. New or changed review threads are queued into the SAME session as a message that
 * starts the `ado-pr-implement` skill up to its own user-approval gate.
 *
 * A session enters PR state when it creates a PR (tools/post-execute sees `az repos pr create` output with
 * a `pullRequestId`, or a `PR-CREATED: <id>` marker) and is renamed to `PR <id>`. State survives a handoff
 * through `PR-POLL: <id> seen=<thread>:<lastComment>,...` lines: a message carrying that marker re-registers
 * the poll in the resumed session.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const PR_TITLE = /^PR \d+/
const ADO_REPO = 'https://dev.azure.com/ingeniuxdev/Ingeniux/_apis/git/repositories/6dc5d0bc-703d-4add-8785-e9fd2c55f4fc'
const POLL_INTERVAL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000
/** Thread statuses that mean the reviewer's point is settled. */
const RESOLVED = new Set(['fixed', 'closed', 'wontFix', 'byDesign'])
const SHELL_TOOLS = /^(bash|pwsh|powershell|shell)$/i
const POLL_MARKER = /^PR-POLL:[ \t]*(\d+)(?:[ \t]+seen=([\w:,]*))?(?:[ \t]+resume=(suggested|spawned))?[ \t]*$/m
/** Printed by the agent (`echo PR-RESUME-APPROVED: <id>`) after the user answered Yes to the merged-PR suggestion. */
const RESUME_MARKER = /^PR-RESUME-APPROVED:[ \t]*(\d+)[ \t\r]*$/m

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(''))

/** The session's current title, read live on every call; undefined when unavailable. */
function titleOf(ctx, agent) {
  try { return ctx.get('sessionTitle')?.get(agent.session)?.title } catch { return undefined }
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

/** The CI AI-review bot's all-clear comment, e.g. "AI review complete — no issues found across all 10 passes". */
const CI_CLEAN = /AI review complete\W+no issues found/i

/** Time (ms) of the newest CI "no issues found" comment in the threads, or undefined when there is none. */
export function ciReviewCleanAt(threads) {
  let latest
  for (const t of threads ?? []) {
    if (t.isDeleted) continue
    for (const c of t.comments ?? []) {
      if (c.isDeleted || !CI_CLEAN.test(c.content ?? '')) continue
      const at = Date.parse(c.publishedDate)
      if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at
    }
  }
  return latest
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

function queuedMessage(prId, threadIds) {
  return [
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
export function installPrPoller(ctx, _config, { settings, skip = () => false, fetchImpl = globalThis.fetch, intervalMs = POLL_INTERVAL_MS, env = process.env, signal, onResumeApproved, onPrCreated } = {}) {
  /** agent.id -> { agent, prId, seen: Map<threadId, lastCommentId|null>, timer, inFlight }. */
  const entries = new Map()
  /** agent.id -> { prId, seen, suggested, spawned }: survives stop(), so a merged PR's suggestion is never re-sent. */
  const states = new Map()
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

  function stop(id, reason) {
    const entry = entries.get(id)
    if (!entry) return
    clearInterval(entry.timer)
    entries.delete(id)
    trace(`stopped polling PR ${entry.prId} for ${id}: ${reason}`)
  }

  const stopAll = () => { for (const id of [...entries.keys()]) stop(id, 'plugin shutdown') }
  signal?.addEventListener('abort', stopAll, { once: true })

  /** Register (or extend) the poll for a session. Re-registering the same PR only merges seen entries. */
  function register(agent, prId, seenEntries = [], resume, restored = false) {
    const existing = entries.get(agent.id)
    if (existing && existing.prId === String(prId)) {
      for (const [t, c] of seenEntries) if (!existing.seen.has(t)) existing.seen.set(t, c)
      return
    }
    if (existing) stop(agent.id, 'replaced by another PR')
    const entry = { agent, prId: String(prId), seen: new Map(seenEntries), timer: undefined, inFlight: undefined, restored }
    // A resumed marker carrying resume=suggested/spawned means the merged-PR suggestion was already made.
    // An existing state for the same PR (poll stopped after the merge, then re-registered) is kept, never reset.
    const prior = states.get(agent.id)?.prId === entry.prId ? states.get(agent.id) : undefined
    states.set(agent.id, {
      prId: entry.prId,
      seen: entry.seen,
      suggested: Boolean(prior?.suggested || resume),
      spawned: Boolean(prior?.spawned || resume === 'spawned'),
    })
    entry.timer = setInterval(() => { void poll(agent.id) }, intervalMs)
    entry.timer.unref?.()
    entries.set(agent.id, entry)
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

  /** True when the CI result is not older than the PR's last source commit. A failed lookup throws (the poll just continues). */
  async function ciResultIsCurrent(cleanAt, pr, pat) {
    const sha = pr?.lastMergeSourceCommit?.commitId
    if (!sha) return true
    const commit = await getJson(`${ADO_REPO}/commits/${sha}?api-version=7.1`, pat)
    const committedAt = Date.parse(commit?.committer?.date)
    return Number.isFinite(committedAt) && cleanAt >= committedAt
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
    if (!entry || !settings.get().pollPrComments) return
    const pat = env.AZURE_DEVOPS_EXT_PAT
    if (!pat) { trace(`no AZURE_DEVOPS_EXT_PAT; skipping PR ${entry.prId}`); return }
    try {
      const base = `${ADO_REPO}/pullRequests/${entry.prId}`
      const pr = await getJson(`${base}?api-version=7.1`, pat)
      // A session restored after a restart whose PR is already merged is stopped quietly: its suggestion (if any) was
      // made before the restart, and old PR sessions must not be asked again.
      const quiet = entry.restored
      entry.restored = false
      if (pr?.status === 'completed') {
        if (quiet) { const state = states.get(id); if (state) state.suggested = true } else await suggestResume(entry)
        stop(id, 'PR completed')
        return
      }
      if (pr?.status === 'abandoned') { stop(id, 'PR abandoned'); return }
      const data = await getJson(`${base}/threads?api-version=7.1`, pat)
      const found = detectNewThreads(data?.value, entry.seen, pr?.createdBy?.id)
      for (const t of found.filter((f) => !f.notify)) entry.seen.set(t.threadId, t.lastCommentId)
      const fresh = found.filter((f) => f.notify)
      trace(`polled PR ${entry.prId}: ${data?.value?.length ?? 0} threads, ${fresh.length} new`)
      if (!fresh.length) {
        // Stop once the CI review reports no issues for the current head commit; a newer push means a new review is pending.
        const cleanAt = ciReviewCleanAt(data?.value)
        if (cleanAt !== undefined && await ciResultIsCurrent(cleanAt, pr, pat)) { stop(id, 'CI review reports no issues found'); return }
        return
      }
      await queueMessage(entry, queuedMessage(entry.prId, fresh.map((t) => t.threadId)))
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

  /** Rename to "PR <id>" unless the title already is a PR title. Returns true when renamed. */
  async function renameToPr(agent, prId) {
    if (PR_TITLE.test(titleOf(ctx, agent) ?? '')) return false
    try {
      const sc = ctx.get('sessionController') ?? ctx.sessionController
      await sc.rename({ sessionId: agent.id, title: `PR ${prId}` })
      trace(`renamed ${agent.id} to "PR ${prId}"`)
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
  // on its next step (covers a host restart, which loses the in-memory poll list).
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (!skip(agent)) {
      try {
        const marker = parsePollMarker((messages ?? []).map((m) => textOf(m.content)).join('\n'))
        if (marker) {
          await renameToPr(agent, marker.id)
          register(agent, marker.id, marker.seen, marker.resume)
        } else if (!entries.has(agent.id)) {
          const m = PR_TITLE.exec(titleOf(ctx, agent) ?? '')
          if (m) register(agent, /\d+/.exec(m[0])[0])
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
      const approvedId = parseResumeApproved(textOf(result?.content))
      if (approvedId) await handleResumeApproved(agent, approvedId)
    }
    return next()
  })

  /**
   * After a server restart the in-memory polls are gone: re-register every session titled "PR <n>" and poll once
   * straight away (open comments are queued into the session, which is resumed by the prompt). Returns how many
   * sessions were registered; 0 when the host services are not available yet.
   */
  async function restore() {
    let ids
    let query
    try {
      const registry = ctx.get('workspaceRegistry')
      query = ctx.get('sessionQuery')
      if (!registry?.list || !query?.readTitleSnapshots) return 0
      ids = [...new Set(registry.list().flatMap((w) => w.sessionIds ?? []))]
    } catch (error) { trace(`restore unavailable: ${scrub(error)}`); return 0 }
    let restored = 0
    for (let i = 0; i < ids.length; i += 50) { // batches keep a large session list from stalling the host
      const batch = ids.slice(i, i + 50)
      let results
      try { results = await query.readTitleSnapshots(batch) } catch (error) { trace(`restore title read failed: ${scrub(error)}`); continue }
      results.forEach((r, j) => {
        const prId = r?.status === 'fulfilled' ? /\d+/.exec(PR_TITLE.exec(r.value?.title?.title ?? '')?.[0] ?? '')?.[0] : undefined
        const id = batch[j]
        if (!prId || entries.has(id)) return
        register({ id }, prId, [], undefined, true)
        void poll(id)
        restored++
      })
    }
    if (restored) trace(`restored ${restored} PR session poll(s) after restart`)
    return restored
  }

  return {
    register,
    restore,
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
