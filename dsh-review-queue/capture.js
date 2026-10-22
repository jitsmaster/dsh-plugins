/**
 * Feeds the review queue from DSH events: open questions (user-questions/request), permission requests
 * (approval/request) and finished turns (agent/turn-stopping). Question and permission handlers race the normal
 * on-screen answerer exactly like voice approval does: whichever answers first wins, the other is ignored.
 * Nothing here may break the host: every handler falls through to next() when anything goes wrong.
 */
import { recommendedOf, cleanText } from './speech.js'
import { fallbackSummary } from './summary.js'
import { toolDetail } from './risk.js'
import { isPendingResult, replyAnswers, isHumanMessage } from './signals.js'
import { MAY_HAVE_BEEN_SENT } from './follow-up-shared.js'
import { DEFAULT_AUTO_ANSWER_LEAD_MS, autoAnswerText, recommendedAnswers, shownLabel } from './autoanswer.js'

const TOOL_ARG_KEYS = ['command', 'file_path', 'path', 'url', 'pattern', 'query']
const MAX_NOTES = 200
const MAX_SEEN = 500
/** The most open done cards one session keeps: a session that never gets a human message (schedule ticks, goal rounds) would pile them up. */
export const DEFAULT_KEEP_DONE = 20
/**
 * A done card younger than this is never closed by a message the user typed in its session. Such a message was queued while the turn was
 * still running (typed before the card existed) and reaches the session right after the turn ends, so it cannot be a reply to the card; the
 * user has not had time to read it. Without this the card (often a question in its last paragraph) vanished seconds after it appeared.
 */
export const DEFAULT_REPLY_GRACE_MS = 30_000

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

/**
 * How long DSH waits for an answer when the model passes no timeout: the ask_user_question row's configured timeout (tool-ask-user
 * Config.timeout, 120 s unless changed). The tool's config is not exposed to other plugins, so this default is only a guess that the
 * installCapture option defaultWindowMs (config questionWindowSeconds) overrides for the auto-answer timer; classifyClose uses it
 * to recognise a timeout after the fact. It never sets an item's expiry.
 */
const DEFAULT_ASK_WINDOW_MS = 120_000
const WINDOW_SLACK_BEFORE_MS = 3_000
const WINDOW_SLACK_AFTER_MS = 5_000
const SYSTEM_CODE = /^(E[A-Z0-9]+|UND_ERR_\w+)$/ // ETIMEDOUT and friends: a network timeout is not the question's timeout
const PAIR_WINDOW_MS = 10 * 60 * 1000

/** A value for a one-line log entry: whitespace collapsed, capped. */
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').slice(0, 120)

const stringOf = (value) => (typeof value === 'string' ? value : undefined)
const codeOf = (e) => stringOf(e?.code)
const messageOf = (e) => stringOf(e?.message) ?? stringOf(e) ?? ''
/** The error and its cause chain (a wire record counts as an error). */
function chainOf(error) {
  const chain = []
  for (let e = error, n = 0; e !== undefined && e !== null && n < 6; n++) { chain.push(e); e = typeof e === 'object' ? e.cause : undefined }
  return chain
}

/**
 * Why a question's request ended without an answer. Returns { kind, basis }:
 *   timeout   the question itself timed out: ASK_TIMED_OUT anywhere on the error or its cause chain (an Error, or the bare wire
 *             record {name, code}), a TimeoutError, the text "timed out" (unless it carries a network/system error code), or an
 *             abort-type end after the known deadline (expiresAt), or, when no deadline is known, at DSH's default window.
 *   cancelled the user cancelled it (ASK_CANCELLED).
 *   detached  anything else (disconnect, parent turn abort, ASK_ABORTED with no timeout evidence, a generic error): the live request
 *             is gone but nobody decided the question is over, so the item stays open and is answered through the session.
 * The deadline inferences need an abort-type end (the request signal, ASK_ABORTED, AbortError or a dropped event source) so an
 * unrelated error that happens near 120 s is not mistaken for a timeout.
 */
export function classifyClose(error, { source = 'rejection', elapsedMs = 0, expiresAt, now = 0 } = {}) {
  try {
    const chain = chainOf(error)
    const codes = chain.map(codeOf).filter(Boolean)
    if (codes.includes('ASK_TIMED_OUT')) return { kind: 'timeout', basis: 'code' }
    if (codes.includes('ASK_CANCELLED')) return { kind: 'cancelled', basis: 'code' }
    if (chain.some((e) => e?.name === 'TimeoutError')) return { kind: 'timeout', basis: 'name' }
    if (chain.some((e) => /timed out/i.test(messageOf(e)) && !SYSTEM_CODE.test(codeOf(e) ?? ''))) return { kind: 'timeout', basis: 'message' }
    const abortLike = source === 'abort' || codes.includes('ASK_ABORTED')
      || chain.some((e) => e?.name === 'AbortError' || /forwarded Remote event source ended/i.test(messageOf(e)))
    if (abortLike && Number.isFinite(expiresAt) && now >= expiresAt - WINDOW_SLACK_BEFORE_MS) return { kind: 'timeout', basis: 'deadline' }
    if (abortLike && !Number.isFinite(expiresAt) && elapsedMs >= DEFAULT_ASK_WINDOW_MS - WINDOW_SLACK_BEFORE_MS && elapsedMs <= DEFAULT_ASK_WINDOW_MS + WINDOW_SLACK_AFTER_MS) return { kind: 'timeout', basis: 'default-window' }
    return { kind: 'detached', basis: abortLike ? 'abort' : 'error' }
  } catch { return { kind: 'detached', basis: 'unclassified' } }
}

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

/**
 * How long the auto-answer waits before it acts on a question, as the window of its wait in ms; undefined when it must not act: the request
 * is not a timed wait (legacy blocking ask, indefinite card-keyed ask), the model passed timeout -1 (no deadline), or a question carries a
 * presentation intent (plan review). A positive timeout the model passed is the window; with none, the configured default window.
 */
function answerWindowMs(req, seconds, defaultWindowMs) {
  if (req.wait?.timed !== true || seconds === -1) return undefined
  if ((req.questions ?? []).some((q) => q?.intent !== undefined)) return undefined
  return seconds > 0 ? seconds * 1000 : defaultWindowMs
}

/**
 * autoAnswer / autoAnswerLeadMs: a pending TIMED question (wait.timed) whose every sub-question marks a recommended option is answered with
 * those options this long before its deadline; 0 or autoAnswer false leaves every question to the user. The deadline is the ask's own
 * positive timeout, else defaultWindowMs (the ask_user_question row's timeout: the plugin cannot read it, so config questionWindowSeconds
 * must match it). Known limitation: the plugin cannot see the card's "Take time" or an editing hold, so it may answer while the user is
 * still working on the card.
 * replyGraceMs: a done card younger than this (default 30 s) is not closed by a message typed in its session (a queued message is not a reply to it).
 * keepDone: how many open done cards ('completed') one session keeps (default 20, an invalid value falls back to it); past it the oldest is
 * resolved as 'trimmed' and logged.
 */
export function installCapture(ctx, { store, summarizer, log = () => {}, now = Date.now, autoAnswer = true, autoAnswerLeadMs = DEFAULT_AUTO_ANSWER_LEAD_MS, defaultWindowMs = DEFAULT_ASK_WINDOW_MS, keepDone = DEFAULT_KEEP_DONE, replyGraceMs = DEFAULT_REPLY_GRACE_MS }) {
  const keep = Number.isInteger(keepDone) && keepDone > 0 ? keepDone : DEFAULT_KEEP_DONE
  const children = new Set()
  const autoTimers = new Set() // pending auto-answer timers, cleared when their question ends and on dispose
  const pending = new Map() // item id -> { type, ... }
  const timeouts = boundedMap(MAX_NOTES) // question callId -> the ask's timeout in seconds, or -1 (no deadline)
  const toolNotes = boundedMap(MAX_NOTES) // tool callId -> summary line
  const controller = new AbortController()
  const handlers = {}
  const lateInFlight = new Set() // expired question items whose late answer from the card is being sent
  const detachedInFlight = new Set() // detached open question items whose card answer is being sent
  const askCalls = new Map() // agent id -> [{ callId, at }]: ask_user_question calls seen at tools/pre-execute, for a request that carries no call id
  const seen = new Set() // ids of the sessions whose events this app saw: sessions it can reach (the hub hands it their unowned items)
  const note = (event) => {
    const id = event?.agent?.id
    if (typeof id !== 'string' || !id) return
    seen.delete(id)
    seen.add(id)
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value) // memory: oldest first, the set never grows without bound
  }
  const on = (name, fn, options) => {
    const watched = (event, ...rest) => { note(event); return fn(event, ...rest) }
    handlers[name] = watched
    ctx.on(name, watched, options)
  }

  const titleOf = (agent) => {
    try { return ctx.get?.('sessionTitle')?.get(agent?.session)?.title } catch { return undefined }
  }
  const baseOf = (agent) => ({ sessionId: agent.id, sessionTitle: titleOf(agent) ?? agent.devTitle ?? '', workspace: agent.session?.header?.cwd })
  const nameOf = (item) => item?.title || item?.sessionTitle || item?.id // how a log line names an item
  const guard = (fn, fallback) => {
    try { return fn() } catch (error) { log('capture: ' + (error?.message ?? error)); return fallback }
  }
  // Performance: the open items of one session without copying the whole store (every step of every session asks); a store without peekOpen falls back to list().
  const openOf = (sessionId) => (typeof store.peekOpen === 'function' ? store.peekOpen(sessionId) : store.list({ status: 'open' }).filter((i) => i.sessionId === sessionId))

  /**
   * The session keeps at most `limit` open done cards (default `keep`): the oldest beyond that are resolved as 'trimmed' (with the limit that
   * hid them), each with a log line. Only open cards count, so a card already hidden as no-action takes no place. Memory: the list cannot grow
   * without bound.
   */
  function trimDone(sessionId, limit = keep) {
    guard(() => {
      const cards = openOf(sessionId).filter((i) => i.type === 'completed')
      for (const old of cards.slice(0, Math.max(0, cards.length - limit))) {
        if (store.resolve(old.id, { kind: 'trimmed', by: 'auto', limit })) log('capture: trimmed done item "' + nameOf(old) + '" (' + old.id + ') of session ' + sessionId + ': the session has more than ' + limit + ' open done items')
      }
    })
  }

  on('subagent/start', (info) => { if (info?.id) children.add(info.id) })
  on('subagent/end', (info) => { children.delete(info?.id) })

  const noteAsk = (agentId, callId) => {
    const list = (askCalls.get(agentId) ?? []).filter((c) => now() - c.at < PAIR_WINDOW_MS && c.callId !== callId)
    askCalls.set(agentId, [...list, { callId, at: now() }].slice(-10))
  }
  /** The call id of this agent's oldest ask_user_question call not yet matched to a request (or the named one, now matched). */
  const claimAsk = (agentId, callId) => {
    const list = (askCalls.get(agentId) ?? []).filter((c) => now() - c.at < PAIR_WINDOW_MS)
    const at = callId === undefined ? 0 : list.findIndex((c) => c.callId === callId)
    const [claimed] = at < 0 ? [] : list.splice(at, 1)
    askCalls.set(agentId, list)
    return claimed?.callId
  }

  // What each pending call will do, so a permission card can say it; the question timeout comes from the same event.
  on('tools/pre-execute', async (exec, next) => {
    guard(() => {
      if (exec?.name === 'ask_user_question' && exec.callId !== undefined && exec.agent?.id !== undefined) noteAsk(exec.agent.id, exec.callId)
      if (exec?.name === 'ask_user_question' && Number.isInteger(exec.arguments?.timeout) && (exec.arguments.timeout > 0 || exec.arguments.timeout === -1)) timeouts.set(exec.callId, exec.arguments.timeout)
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
    // The request normally names its call; when it does not, the call seen at tools/pre-execute for this agent is the one.
    const callId = guard(() => claimAsk(agent.id, req.wait?.callId)) ?? req.wait?.callId
    const startedAt = now()
    const seconds = callId === undefined ? undefined : timeouts.get(callId)
    let item
    try {
      item = store.add({
        type: 'question', ...baseOf(agent), key: callId,
        ...(seconds > 0 ? { expiresAt: startedAt + seconds * 1000 } : {}),
        payload: { questions: req.questions ?? [], callId },
      })
    } catch (error) { log('capture: ' + error); return next() }
    if (callId !== undefined) timeouts.delete(callId)
    return new Promise((resolve, reject) => {
      let done = false
      let timer
      const clearAuto = () => { clearTimeout(timer); autoTimers.delete(timer) }
      const finish = (fn) => {
        if (done) return false
        done = true
        pending.delete(item.id)
        clearAuto()
        req.signal?.removeEventListener('abort', onAbort)
        fn()
        return true
      }
      // Only a real timeout or the user's own cancel closes the item; any other end of the request leaves it open, flagged detached.
      const closeOut = (reason, source) => guard(() => {
        const elapsedMs = now() - startedAt
        const verdict = classifyClose(reason, { source, elapsedMs, expiresAt: item.expiresAt, now: now() })
        log('capture: question ' + item.id + ' ended without an answer: name=' + oneLine(reason?.name) + ' code=' + oneLine(reason?.code) + ' message="' + oneLine(messageOf(reason)) + '" after ' + Math.round(elapsedMs / 1000) + 's via ' + source + ' -> ' + verdict.kind + ' (' + verdict.basis + ')')
        if (verdict.kind === 'timeout') store.resolve(item.id, { kind: 'expired', assumed: (req.questions ?? []).map(recommendedOf).filter(Boolean) })
        else if (verdict.kind === 'cancelled') store.resolve(item.id, { kind: 'cancelled' })
        else store.update(item.id, { detached: true })
      })
      const onAbort = () => finish(() => { const reason = req.signal.reason; closeOut(reason, 'abort'); reject(reason ?? new Error('aborted')) })
      pending.set(item.id, {
        type: 'question', questions: req.questions ?? [],
        answer: (answers, by = 'card') => finish(() => { guard(() => store.resolve(item.id, { kind: 'answered', by, answers })); resolve({ answers }) }),
        // The session handled it (a reply there, the call returned): the item leaves now, the request itself is still DSH's to settle.
        handledElsewhere: (resolution) => { pending.delete(item.id); clearAuto(); return guard(() => store.resolve(item.id, resolution), false) },
      })
      if (req.signal?.aborted) return void onAbort()
      req.signal?.addEventListener('abort', onAbort, { once: true })
      // Shortly before the question would time out, the recommended options are taken for the user (like a card answer), and a done card says so.
      const windowMs = autoAnswer && autoAnswerLeadMs > 0 ? answerWindowMs(req, seconds, defaultWindowMs) : undefined
      const delay = windowMs === undefined ? 0 : startedAt + windowMs - autoAnswerLeadMs - now()
      if (delay > 0) {
        timer = setTimeout(() => autoAnswerQuestion(item, req.questions ?? []), delay)
        timer.unref?.()
        autoTimers.add(timer)
      }
      Promise.resolve().then(() => next()).then(
        (result) => finish(() => { guard(() => store.resolve(item.id, { kind: 'answered', by: 'screen', answers: result?.answers })); resolve(result) }),
        (error) => finish(() => { closeOut(error, 'rejection'); reject(error) }),
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
      const cancel = (why) => guard(() => { store.resolve(item.id, { kind: 'cancelled' }); log('capture: permission ' + item.id + ' cancelled: ' + why) })
      const onAbort = () => finish(() => { cancel('the request was aborted'); resolve('cancelled') })
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
        (error) => finish(() => { cancel('the request failed: ' + oneLine(messageOf(error))); reject(error) }),
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
    // Memory: the cap proper applies after the summarizer's verdict (a card hidden as no-action must not push a real one out); until then
    // only this hard upper bound keeps a verdict that never comes from piling cards up.
    trimDone(item.sessionId, keep * 2)
    // The card is usable at once with the fallback; the model summary replaces it when it arrives.
    guard(() => store.update(item.id, { summary: fallbackSummary(reply), summarySource: 'fallback' }))
    void summarizer.summarize(reply, { signal: controller.signal, request }).then((r) => {
      if (r?.text) guard(() => store.update(item.id, { summary: r.text, summarySource: r.source, ...(r.title ? { title: r.title } : {}) }))
      if (typeof r?.actionable === 'boolean') guard(() => store.update(item.id, { actionable: r.actionable }))
      if (r?.actionable === false) hideNoAction(item.id)
      trimDone(item.sessionId) // the verdict is in: count the cards still open
    }, () => trimDone(item.sessionId)) // a failed summary keeps the card with its fallback summary, so the cap applies to it
  })

  /**
   * Rule: a finished message with nothing for the user does not stay in the list. It is resolved (kind 'no-action'), so it
   * is still found under Resolved with its summary, can be reopened, and a log line names it. Only while it is still open:
   * an item the user already reviewed or replied to keeps that resolution. Items that older data records as replaced by it come
   * back, because the older message may be the one that needs the user (nothing is replaced by a newer result any more).
   */
  function hideNoAction(id) {
    guard(() => {
      const item = store.get(id)
      if (!store.resolve(id, { kind: 'no-action', by: 'auto' })) return
      log('capture: hid done item "' + nameOf(item) + '" (no action needed): ' + String(item?.summary ?? '').slice(0, 160))
      let back = 0
      for (const o of store.list({ status: 'resolved' })) {
        if (o.type === 'completed' && o.sessionId === item.sessionId && o.resolution?.kind === 'superseded' && o.resolution.newerId === id && store.reopen(o.id)) back++
      }
      if (back) log('capture: brought back ' + back + ' earlier done item(s) the hidden one had replaced')
    })
  }

  // The user typed into the session again: its finished-work cards have been answered. Only a message the user wrote counts: injected
  // context (background jobs, reminders, goal rounds) and a reply to a question do not.
  on('agent/pre-step', async ({ agent, messages } = {}, next) => {
    guard(() => {
      if (!agent || !messages?.length) return
      const human = messages.some(isHumanMessage)
      const open = openOf(agent.id)
      // A question of that session the user answered there: a reply to it, or a plain message of their own.
      for (const item of open) {
        if (item.type !== 'question') continue
        const answered = human || messages.some((m) => m?.source?.kind === 'user-question-reply' && m.source.callId === item.key)
        if (answered && !detachedInFlight.has(item.id)) closeOpen(item.id, { kind: 'answered', by: 'session' }, 'the user answered in the session')
      }
      if (!human) return
      const grace = Number.isFinite(replyGraceMs) && replyGraceMs > 0 ? replyGraceMs : 0
      for (const item of open) {
        if (item.type === 'completed' && now() - item.createdAt >= grace && store.resolve(item.id, { kind: 'replied', by: 'session' })) log('capture: done item "' + nameOf(item) + '" closed: the user replied in the session')
      }
    })
    return next()
  })

  // The session's own event feed is the reliable signal for a question: the reply that answers it, or the tool call returning.
  on('session/event', (session, event) => {
    guard(() => {
      if (!session || !event) return
      if (event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply') settleQuestion(String(session.id), event.data.source.callId, { answers: replyAnswers(event.data.content) })
      else if (event.type === 'tool/result') {
        claimAsk(String(session.id), event.data?.message?.toolCallId) // a call that returned without ever reaching us cannot name a later request
        settleQuestion(String(session.id), event.data?.message?.toolCallId, { result: event.data.message })
      }
    })
  }, { global: true })

  /** Close an open question item from outside its request: through its pending entry when it has one, else (detached) directly. */
  function closeOpen(id, resolution, why) {
    const entry = pending.get(id)
    const closed = entry ? entry.handledElsewhere(resolution) : guard(() => store.resolve(id, resolution), false)
    if (closed) log('capture: question ' + id + ' closed by session: ' + why)
    return closed
  }

  /**
   * The recommended options, taken shortly before the question's deadline: settles the request like a card answer, then adds a done card
   * that says what was decided (not summarized, never hidden as no-action; the user's next message in the session closes it).
   */
  function autoAnswerQuestion(item, questions) {
    guard(() => {
      const answers = recommendedAnswers(questions)
      const clean = answers && cleanAnswers(questions, answers)
      if (!clean) return void log('capture: question ' + item.id + ' not auto-answered: no usable recommended answer for it')
      if (!pending.get(item.id)?.answer(clean, 'auto')) return void log('capture: question ' + item.id + ' not auto-answered: its request is no longer pending')
      log('capture: question ' + item.id + ' auto-answered with the recommended option: ' + clean.map((a) => a.selected.map(shownLabel).join(', ')).join(' | '))
      const text = autoAnswerText(questions, clean)
      store.add({
        type: 'completed', sessionId: item.sessionId, sessionTitle: item.sessionTitle, workspace: item.workspace, title: 'Question auto-answered',
        summary: text, summarySource: 'auto', actionable: true, payload: { reply: text },
      })
      trimDone(item.sessionId)
    })
  }

  /**
   * A card answer for a question whose live request ended (detached, still open): steer it into the session as DSH's own late
   * reply. When DSH no longer holds the question, or the session is gone, the answer is refused and the item expires (never silently).
   */
  async function answerDetached(item, answers) {
    const clean = cleanAnswers(item.payload?.questions ?? [], answers)
    if (!clean) return { ok: false, error: 'bad-answer' }
    if (detachedInFlight.has(item.id)) return { ok: false, error: 'not-pending' }
    const service = guard(() => ctx.get?.('userQuestions'))
    if (typeof service?.answer !== 'function') return { ok: false, error: 'no-controller' }
    const callId = item.payload?.callId ?? item.key
    const agent = guard(() => ctx.get?.('agents')?.get(item.sessionId))
    const gone = (error, why) => {
      guard(() => store.resolve(item.id, { kind: 'expired', assumed: [] }))
      log('capture: question ' + item.id + ' expired: ' + why)
      return { ok: false, error }
    }
    if (!agent) return gone('no-session', 'the session is not running any more')
    if (callId === undefined) return gone('not-pending', 'the question has no call id to answer through')
    detachedInFlight.add(item.id) // its reply reaching the session must not re-label the item before we record it
    let accepted
    try { accepted = await service.answer(agent, callId, { answers: clean }) } catch (error) {
      detachedInFlight.delete(item.id)
      const code = error?.code
      if (code === 'CALLER_NOT_LIVE' || code === 'DELEGATED_CALLER') return gone('no-session', 'DSH no longer has the calling session live')
      return { ok: false, error: code === 'REPLY_QUEUED' ? 'reply-queued' : code === 'BAD_ANSWER' ? 'bad-answer' : String(error?.message ?? error) }
    }
    detachedInFlight.delete(item.id)
    if (!accepted) return gone('not-pending', 'DSH no longer holds the question')
    guard(() => store.resolve(item.id, { kind: 'answered', by: 'card', answers: clean }))
    return { ok: true }
  }

  /** Close the question item (open or expired) of this session and call id, once. */
  function settleQuestion(sessionId, callId, { answers, result }) {
    if (callId === undefined) return
    const item = store.list().find((i) => i.type === 'question' && i.key === callId && i.sessionId === sessionId && !detachedInFlight.has(i.id) && (i.status === 'open' || (i.resolution?.kind === 'expired' && !lateInFlight.has(i.id))))
    if (!item) return
    if (item.status === 'open') {
      if (result && isPendingResult(result.content)) {
        closeOpen(item.id, { kind: 'expired', assumed: (item.payload?.questions ?? []).map(recommendedOf).filter(Boolean) }, 'its wait ran out and the assistant carried on')
      } else {
        const a = answers?.length ? answers : replyAnswers(result?.content)
        closeOpen(item.id, { kind: 'answered', by: 'session', ...(a?.length ? { answers: a } : {}) }, 'answered in the session')
      }
    } else if (answers) {
      store.update(item.id, { resolution: { ...item.resolution, kind: 'answered', by: 'session', ...(answers.length ? { answers } : {}) } })
    }
  }

  on('agent/disposed', ({ agent } = {}) => {
    if (!agent) return
    children.delete(agent.id)
    seen.delete(agent.id)
    const open = guard(() => store.list({ status: 'open' }).filter((i) => i.sessionId === agent.id).length, 0)
    if (guard(() => store.resolveSession(agent.id, { kind: 'session-ended' }), false)) log('capture: session-ended: closed ' + open + ' open item(s) of session ' + agent.id)
  })

  return {
    /**
     * Answer a pending question from the card. answers: [{ id, selected, custom? }], one per question. A detached question (its live
     * request ended, the item is still open) is answered through the session instead; that call is asynchronous.
     */
    answerQuestion(itemId, answers) {
      const entry = pending.get(itemId)
      if (!entry) {
        const item = store.get(itemId)
        return item?.type === 'question' && item.status === 'open' && item.detached ? answerDetached(item, answers) : { ok: false, error: 'not-pending' }
      }
      if (entry.type !== 'question') return { ok: false, error: 'not-pending' }
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
    /** The sessions whose events this app has seen and that are not disposed. */
    seenSessionIds: () => [...seen],
    /** The registered event handlers by name (the dev route drives the real code path through them). */
    handlers,
    dispose() { controller.abort(); autoTimers.forEach(clearTimeout); autoTimers.clear() },
  }
}

/**
 * After a restart no request is waiting any more: open questions and permission requests can no longer be answered
 * from here, so they leave the queue. Finished-work and merged-PR items stay. A todo stays too; one that was being started
 * is a failed one now (Retry starts it, reusing a session that was already created); a follow-up that was being sent is failed with the may-have-been-sent warning instead (its prompt may be in the session already). With { only: Set<id> } just those items
 * are looked at; with { log } every item it cancels is named there.
 */
export function cancelStalePending(store, { only, log } = {}) {
  let n = 0
  for (const item of store.list({ status: 'open' })) {
    if (only && !only.has(item.id)) continue // only: the ids that existed before this process (an item of this process has a live request)
    if (item.type === 'todo') {
      if (item.state === 'starting') store.update(item.id, { state: 'failed', error: item.kind === 'followup' ? MAY_HAVE_BEEN_SENT : 'Interrupted by a server restart. Retry to start it.' })
      else if (item.suggesting) store.update(item.id, { suggesting: false })
      continue
    }
    if (item.type === 'paused') continue // the next scan of the session logs decides whether it is still cut off
    if (item.type !== 'completed' && item.type !== 'pr-merged' && item.type !== 'archive' && store.resolve(item.id, { kind: 'cancelled', by: 'restart' })) {
      n++
      log?.('capture: ' + item.type + ' ' + item.id + ' cancelled: its request died with the earlier process')
    }
  }
  return n
}
