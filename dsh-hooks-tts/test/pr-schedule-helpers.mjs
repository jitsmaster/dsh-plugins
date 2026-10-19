/**
 * Shared fakes for the PR-poll-as-Automation-task tests (pr-schedule.test.mjs, pr-schedule-wiring.test.mjs).
 *
 * The fake schedule service mirrors the REAL DSH Schedule service (D:/dev/DSH/packages/schedule/schedule/src/index.ts):
 *   create(sessionId, request, signal?) -> ScheduleRecord   (positional session id; request: { prompt, title, every_seconds })
 *   list({ sessionId })                 -> ScheduleRecord[] (active tasks of that session only; NOT serialized)
 *   delete({ sessionId, id })           -> { id, deleted: true } | { id, deleted: false, code: 'schedule_not_found' }  (never throws for an unknown id)
 * create/delete go through one FIFO chain like the real service; list reads immediately.
 * An 'every' record carries { id, kind: 'every', title, prompt, everySeconds, scheduledAt }.
 *
 * This file has no tests of its own (node --test runs it as an empty file).
 */

/** The fixed model framing line both reminder renderers use (domain.ts SCHEDULED_MESSAGE_FRAMING). */
export const FRAMING = 'This is a scheduled message from the user'

/** Marker line the plugin appends to its task prompt (design brief). */
export const marker = (sessionId, prId) => `[dsh-hooks-tts pr-poll v1 session=${sessionId} pr=${prId}]`
export const taskTitle = (prId) => `PR ${prId} comment poll`

/** Real recurring-batch text (domain.ts renderRecurringReminderBatchFraming): what an 'every' task delivers. */
export function renderBatch(reminders) {
  const payload = reminders.map((r) => ({
    schedule_id: r.id,
    occurrence_at: r.occurrenceAt ?? '2026-10-16T22:50:00.000Z',
    reminder_prompt: r.prompt,
  }))
  return ['[SCHEDULE REMINDER BATCH]', FRAMING, `reminders_json: ${JSON.stringify(payload)}`].join('\n')
}

/** Real single-reminder text (domain.ts renderReminderFraming): what a one-shot task delivers. */
export function renderSingle({ id, prompt, scheduledAt = '2026-10-16T22:50:00.000Z' }) {
  return [
    '[SCHEDULE REMINDER]',
    FRAMING,
    `schedule_id_json: ${JSON.stringify(id)}`,
    `occurrence_at: ${scheduledAt}`,
    `reminder_prompt_json: ${JSON.stringify(prompt)}`,
  ].join('\n')
}

let messageCounter = 0
/** A UserMessage as the schedule runtime delivers it: role 'user', source { kind: 'schedule' }, one text block (runtime.ts createUserMessage). */
export function scheduleMessage(text, source = { kind: 'schedule' }) {
  return { id: `msg-${++messageCounter}`, role: 'user', source, content: [{ type: 'text', text }] }
}

export const messageText = (message) => (message.content ?? []).map((b) => b.text ?? '').join('')

/** Error carrying a ScheduleInputError-style code. */
export const scheduleError = (code, message = code) => Object.assign(new Error(message), { code })

export function fakeSchedule() {
  /** id -> { sessionId, record, status } */
  const rows = new Map()
  const calls = { create: [], list: [], delete: [] }
  const hooks = { createGate: undefined, deleteGate: undefined, createError: undefined, listError: undefined, deleteError: undefined }
  let counter = 0
  let chain = Promise.resolve()
  const serialize = (work) => { const run = chain.then(work); chain = run.catch(() => {}); return run }

  const service = {
    async create(sessionId, request, signal) {
      calls.create.push({ sessionId, request, signal })
      return serialize(async () => {
        if (hooks.createGate) await hooks.createGate
        if (hooks.createError) { const e = hooks.createError; if (hooks.createError.once) hooks.createError = undefined; throw e }
        if (typeof request?.title !== 'string' || !request.title.trim()) throw scheduleError('invalid_prompt', 'title is required')
        if (typeof request?.prompt !== 'string' || !request.prompt.trim()) throw scheduleError('invalid_prompt', 'prompt is required')
        if (!Number.isSafeInteger(request.every_seconds) || request.every_seconds < 60) throw scheduleError('invalid_rule', 'every_seconds must be at least 60')
        const id = `schedule-${++counter}-${Math.random().toString(16).slice(2, 10)}`
        const record = { id, kind: 'every', title: request.title.trim(), prompt: request.prompt.trim(), everySeconds: request.every_seconds, scheduledAt: new Date(Date.now() + request.every_seconds * 1000).toISOString() }
        rows.set(id, { sessionId, record, status: 'active' })
        return record
      })
    },
    async list({ sessionId }) {
      calls.list.push({ sessionId })
      if (hooks.listError) throw hooks.listError
      return [...rows.values()].filter((r) => r.sessionId === sessionId && r.status === 'active').map((r) => r.record)
    },
    async delete({ sessionId, id }) {
      calls.delete.push({ sessionId, id })
      return serialize(async () => {
        if (hooks.deleteGate) await hooks.deleteGate
        if (hooks.deleteError) { const e = hooks.deleteError; if (hooks.deleteError.once) hooks.deleteError = undefined; throw e }
        const row = rows.get(id)
        if (!row || row.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
        rows.delete(id)
        return { id, deleted: true }
      })
    },
  }

  return {
    service,
    calls,
    hooks,
    /** Active records of a session, storage order. */
    tasksOf: (sessionId) => [...rows.values()].filter((r) => r.sessionId === sessionId && r.status === 'active').map((r) => r.record),
    all: () => [...rows.values()].map((r) => ({ sessionId: r.sessionId, ...r.record })),
    /** A task some other party created (a user's own reminder): never ours. */
    addForeign(sessionId, { title = 'standup', prompt = 'say hi' } = {}) {
      const id = `schedule-foreign-${++counter}`
      const record = { id, kind: 'every', title, prompt, everySeconds: 3600, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }
      rows.set(id, { sessionId, record, status: 'active' })
      return record
    },
    /** The user deletes a task in the Automation UI. */
    userDelete: (id) => { rows.delete(id) },
    /** Hold create()/delete() until the returned function is called. */
    gate(kind) {
      let open
      hooks[`${kind}Gate`] = new Promise((resolve) => { open = resolve })
      return () => { hooks[`${kind}Gate`] = undefined; open() }
    },
  }
}

/** Yield to the event loop several times so fire-and-forget promise chains settle. */
export async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Poll `predicate` until truthy or the timeout elapses (returns the last value). */
export async function until(predicate, timeoutMs = 1500) {
  const end = Date.now() + timeoutMs
  let value = predicate()
  while (!value && Date.now() < end) { await new Promise((resolve) => setTimeout(resolve, 10)); value = predicate() }
  return value
}
