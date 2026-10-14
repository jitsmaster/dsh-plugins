/**
 * Feeds the review queue from DSH events: open questions (user-questions/request), permission requests
 * (approval/request) and finished turns (agent/turn-stopping). Question and permission handlers race the normal
 * on-screen answerer exactly like voice approval does: whichever answers first wins, the other is ignored.
 * Nothing here may break the host: every handler falls through to next() when anything goes wrong.
 */
import { recommendedOf, lastParagraph, cleanText } from './speech.js'
import { toolDetail } from './risk.js'
import { isPendingResult, replyAnswers, isHumanMessage } from './signals.js'

const TOOL_ARG_KEYS = ['command', 'file_path', 'path', 'url', 'pattern', 'query']
const MAX_NOTES = 200

/** One short line saying what a tool call will do: "shell: git push", "write: D:/a.md", or just the tool name. */
export function summarizeTool(name, args) {
  const label = cleanText(String(name ?? ''), { maxChars: 60 })
  for (const key of TOOL_ARG_KEYS) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim()) return label + ': ' + cleanText(value, { maxChars: 200 })
  }
  return label
}

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('')
}

/** The request that started a finished turn is kept (capped) as context for its title. */
const MAX_REQUEST = 2000

const isTimeout = (reason) => reason?.code === 'ASK_TIMED_OUT'

/** Bounded map: the oldest entry goes when it is full. */
function boundedMap(limit) {
  const map = new Map()
  return {
    set(key, value) { map.delete(key); map.set(key, value); if (map.size > limit) map.delete(map.keys().next().value) },
    get: (key) => map.get(key),
    delete: (key) => map.delete(key),
  }
}

/** One validated answer per question (options must exist, one choice unless multiSelect, something chosen or typed); undefined when the batch is not acceptable. */
function cleanAnswers(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) return undefined
  const ids = new Set()
  for (const a of answers) {
    const q = questions.find((x) => x.id === a?.id)
    if (!q || ids.has(a.id) || !Array.isArray(a.selected)) return undefined
    ids.add(a.id)
    const labels = (q.options ?? []).map((o) => o.label)
    if (a.selected.some((v) => !labels.includes(v))) return undefined
    if (!a.selected.length && !(typeof a.custom === 'string' && a.custom.trim())) return undefined
    if (a.selected.length > 1 && !q.multiSelect) return undefined
  }
  return answers.map((a) => ({ id: a.id, selected: a.selected, ...(typeof a.custom === 'string' && a.custom.trim() ? { custom: a.custom.trim() } : {}) }))
}

/** True when every answer is exactly the recommended option the assistant already carried on with. */
function isDefaultAnswer(questions, clean) {
  return questions.every((q) => {
    const rec = recommendedOf(q)
    const a = clean.find((x) => x.id === q.id)
    return rec !== undefined && a && !a.custom && a.selected.length === 1 && a.selected[0] === rec
  })
}

export function installCapture(ctx, { store, summarizer, log = () => {} }) {
  const children = new Set()
  const pending = new Map() // item id -> { type, ... }
  const timeouts = boundedMap(MAX_NOTES) // question callId -> seconds
  const toolNotes = boundedMap(MAX_NOTES) // tool callId -> summary line
  const controller = new AbortController()
  const handlers = {}
  const lateInFlight = new Set() // expired question items whose late answer from the card is being sent
  const on = (name, fn, options) => { handlers[name] = fn; ctx.on(name, fn, options) }

  const titleOf = (agent) => {
    try { return ctx.get?.('sessionTitle')?.get(agent?.session)?.title } catch { return undefined }
  }
  const baseOf = (agent) => ({ sessionId: agent.id, sessionTitle: titleOf(agent) ?? agent.devTitle ?? '', workspace: agent.session?.header?.cwd })
  const guard = (fn, fallback) => {
    try { return fn() } catch (error) { log('capture: ' + (error?.message ?? error)); return fallback }
  }

  on('subagent/start', (info) => { if (info?.id) children.add(info.id) })
  on('subagent/end', (info) => { children.delete(info?.id) })

  // What each pending call will do, so a permission card can say it; the question timeout comes from the same event.
  on('tools/pre-execute', async (exec, next) => {
    guard(() => {
      if (exec?.name === 'ask_user_question' && Number.isInteger(exec.arguments?.timeout) && exec.arguments.timeout > 0) timeouts.set(exec.callId, exec.arguments.timeout)
      else if (exec?.callId) {
        const path = [exec.arguments?.file_path, exec.arguments?.path].find((v) => typeof v === 'string' && v)
        toolNotes.set(exec.callId, { summary: summarizeTool(exec.name, exec.arguments), detail: toolDetail(exec.name, exec.arguments), path })
      }
    })
    return next()
  })

  on('user-questions/request', (req, next) => {
    const agent = req?.agent
    if (!agent || children.has(agent.id)) return next()
    const callId = req.wait?.callId
    const seconds = callId === undefined ? undefined : timeouts.get(callId)
    let item
    try {
      item = store.add({
        type: 'question', ...baseOf(agent), key: callId,
        ...(seconds ? { expiresAt: Date.now() + seconds * 1000 } : {}),
        payload: { questions: req.questions ?? [], callId },
      })
    } catch (error) { log('capture: ' + error); return next() }
    if (callId !== undefined) timeouts.delete(callId)
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (fn) => {
        if (done) return false
        done = true
        pending.delete(item.id)
        req.signal?.removeEventListener('abort', onAbort)
        fn()
        return true
      }
      const closeOut = (reason) => guard(() => {
        if (isTimeout(reason)) store.resolve(item.id, { kind: 'expired', assumed: (req.questions ?? []).map(recommendedOf).filter(Boolean) })
        else store.resolve(item.id, { kind: 'cancelled' })
      })
      const onAbort = () => finish(() => { const reason = req.signal.reason; closeOut(reason); reject(reason ?? new Error('aborted')) })
      pending.set(item.id, {
        type: 'question', questions: req.questions ?? [],
        answer: (answers) => finish(() => { guard(() => store.resolve(item.id, { kind: 'answered', by: 'card', answers })); resolve({ answers }) }),
        // The session handled it (a reply there, the call returned): the item leaves now, the request itself is still DSH's to settle.
        handledElsewhere: (resolution) => { pending.delete(item.id); return guard(() => store.resolve(item.id, resolution), false) },
      })
      if (req.signal?.aborted) return void onAbort()
      req.signal?.addEventListener('abort', onAbort, { once: true })
      Promise.resolve().then(() => next()).then(
        (result) => finish(() => { guard(() => store.resolve(item.id, { kind: 'answered', by: 'screen', answers: result?.answers })); resolve(result) }),
        (error) => finish(() => { closeOut(error); reject(error) }),
      )
    })
  })

  on('approval/request', (req, next) => {
    const agent = req?.agent
    if (!agent || children.has(agent.id)) return next()
    let item
    try {
      const note = req.callId === undefined ? undefined : toolNotes.get(req.callId)
      item = store.add({
        type: 'permission', ...baseOf(agent), key: req.callId,
        payload: { toolName: req.toolName, summary: note?.summary ?? summarizeTool(req.toolName), ...(note?.detail ? { detail: note.detail } : {}), ...(note?.path ? { path: note.path } : {}), reason: typeof req.reason === 'string' ? req.reason : undefined, callId: req.callId },
      })
    } catch (error) { log('capture: ' + error); return next() }
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (fn) => {
        if (done) return false
        done = true
        pending.delete(item.id)
        if (req.callId !== undefined) toolNotes.delete(req.callId)
        req.signal?.removeEventListener('abort', onAbort)
        fn()
        return true
      }
      const kindOf = (outcome) => (outcome === 'rejected' ? 'denied' : String(outcome).startsWith('allowed') ? 'approved' : 'cancelled')
      const onAbort = () => finish(() => { guard(() => store.resolve(item.id, { kind: 'cancelled' })); resolve('cancelled') })
      pending.set(item.id, {
        type: 'permission',
        decide: (decision) => finish(() => {
          guard(() => store.resolve(item.id, { kind: decision === 'approve' ? 'approved' : 'denied', by: 'card' }))
          resolve(decision === 'approve' ? 'allowed-once' : 'rejected')
        }),
      })
      if (req.signal?.aborted) return void onAbort()
      req.signal?.addEventListener('abort', onAbort, { once: true })
      Promise.resolve().then(() => next()).then(
        (outcome) => finish(() => { guard(() => store.resolve(item.id, { kind: kindOf(outcome), by: 'screen' })); resolve(outcome) }),
        (error) => finish(() => { guard(() => store.resolve(item.id, { kind: 'cancelled' })); reject(error) }),
      )
    })
  })

  on('agent/turn-stopping', async ({ agent } = {}) => {
    if (!agent || children.has(agent.id)) return
    let request = ''
    const reply = guard(() => {
      const messages = agent.session.deriveMessages()
      request = textOf(messages.filter((m) => m.role === 'user').at(-1)?.content).trim().slice(0, MAX_REQUEST)
      return textOf(messages.filter((m) => m.role === 'assistant').at(-1)?.content).trim()
    }, '')
    if (!reply) return
    const item = guard(() => store.add({ type: 'completed', ...baseOf(agent), payload: { reply, ...(request ? { request } : {}) } }))
    if (!item) return
    // A newer result from the same session replaces its older unreviewed ones (they stay in Resolved, and can be reopened).
    const older = guard(() => store.list({ status: 'open' }).filter((o) => o.type === 'completed' && o.sessionId === agent.id && o.id !== item.id), [])
    let replaced = 0
    for (const o of older) if (guard(() => store.resolve(o.id, { kind: 'superseded', by: 'newer', newerId: item.id }), false)) replaced++
    if (replaced) guard(() => store.update(item.id, { earlier: replaced }))
    // The card is usable at once with the fallback; the model summary replaces it when it arrives.
    guard(() => store.update(item.id, { summary: lastParagraph(reply), summarySource: 'fallback' }))
    void summarizer.summarize(reply, { signal: controller.signal, request }).then((r) => {
      if (r?.text) guard(() => store.update(item.id, { summary: r.text, summarySource: r.source, ...(r.title ? { title: r.title } : {}) }))
      if (typeof r?.actionable === 'boolean') guard(() => store.update(item.id, { actionable: r.actionable }))
      if (r?.actionable === false) hideNoAction(item.id)
    }, () => {})
  })

  /**
   * Rule: a finished message with nothing for the user does not stay in the list. It is resolved (kind 'no-action'), so it
   * is still found under Resolved with its summary, can be reopened, and a log line names it. Only while it is still open:
   * an item the user already reviewed or replied to keeps that resolution. Items it had replaced come back, because the
   * older message may be the one that needs the user.
   */
  function hideNoAction(id) {
    guard(() => {
      const item = store.get(id)
      if (!store.resolve(id, { kind: 'no-action', by: 'auto' })) return
      log('capture: hid done item "' + (item?.title || item?.sessionTitle || id) + '" (no action needed): ' + String(item?.summary ?? '').slice(0, 160))
      let back = 0
      for (const o of store.list({ status: 'resolved' })) {
        if (o.type === 'completed' && o.sessionId === item.sessionId && o.resolution?.kind === 'superseded' && o.resolution.newerId === id && store.reopen(o.id)) back++
      }
      if (back) log('capture: brought back ' + back + ' earlier done item(s) the hidden one had replaced')
    })
  }

  // The user typed into the session again: its finished-work cards have been answered.
  on('agent/pre-step', async ({ agent, messages } = {}, next) => {
    guard(() => {
      if (!agent || !messages?.length) return
      for (const item of store.list({ status: 'open' })) {
        if (item.type === 'completed' && item.sessionId === agent.id) store.resolve(item.id, { kind: 'replied', by: 'session' })
      }
      // A question of that session the user answered there: a reply to it, or a plain message of their own.
      for (const item of store.list({ status: 'open' })) {
        if (item.type !== 'question' || item.sessionId !== agent.id) continue
        const answered = messages.some((m) => (m?.source?.kind === 'user-question-reply' ? m.source.callId === item.key : isHumanMessage(m)))
        if (answered) pending.get(item.id)?.handledElsewhere({ kind: 'answered', by: 'session' }) ?? store.resolve(item.id, { kind: 'answered', by: 'session' })
      }
    })
    return next()
  })

  // The session's own event feed is the reliable signal for a question: the reply that answers it, or the tool call returning.
  on('session/event', (session, event) => {
    guard(() => {
      if (!session || !event) return
      if (event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply') settleQuestion(String(session.id), event.data.source.callId, { answers: replyAnswers(event.data.content) })
      else if (event.type === 'tool/result') settleQuestion(String(session.id), event.data?.message?.toolCallId, { result: event.data.message })
    })
  }, { global: true })

  /** Close the question item (open or expired) of this session and call id, once. */
  function settleQuestion(sessionId, callId, { answers, result }) {
    if (callId === undefined) return
    const item = store.list().find((i) => i.type === 'question' && i.key === callId && i.sessionId === sessionId && (i.status === 'open' || (i.resolution?.kind === 'expired' && !lateInFlight.has(i.id))))
    if (!item) return
    if (item.status === 'open') {
      if (result && isPendingResult(result.content)) {
        pending.get(item.id)?.handledElsewhere({ kind: 'expired', assumed: (item.payload?.questions ?? []).map(recommendedOf).filter(Boolean) })
      } else {
        const a = answers?.length ? answers : replyAnswers(result?.content)
        pending.get(item.id)?.handledElsewhere({ kind: 'answered', by: 'session', ...(a?.length ? { answers: a } : {}) })
      }
    } else if (answers) {
      store.update(item.id, { resolution: { ...item.resolution, kind: 'answered', by: 'session', ...(answers.length ? { answers } : {}) } })
    }
  }

  on('agent/disposed', ({ agent } = {}) => {
    if (!agent) return
    children.delete(agent.id)
    guard(() => store.resolveSession(agent.id, { kind: 'session-ended' }))
  })

  return {
    /** Answer a pending question from the card. answers: [{ id, selected, custom? }], one per question. */
    answerQuestion(itemId, answers) {
      const entry = pending.get(itemId)
      if (!entry || entry.type !== 'question') return { ok: false, error: 'not-pending' }
      const clean = cleanAnswers(entry.questions, answers)
      if (!clean) return { ok: false, error: 'bad-answer' }
      return entry.answer(clean) ? { ok: true } : { ok: false, error: 'not-pending' }
    },
    /**
     * Answer a question that already expired. The assistant carried on with the recommended option; if the late answer is
     * the same, nothing is sent (the item is just confirmed), otherwise it is steered into the session as a late reply.
     */
    async lateAnswerQuestion(itemId, answers) {
      const item = store.get(itemId)
      if (!item || item.type !== 'question' || item.status !== 'resolved' || item.resolution?.kind !== 'expired') return { ok: false, error: 'not-expired' }
      const questions = item.payload?.questions ?? []
      const clean = cleanAnswers(questions, answers)
      if (!clean) return { ok: false, error: 'bad-answer' }
      if (isDefaultAnswer(questions, clean)) {
        store.update(itemId, { resolution: { ...item.resolution, kind: 'confirmed', by: 'card', answers: clean } })
        return { ok: true, sent: false }
      }
      const agent = guard(() => ctx.get?.('agents')?.get(item.sessionId))
      const service = guard(() => ctx.get?.('userQuestions'))
      if (!agent || typeof service?.answer !== 'function') return { ok: false, error: 'no-session' }
      let accepted
      lateInFlight.add(itemId) // its reply reaching the session must not re-label the item before we record it
      try { accepted = await service.answer(agent, item.payload.callId, { answers: clean }) } catch (error) {
        lateInFlight.delete(itemId)
        const code = error?.code
        return { ok: false, error: code === 'REPLY_QUEUED' ? 'reply-queued' : code === 'BAD_ANSWER' ? 'bad-answer' : String(error?.message ?? error) }
      }
      if (!accepted) { lateInFlight.delete(itemId); return { ok: false, error: 'not-pending' } }
      store.update(itemId, { resolution: { ...item.resolution, kind: 'late-answered', by: 'card', answers: clean } })
      lateInFlight.delete(itemId)
      return { ok: true, sent: true }
    },
    decidePermission(itemId, decision) {
      const entry = pending.get(itemId)
      if (!entry || entry.type !== 'permission') return { ok: false, error: 'not-pending' }
      if (decision !== 'approve' && decision !== 'deny') return { ok: false, error: 'bad-decision' }
      return entry.decide(decision) ? { ok: true } : { ok: false, error: 'not-pending' }
    },
    /** The registered event handlers by name (the dev route drives the real code path through them). */
    handlers,
    dispose() { controller.abort() },
  }
}

/**
 * After a restart no request is waiting any more: open questions and permission requests can no longer be answered
 * from here, so they leave the queue. Finished-work items stay. A todo stays too; one that was being started
 * is a failed one now (Retry starts it, reusing a session that was already created).
 */
export function cancelStalePending(store) {
  let n = 0
  for (const item of store.list({ status: 'open' })) {
    if (item.type === 'todo') {
      if (item.state === 'starting') store.update(item.id, { state: 'failed', error: 'Interrupted by a server restart. Retry to start it.' })
      else if (item.suggesting) store.update(item.id, { suggesting: false })
      continue
    }
    if (item.type !== 'completed' && store.resolve(item.id, { kind: 'cancelled', by: 'restart' })) n++
  }
  return n
}
