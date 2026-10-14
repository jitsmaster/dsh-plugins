/**
 * Feeds the review queue from DSH events: open questions (user-questions/request), permission requests
 * (approval/request) and finished turns (agent/turn-stopping). Question and permission handlers race the normal
 * on-screen answerer exactly like voice approval does: whichever answers first wins, the other is ignored.
 * Nothing here may break the host: every handler falls through to next() when anything goes wrong.
 */
import { recommendedOf, lastParagraph, cleanText } from './speech.js'

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
  const on = (name, fn) => { handlers[name] = fn; ctx.on(name, fn) }

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
      else if (exec?.callId) toolNotes.set(exec.callId, summarizeTool(exec.name, exec.arguments))
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
        payload: { toolName: req.toolName, summary: note ?? summarizeTool(req.toolName), reason: typeof req.reason === 'string' ? req.reason : undefined, callId: req.callId },
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
    // The card is usable at once with the fallback; the model summary replaces it when it arrives.
    guard(() => store.update(item.id, { summary: lastParagraph(reply), summarySource: 'fallback' }))
    void summarizer.summarize(reply, { signal: controller.signal, request }).then((r) => {
      if (r?.text) guard(() => store.update(item.id, { summary: r.text, summarySource: r.source, ...(r.title ? { title: r.title } : {}) }))
    }, () => {})
  })

  // The user typed into the session again: its finished-work cards have been answered.
  on('agent/pre-step', async ({ agent, messages } = {}, next) => {
    guard(() => {
      if (!agent || !messages?.length) return
      for (const item of store.list({ status: 'open' })) {
        if (item.type === 'completed' && item.sessionId === agent.id) store.resolve(item.id, { kind: 'replied', by: 'session' })
      }
    })
    return next()
  })

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
      try { accepted = await service.answer(agent, item.payload.callId, { answers: clean }) } catch (error) {
        const code = error?.code
        return { ok: false, error: code === 'REPLY_QUEUED' ? 'reply-queued' : code === 'BAD_ANSWER' ? 'bad-answer' : String(error?.message ?? error) }
      }
      if (!accepted) return { ok: false, error: 'not-pending' }
      store.update(itemId, { resolution: { ...item.resolution, kind: 'late-answered', by: 'card', answers: clean } })
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
 * from here, so they leave the queue. Finished-work items stay.
 */
export function cancelStalePending(store) {
  let n = 0
  for (const item of store.list({ status: 'open' })) {
    if (item.type !== 'completed' && store.resolve(item.id, { kind: 'cancelled', by: 'restart' })) n++
  }
  return n
}
