/**
 * The PR comment poll as a visible DSH Automation (schedule) task.
 *
 * Every session titled "PR <id>" gets ONE recurring task named "PR <id> comment poll" (every 10 minutes). The poll
 * itself is unchanged (pr.js): the schedule task is only its trigger. The plugin intercepts the task's tick in
 * `agent/pre-step`, so no model call is spent and the check runs inside the plugin. If the plugin is off, the task's
 * own prompt is a plain fallback instruction for the model.
 *
 * Two parts live here:
 *  - createPrSchedule: creates / adopts / deletes the tasks (serialized per session, remembered in
 *    <stateDir>/pr-poll-tasks.json) and classifies a tick text into our task ids and everything else.
 *  - installPrScheduleHooks: the host wiring (tick interception, archive filter, archive / title clean-up).
 *
 * Security: nothing here reads or logs the Azure DevOps PAT. Tasks are only ever deleted from fire-and-forget calls
 * (never inside an archive-admission or pre-step path that awaits them), and only our own tasks are touched.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REGISTRY_FILE = 'pr-poll-tasks.json'
const DEFAULT_INTERVAL_SECONDS = 600
/** The schedule service rejects anything below one minute. */
const MIN_INTERVAL_SECONDS = 60
const MAX_RETIRED = 500
const MARKER_LINE = /^\[dsh-hooks-tts pr-poll v1 session=(\S+) pr=(\d+)\]$/
/** A registry id / session id: non-empty, no whitespace or control characters. */
const SAFE_ID = /^[^\s\u0000-\u001f\u007f]+$/
const PR_ID = /^\d+$/
const REMINDER_PROMPT_JSON = 'reminder_prompt_json: '
const TITLE = /^PR (\d+) comment poll$/
const BATCH_HEAD = '[SCHEDULE REMINDER BATCH]'
const SINGLE_HEAD = '[SCHEDULE REMINDER]'
const BATCH_PAYLOAD = 'reminders_json: '
const SINGLE_PAYLOAD = 'schedule_id_json: '

/** Plain text of message content (a string or a list of blocks). */
export const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(''))

export const taskTitle = (prId) => `PR ${prId} comment poll`
export const markerLine = (sessionId, prId) => `[dsh-hooks-tts pr-poll v1 session=${sessionId} pr=${prId}]`

/** The prompt of the task: the instruction for a model that receives the tick when this plugin is off, plus the marker. */
export function taskPrompt(sessionId, prId) {
  return [
    `Check Azure DevOps pull request ${prId} for review comments you have not handled yet.`,
    'Use the ado-pr-implement skill only up to its user-approval gate (evaluate comments, implement fixes locally, no commit/push/reply/resolve until the user approves).',
    `If nothing is new, reply with exactly: PR-WAIT: ${prId} and do nothing else.`,
    markerLine(sessionId, prId),
  ].join('\n')
}

/** { sessionId, prId } of our marker when it is the last line of a prompt, else undefined. */
function markerInPrompt(prompt) {
  const m = MARKER_LINE.exec(String(prompt ?? '').trim().split('\n').at(-1).trim())
  return m ? { sessionId: m[1], prId: m[2] } : undefined
}

/** { sessionId, prId } of a task record carrying our marker as its last line and our title, else undefined. */
function markerOf(record) {
  const marker = markerInPrompt(record?.prompt)
  if (!marker || TITLE.exec(String(record?.title ?? ''))?.[1] !== marker.prId) return undefined
  return marker
}

/** Whether a registry record read from disk is well formed (it ends up in task titles, URLs and delete calls). */
const isValidRecord = (t) => typeof t?.id === 'string' && SAFE_ID.test(t.id) && typeof t.sessionId === 'string' && SAFE_ID.test(t.sessionId) && typeof t.prId === 'string' && PR_ID.test(t.prId)

/** A recurring batch tick: its lines, the payload line index and the reminders list; undefined unless it is one. */
function parseBatch(text) {
  const lines = text.split('\n')
  if (lines[0] !== BATCH_HEAD) return undefined
  const at = lines.findIndex((line, i) => i > 0 && line.startsWith(BATCH_PAYLOAD))
  if (at < 0) return undefined
  try {
    const list = JSON.parse(lines[at].slice(BATCH_PAYLOAD.length))
    if (!Array.isArray(list) || !list.every((e) => typeof e?.schedule_id === 'string')) return undefined
    return { lines, at, list }
  } catch { return undefined }
}

/** The schedule id and (when present and readable) the prompt of a one-shot reminder tick; undefined unless the text is one. */
function parseSingle(text) {
  const lines = text.split('\n')
  if (lines[0] !== SINGLE_HEAD) return undefined
  const line = lines.find((l, i) => i > 0 && l.startsWith(SINGLE_PAYLOAD))
  if (line === undefined) return undefined
  try {
    const id = JSON.parse(line.slice(SINGLE_PAYLOAD.length))
    if (typeof id !== 'string') return undefined
    const promptLine = lines.find((l, i) => i > 0 && l.startsWith(REMINDER_PROMPT_JSON))
    let prompt
    try { prompt = promptLine === undefined ? undefined : JSON.parse(promptLine.slice(REMINDER_PROMPT_JSON.length)) } catch { /* no readable prompt: nothing to recognise */ }
    return { id, prompt: typeof prompt === 'string' ? prompt : undefined }
  } catch { return undefined }
}

/**
 * @param {object} deps
 * @param {() => object | undefined} deps.getSchedule - the host schedule service, or undefined when absent.
 * @param {string} deps.stateDir - where pr-poll-tasks.json lives.
 * @param {(line: string) => void} [deps.trace]
 * @param {number} [deps.intervalSeconds]
 */
export function createPrSchedule({ getSchedule, stateDir, trace = () => {}, intervalSeconds = DEFAULT_INTERVAL_SECONDS }) {
  const registryPath = join(stateDir, REGISTRY_FILE)
  /** task id -> { sessionId, prId }: the tasks we created or adopted; survives a restart. */
  const registry = new Map()
  /** ids we deleted (or are deleting): a tick still queued for one is dropped, never answered. */
  const retired = new Set()
  /** sessionId -> tail of its serialized create/delete work. */
  const chains = new Map()
  const every = Math.max(MIN_INTERVAL_SECONDS, Math.round(intervalSeconds))

  try {
    const saved = JSON.parse(readFileSync(registryPath, 'utf8'))?.tasks
    // Security: the file is plain JSON on disk; a malformed entry is dropped (it is later used in titles, ids and URLs).
    for (const t of Array.isArray(saved) ? saved : []) if (isValidRecord(t)) registry.set(t.id, { sessionId: t.sessionId, prId: t.prId })
  } catch { /* none yet, or unreadable: adoption by marker rebuilds it */ }

  const save = () => {
    try { writeFileSync(registryPath, JSON.stringify({ tasks: [...registry].map(([id, t]) => ({ id, ...t })) })) } catch (error) { trace(`could not save poll tasks: ${error?.message ?? error}`) }
  }
  const remember = (id, sessionId, prId) => {
    const known = registry.get(id)
    if (known?.sessionId === sessionId && known.prId === prId) return
    registry.set(id, { sessionId, prId })
    save()
  }
  const retire = (id) => {
    retired.add(id)
    if (retired.size > MAX_RETIRED) retired.delete(retired.values().next().value)
  }
  const forget = (id) => { if (registry.delete(id)) save() }
  const idsOf = (sessionId) => [...registry].filter(([, t]) => t.sessionId === sessionId).map(([id]) => id)

  /** Run `work` after everything queued earlier for the same session; a failure never blocks the next job. */
  function serialize(sessionId, work) {
    const run = (chains.get(sessionId) ?? Promise.resolve()).then(work)
    const tail = run.catch(() => {})
    chains.set(sessionId, tail)
    void tail.then(() => { if (chains.get(sessionId) === tail) chains.delete(sessionId) })
    return run
  }

  /** Delete one task. It is retired first so a tick that is already queued is dropped; a failed delete un-retires it. */
  async function removeOne(service, sessionId, id) {
    retire(id)
    try {
      await service.delete({ sessionId, id })
    } catch (error) {
      retired.delete(id)
      throw error
    }
    forget(id)
  }

  /** Whether an active task record is ours for this session: in the registry, or carrying our marker for it. */
  const isOurs = (record, sessionId) => registry.get(record.id)?.sessionId === sessionId || markerOf(record)?.sessionId === sessionId

  async function ensure(sessionId, prId) {
    const service = getSchedule()
    if (!service) return undefined
    const active = await service.list({ sessionId })
    const mine = active.filter((r) => isOurs(r, sessionId))
    const wanted = mine.find((r) => r.title === taskTitle(prId) && markerOf(r)?.prId === prId)
    // A task the user deleted in the Automation UI is forgotten and, below, recreated (no suppression).
    const live = new Set(active.map((r) => r.id))
    for (const id of idsOf(sessionId)) if (!live.has(id)) { retire(id); forget(id) }
    // The wanted task comes first, so a failing delete can never leave the session without its poll.
    let id = wanted?.id
    if (wanted) remember(wanted.id, sessionId, prId)
    else {
      const created = await service.create(sessionId, { prompt: taskPrompt(sessionId, prId), title: taskTitle(prId), every_seconds: every })
      remember(created.id, sessionId, prId)
      trace(`created Automation task "${taskTitle(prId)}" (${created.id}) for ${sessionId}`)
      id = created.id
    }
    // Our tasks for another PR (or a duplicate) are stale: the session has exactly one poll task. A failure is retried by the next call.
    for (const stale of mine) {
      if (stale === wanted) continue
      try { await removeOne(service, sessionId, stale.id) } catch (error) { trace(`could not delete the stale poll task ${stale.id} of ${sessionId}: ${error?.message ?? error}`) }
    }
    return id
  }

  async function remove(sessionId) {
    const service = getSchedule()
    if (!service) return
    let active
    try { active = await service.list({ sessionId }) } catch (error) { trace(`could not list tasks of ${sessionId}: ${error?.message ?? error}`) }
    // A failed listing falls back to the registry; a registered task that no longer exists is simply forgotten.
    const live = active ? new Set(active.filter((r) => isOurs(r, sessionId)).map((r) => r.id)) : undefined
    const ids = new Set([...(live ?? []), ...idsOf(sessionId)])
    let failure
    for (const id of ids) {
      if (live && !live.has(id)) { retire(id); forget(id); continue }
      try { await removeOne(service, sessionId, id); trace(`deleted Automation task ${id} of ${sessionId}`) } catch (error) { failure ??= error }
    }
    if (failure) throw failure
  }

  /**
   * A task id that is neither registered nor retired but whose prompt carries OUR marker for the receiving session is a
   * leftover of an earlier process (the retired set is not persisted): it is treated as retired.
   */
  const isStale = (prompt, sessionId) => sessionId !== undefined && markerInPrompt(prompt)?.sessionId === sessionId

  /**
   * Whether a tick entry of an unregistered task is a leftover of ours (stale) or of a deleted task (retired): either way it is
   * dropped, and the drop is traced so it is visible. Only ids and the session are logged (JSON-quoted: ids are external
   * text), never the prompt.
   */
  function dropReason(id, prompt, sessionId) {
    if (retired.has(id)) return 'retired'
    if (registry.has(id) || !isStale(prompt, sessionId)) return undefined
    return 'stale'
  }
  const traceDrop = (reason, id, sessionId) => trace(reason === 'retired'
    ? `dropped a tick of retired task ${JSON.stringify(id)}`
    : `dropped a stale tick: unregistered task ${JSON.stringify(id)} carries our marker for session ${JSON.stringify(sessionId)}`)

  function classifyBatch({ lines, at, list }, text, sessionId) {
    const ours = []
    const gone = []
    const others = []
    const kept = []
    for (const entry of list) {
      const id = entry.schedule_id
      const reason = dropReason(id, entry.reminder_prompt, sessionId)
      if (reason) { traceDrop(reason, id, sessionId); gone.push(id) }
      else if (registry.has(id)) ours.push({ id, ...registry.get(id) })
      else { others.push(id); kept.push(entry) }
    }
    if (!ours.length && !gone.length) return { format: 'batch', ours, retired: gone, others, remainder: text }
    // Rebuild the batch without our entries; the other reminders keep their exact payload.
    const rebuilt = [...lines.slice(0, at), `${BATCH_PAYLOAD}${JSON.stringify(kept)}`, ...lines.slice(at + 1)].join('\n')
    return { format: 'batch', ours, retired: gone, others, remainder: kept.length ? rebuilt : null }
  }

  function classifySingle({ id, prompt }, text, sessionId) {
    const reason = dropReason(id, prompt, sessionId)
    if (reason) {
      traceDrop(reason, id, sessionId)
      return { format: 'single', ours: [], retired: [id], others: [], remainder: null }
    }
    if (registry.has(id)) return { format: 'single', ours: [{ id, ...registry.get(id) }], retired: [], others: [], remainder: null }
    return { format: 'single', ours: [], retired: [], others: [id], remainder: text }
  }

  return {
    available: () => getSchedule() !== undefined,
    ensureTask: (sessionId, prId) => serialize(String(sessionId), () => ensure(String(sessionId), String(prId))),
    deleteTasks: (sessionId) => serialize(String(sessionId), () => remove(String(sessionId))),
    /** Task ids of ours for a session (synchronous, from the registry). */
    taskIdsOf: (sessionId) => idsOf(String(sessionId)),
    hasTasks: (sessionId) => idsOf(String(sessionId)).length > 0,
    /** Every session that has a task of ours. */
    sessionIds: () => [...new Set([...registry.values()].map((t) => t.sessionId))],
    /** `sessionId`: the session that received the tick; enables recognising stale ticks of ours (see isStale). */
    classifyTick(text, sessionId) {
      const s = typeof text === 'string' ? text : ''
      const batch = parseBatch(s)
      if (batch) return classifyBatch(batch, s, sessionId)
      const single = parseSingle(s)
      if (single !== undefined) return classifySingle(single, s, sessionId)
      return { format: null, ours: [], retired: [], others: [], remainder: s }
    },
  }
}

/**
 * What a claimed batch becomes once our ticks are removed: a Map from each touched message (by object and by id) to its
 * replacement, or null when it is dropped. `ticks` lists the poll triggers found. Empty map when nothing is ours.
 * `sessionId` is the receiving session (used to recognise stale ticks of ours).
 */
function planTicks(schedule, claimed, sessionId) {
  const touched = new Map()
  const ticks = []
  for (const message of claimed) {
    if (message?.source?.kind !== 'schedule') continue
    const found = schedule.classifyTick(textOf(message?.content), sessionId)
    if (!found.ours.length && !found.retired.length) continue
    ticks.push(...found.ours)
    const replacement = found.remainder === null ? null : { ...message, content: [{ type: 'text', text: found.remainder }] }
    touched.set(message, replacement)
    if (typeof message.id === 'string') touched.set(message.id, replacement)
  }
  return { touched, ticks }
}

/** Apply a plan to a message list: touched messages are dropped or replaced, the rest is kept in order. */
function applyPlan(touched, messages) {
  return messages.flatMap((m) => {
    const key = touched.has(m) ? m : (typeof m?.id === 'string' ? m.id : undefined)
    if (key === undefined || !touched.has(key)) return [m]
    const replacement = touched.get(key)
    return replacement === null ? [] : [replacement]
  })
}

/**
 * Host wiring for the PR poll tasks.
 * @param {object} deps
 * @param {ReturnType<typeof createPrSchedule>} deps.schedule
 * @param {(sessionId: string, prId: string, agent: object) => void} deps.onTick - runs the poll for a tick of ours (fire-and-forget).
 * @param {(sessionId: string) => void} deps.onTitleAway - the session's title stopped being "PR <n>".
 * @param {(sessionId: string) => void} [deps.onArchived] - the session was just archived: drop its in-memory poll entry (no deletes; the tasks are deleted here).
 * @param {(title: unknown) => boolean} deps.isPrTitle
 * @param {() => unknown} [deps.archivedIds] - the currently archived session ids, when the registry is reachable.
 */
export function installPrScheduleHooks(ctx, { schedule, onTick, onTitleAway, onArchived, isPrTitle, archivedIds, trace = () => {} }) {
  const problem = (what) => (error) => trace(`${what}: ${error?.message ?? error}`)
  const dropTasks = (sessionId, why) => { void schedule.deleteTasks(sessionId).catch(problem(`could not delete the poll task of ${sessionId} (${why})`)) }

  /**
   * Outermost agent/pre-step: our tick is removed from the claimed batch and starts the poll. A batch that holds nothing
   * but our tick(s) becomes an empty enter, so no model call is spent; NOTE that returns without next(), so the pre-step
   * listeners inside this one (time-context, pr.js's registration hook, ...) do not run for that step. When anything else
   * is in the batch (a user message, a plugin:* notice, another reminder) the chain runs and only our tick is filtered out.
   */
  async function intercept(payload, next) {
    const claimed = payload?.messages
    if (!Array.isArray(claimed) || !claimed.length || !schedule.available()) return next()
    const { touched, ticks } = planTicks(schedule, claimed, payload.agent?.id)
    if (!touched.size) return next()
    for (const tick of ticks) {
      try { onTick(tick.sessionId, tick.prId, payload.agent) } catch (error) { problem('poll trigger failed')(error) }
    }
    if (!applyPlan(touched, claimed).length) return { kind: 'enter', messages: [] }
    const decision = await next()
    if (decision?.kind !== 'enter') return decision
    return { ...decision, messages: applyPlan(touched, decision.messages ?? []) }
  }

  // ONE plugin-level listener (the agent/created `this` is a scope carrier without `on`; there is no per-agent listener).
  // prepend makes it the outermost pre-step; otherwise the time-context plugin appends a message and the tick would cost
  // a model call. Ordering assumption: a later prepend listener would be outer still, so the registration is deferred to
  // the first agent/created, which fires after every plugin has been applied.
  let installed = false
  const installIntercept = () => {
    if (installed) return
    installed = true
    ctx.on('agent/pre-step', intercept, { prepend: true })
  }
  ctx.on('agent/created', () => { installIntercept() })
  // Agents that already exist when the plugin applies get no agent/created event: register now (the plugin then has to be
  // applied after the plugins that prepend their own pre-step listener, which is the host's normal order for restarts).
  try {
    const agents = ctx.agents ?? ctx.get('agents')
    if (agents?.list?.().length) installIntercept()
  } catch { /* no agent registry yet */ }

  // Archive: our task must never block it. Pure filter, never deletes (the actual deletion follows domain/changed).
  ctx.on('workspace/session-activity', async (payload, next) => {
    const rest = await next()
    const ours = new Set(schedule.taskIdsOf(payload?.sessionId))
    if (!ours.size || !Array.isArray(rest)) return rest
    return rest.flatMap((entry) => {
      if (entry?.kind !== 'schedule' || !Array.isArray(entry.items)) return [entry]
      const items = entry.items.filter((item) => !ours.has(item?.id))
      return items.length ? [{ ...entry, items }] : []
    })
  }, { prepend: true })

  // Delete the tasks of a session that was just archived (diff against the archived set seen last).
  let archived
  try {
    const initial = archivedIds?.()
    if (Array.isArray(initial)) archived = new Set(initial.map(String))
  } catch { /* registry not ready: the first change is diffed against nothing */ }
  ctx.on('domain/changed', (change) => {
    if (change?.domain !== 'workspace' || change.operation !== 'put' || (change.table ?? '') !== '') return
    const list = change.value?.archivedSessionIds
    if (!Array.isArray(list)) return
    const now = new Set(list.map(String))
    const before = archived ?? new Set()
    archived = now
    for (const id of now) {
      if (before.has(id)) continue
      // Memory-only stop first, so that after an unarchive the next step registers the session again and creates one task.
      try { onArchived?.(id) } catch (error) { problem(`could not stop the poll of ${id}`)(error) }
      if (schedule.hasTasks(id)) dropTasks(id, 'session archived')
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'session/title') return
    const id = session?.id
    if (typeof id !== 'string' || !schedule.hasTasks(id) || isPrTitle(event.data?.title)) return
    onTitleAway(id)
  })
}
