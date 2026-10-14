/**
 * Two-stage voice conversation flow (docs/voice-two-stage-flow.md §1, §2, §5).
 * Every outcome is spoken; nothing executes without two yeses (echo confirm + read-back confirm).
 * All collaborators are injected so the state machine is deterministic under fake timers.
 *
 * Turn discipline: every state entry bumps s.turn. Every await re-checks its captured turn afterwards, so a
 * barge-in, abort or re-capture silently drops pending speak/listen/decide/execute continuations. Listens carry
 * {flow:'voice', id, turn, step}; only an exact match with the current listen is consumed, anything else is stale.
 * Barge-in and abort also call cancelSpeech(), which silences queued and in-flight lines (the mic is open: a stale line
 * must not play into it). A line that resolves 'cancelled' or 'muted' (tts-muted.flag) ends its turn silently (no retry, no speak-dead).
 * Exception: a barge-in or capture during EXECUTE is held (the action ran either way, so its outcome is always said):
 * the result line waits until the barge-in's listen has ended (transcript or idle) so it is not spoken into the open
 * mic, is then spoken first, and a held capture then starts the next conversation.
 *
 * Task-list fast path (optional `queue` dependency, dsh-review-queue/docs/voice-task-list.md): a capture that IS a read-only
 * task-list command (queue.match(text) → intent) runs at once, with no echo, no LLM and no "yes", then speaks its outcome line
 * (or nothing) and ends. A listening{context:null} (hotkey / GUI capture) stops the queue reader so it never speaks into the open mic.
 * The reply intent (queue.prepareReply present) starts the voice reply instead: REPLY_DICTATE -> REPLY_CONFIRM -> EXECUTE (flow-reply.js).
 * So do approve / deny / option / recommended / answer (slice 6): the queue returns moves (ask -> REPLY_ASK, confirm -> REPLY_CONFIRM) the same way.
 */

import { VOICE } from './speaker.js'
import { speakableUtterance } from './sanitize.js'
import { createReplyStep, REPLY_STEPS } from './flow-reply.js'

const LISTEN_RETRY_MS = 500
/** Events of a barge-in/capture listen (context null) that are held while EXECUTE runs. */
const HELD_EVENTS = new Set(['listening', 'transcript', 'idle', 'error'])
const LOG_RAW_MAX = 300
/** The read-only task-list intents the flow runs itself; reply starts the voice reply when the queue can prepare one; anything else takes the normal echo path. */
const FAST_KINDS = new Set(['show', 'hide', 'count', 'read', 'next', 'again', 'stop', 'open'])
/** The intents that start a voice answer to the first item (flow-reply.js): reply to a done item, approve / deny, option / recommended / free text. They need queue.prepareReply. */
const REPLY_KINDS = new Set(['reply', 'approve', 'deny', 'option', 'recommended', 'answer'])
/** The step whose answers are classified with another step's rules: the reply read-back is as strict as the action read-back. */
const CLASSIFY_AS = Object.freeze({ [REPLY_STEPS.confirm]: 'decision' })
/** An execute() that has not settled by then counts as failed ("That failed: timed out."), so a hung call cannot hold EXECUTE forever. */
const EXECUTE_TIMEOUT_MS = 35_000
/** How long STT waits for the user to START speaking in a plugin-opened answer window (the `window_s` sent to POST /listen; STT accepts up to 60). */
export const LISTEN_WAIT_S = 30
/**
 * Added to windowS (LISTEN_WAIT_S = 30 s: how long STT waits for speech to BEGIN) to give the answer guard and the EXECUTE hold timer 140 s in total.
 * The plugin must never give up before the STT daemon does: this total has to stay above STT's `max_utterance_s` (120 s, the STT
 * project's config.example.toml) plus the transcription time. Raise it together with that setting.
 */
export const ANSWER_GUARD_EXTRA_MS = 110_000

const LINES = Object.freeze({
  notCaught: 'I did not catch that.',
  sayAgain: 'Please say it again.',
  cancelled: 'Cancelled.',
  noAnswer: 'No answer. Cancelled.',
  sttFailed: 'Speech recognition failed. Cancelled.',
  micBusy: 'The microphone is busy. Cancelled.',
  sttDown: 'Speech service unavailable. Cancelled.',
  noIdea: 'I could not work out what to do. Cancelled.',
  noSession: 'No session is known. Cancelled.',
  badAnswer: "I could not understand the LLM's answer. Cancelled.",
  tooLong: 'That is too long to confirm by voice. Cancelled.',
  unspeakable: 'I could not repeat that back safely. Cancelled.',
  notApprovable: 'That request is too long or unclear to approve by voice. Answer it on screen.',
})

/** decide() error kind → final line (T15–T17). Unknown kinds count as "LLM not available". */
const LLM_ERRORS = Object.freeze({
  timeout: 'The LLM did not answer in time. Cancelled.',
  llm: 'The LLM is not available. Cancelled.',
  unparseable: LINES.badAnswer,
})

/** Listen step → state-name prefix of its *_SPEAK / *_LISTEN pair. */
const PREFIX = Object.freeze({ echo: 'ECHO', decision: 'READBACK', clarify: 'CLARIFY' })

/**
 * What may be logged of an action: its type, session and bounded summary only. The approval token is the live pending-request
 * entry object, and prompt text / titles are not needed to debug the flow.
 */
function loggable(action) {
  if (!action || typeof action !== 'object') return undefined
  return { action: action.action, ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}), ...(action.summary ? { summary: action.summary } : {}) }
}

const echoLine = (text) => 'I heard: ' + text + '. Is that right?'

/** "That failed: {msg}." — msg = first sentence of the error without terminal punctuation, at most 80 chars (T24). */
export function failText(error) {
  const message = String(error?.message ?? error ?? '').trim()
  const first = (message.split(/(?<=[.!?。！？])\s+/)[0] || 'unknown error').replace(/[.!?。！？]+$/, '').trim()
  return 'That failed: ' + (first.slice(0, 80).trimEnd() || 'unknown error') + '.'
}

export function createVoiceFlow({
  speak, listen, decide, validate, readBack, resultText, execute, classify,
  now = Date.now, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
  uuid, windowS = LISTEN_WAIT_S, guardExtraMs = ANSWER_GUARD_EXTRA_MS, maxClarify = 2, cancelSpeech, executeTimeoutMs = EXECUTE_TIMEOUT_MS,
  onIdle = () => {}, // the conversation just ended (reset to IDLE): the service uses it to replay held alerts at once
  chime, // optional () → Promise<{status}>: the singing-bowl strike played while decide() runs (best-effort, see playChime). Absent: that step is silent
  queue, // optional task-list fast path: { match(text) → intent | undefined, run(intent) → { outcome, line?, silence? }, stop() }
}) {
  const s = { state: 'IDLE', id: null, turn: 0, step: null, utterance: '', history: [], action: null, clarifies: 0, t0: 0, guard: null, hold: null, listenAt: 0, decideAc: null, reply: null }

  const ctxFor = (step) => ({ flow: 'voice', id: s.id, turn: s.turn, step })
  const mine = (c) => !!c && c.flow === 'voice' && c.id === s.id && c.turn === s.turn && c.step === s.step

  /** log() must never break the flow; every entry carries the conversation id/turn and ms since capture. */
  function note(stage, data = {}) {
    try { log(stage, { id: s.id, turn: s.turn, dt: now() - s.t0, ...data }) } catch { /* logging is best-effort */ }
  }

  /** Runs a detached async step; an unexpected throw (e.g. a dep bug) ends the conversation instead of crashing. */
  function detach(promise) {
    promise.catch((e) => { note('error', { message: String(e?.message ?? e) }); clearGuard(); dropHold(); reset() })
  }

  // The voice reply steps (flow-reply.js) run on the flow's own primitives; created here, used by capture() and answer().
  const replyStep = queue && createReplyStep({
    queue, note, now,
    io: { s, lines: LINES, failText, enter, end, reset, clearGuard, sayThenListen, openListen, withTimeout, beginHold, settleHeld },
  })

  const sleep = (ms) => new Promise((resolve) => setTimer(resolve, ms))

  // ---- event entry point -------------------------------------------------------------------------------

  function handle(ev) {
    if (!ev || typeof ev !== 'object') return
    const c = ev.context
    // A capture is starting (hotkey / GUI / wake): the task-list reader must not talk into the open mic, whatever the flow is doing.
    if (ev.type === 'listening' && c == null) stopQueue()
    if (c && c.flow === 'voice' && !mine(c)) return note('stale', { ev: ev.type, c })
    if (s.hold && c == null && HELD_EVENTS.has(ev.type)) return holdEvent(ev)
    if (ev.type === 'listening') return c == null ? (s.state !== 'IDLE' ? bargeIn() : undefined) : note('listen.open', { ms: now() - s.listenAt })
    if (ev.type === 'transcribing') return mine(c) ? rearmGuard() : undefined
    if (ev.type === 'transcript') {
      if (ev.revision !== 1) return
      if (c == null) return capture(ev)
      if (mine(c)) return answer(ev.text)
      return
    }
    if ((ev.type === 'idle' || ev.type === 'error') && mine(c)) return listenEnded(ev)
  }

  function capture(ev) {
    abortTurn('recapture')
    s.id = uuid(); s.history = []; s.clarifies = 0; s.action = null; s.reply = null; s.t0 = now()
    note('capture.transcript', { text: ev.text, sttSeconds: ev.seconds, source: ev.source })
    const text = String(ev.text ?? '').trim()
    if (!text) return void detach(end(LINES.notCaught))
    const intent = matchQueue(text)
    if (intent) return void detach(REPLY_KINDS.has(intent.kind) ? replyStep.start(intent) : runQueue(intent))
    echo(text, s.t0)
  }

  // ---- task-list fast path -------------------------------------------------------------------------------

  /** The task-list intent this utterance is, if it is one of the kinds the flow runs; a matcher bug counts as "not a command". */
  function matchQueue(text) {
    if (!queue) return undefined
    try {
      const intent = queue.match(text)
      if (!intent) return undefined
      return FAST_KINDS.has(intent.kind) || (REPLY_KINDS.has(intent.kind) && typeof queue.prepareReply === 'function') ? intent : undefined
    } catch (e) {
      note('queue.error', { phase: 'match', message: String(e?.message ?? e) })
      return undefined
    }
  }

  function stopQueue() {
    try { queue?.stop?.() } catch (e) { note('queue.error', { phase: 'stop', message: String(e?.message ?? e) }) }
  }

  /** Runs one task-list command, then speaks its outcome line (none → silent end). No echo, no LLM, no re-listen. */
  async function runQueue(intent) {
    const turn = enter('QUEUE'); s.step = 'queue'
    const t = now()
    let result
    try {
      result = (await withTimeout(() => queue.run(intent))) ?? {}
    } catch (e) {
      result = { outcome: 'error', line: failText(e), error: String(e?.message ?? e) }
    }
    if (turn !== s.turn) return note('stale', { stage: 'queue' })
    note('queue.intent', { kind: intent.kind, ...(intent.n !== undefined ? { n: intent.n } : {}), outcome: result.outcome, ...(result.line ? { line: result.line } : {}), ...(result.error ? { error: result.error } : {}), ms: now() - t })
    if (result.silence) silence()
    if (result.line) return end(String(result.line), turn)
    clearGuard(); reset()
  }

  /** T1/T7/T22: (re)start at the echo confirm with a new utterance; any frozen action is discarded. */
  function echo(text, heardAt = now()) {
    // Security: the echo must be what the decider receives, and everything echoed must be speakable (sanitize.js): an
    // utterance the speaker would alter or drop, or one too long to confirm by ear, is cancelled here.
    const said = speakableUtterance(text)
    if (!said.ok) {
      note('echo.rejected', { error: said.error })
      s.utterance = ''; s.action = null
      return void detach(end(said.error === 'too-long' ? LINES.tooLong : LINES.unspeakable))
    }
    s.utterance = said.text; s.action = null
    // Echo latency is measured from when the utterance was heard (the capture transcript time t0 for a capture).
    detach(sayThenListen('ECHO', echoLine(said.text), 'echo', heardAt))
  }

  /**
   * During EXECUTE: a barge-in opens the mic, so the result line waits until that listen ended (transcript, idle or
   * error); the latest capture is replayed after the result line (release).
   */
  function holdEvent(ev) {
    const hold = s.hold
    if (ev.type === 'listening') {
      hold.listening = true
      return note('barge-in.held', { from: s.state })
    }
    if (ev.type === 'transcript') {
      if (ev.revision !== 1) return
      hold.capture = ev
      note('capture.held', { text: ev.text })
    }
    hold.listening = false
    hold.wake?.()
  }

  /** Resolves at once when no barge-in mic is open; else when it closed, the flow was aborted, or the guard time passed. */
  function waitHeldListen(hold) {
    if (!hold.listening) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        if (hold.timer != null) { clearTimer(hold.timer); hold.timer = null }
        hold.wake = null
        resolve()
      }
      hold.wake = done
      // A listen end that never arrives must not swallow the result line (every outcome is spoken).
      hold.timer = setTimer(() => { hold.timer = null; note('hold.timeout', {}); hold.listening = false; done() }, windowS * 1000 + guardExtraMs)
    })
  }

  /** Drops the EXECUTE hold (abort/crash): its waiting result line is released and then discarded by its hold check. */
  function dropHold() {
    const hold = s.hold
    s.hold = null
    hold?.wake?.()
  }

  function answer(raw) {
    clearGuard()
    const text = String(raw ?? '').trim()
    const kind = classify(text, CLASSIFY_AS[s.step] ?? s.step)
    note('answer', { step: s.step, text, kind })
    if (s.step === REPLY_STEPS.dictate || s.step === REPLY_STEPS.confirm || s.step === REPLY_STEPS.ask) return void detach(replyStep.answer(s.step, kind, text))
    if (kind === 'stop') return void detach(end(LINES.cancelled))
    if (kind === 'empty') return void detach(end(LINES.noAnswer))
    // T7a: a bare "no" at a confirm step asks again at the same step; utterance/action stay as they are.
    if (kind === 'no' && s.step !== 'clarify') return void detach(sayThenListen(PREFIX[s.step], LINES.sayAgain, s.step))
    if (s.step === 'echo') return kind === 'yes' ? void detach(decideNow()) : echo(text)
    if (s.step === 'decision') return kind === 'yes' ? void detach(executeNow()) : echo(text)
    echo(text) // clarify: yes, no or text — the answer becomes the new utterance
  }

  function listenEnded(ev) {
    if (ev.type === 'error' || ev.reason === 'error') { clearGuard(); return void detach(end(LINES.sttFailed)) }
    // 'done' normally follows a transcript that already moved the turn on; keep the guard so the flow cannot hang.
    if (ev.reason === 'done') return
    clearGuard()
    detach(end(LINES.noAnswer)) // no_speech | too_short | cancelled
  }

  // ---- speaking & listening ----------------------------------------------------------------------------

  /**
   * One speak with one retry on failed/timeout (T25). Resolves the final status; never rejects.
   * from = the time playback latency is measured against (§6 speak.start): the utterance time for an echo line,
   * otherwise when the line was sent.
   */
  async function speakOnce(line, turn, from) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sent = now()
      note('speak.sent', { line, step: s.step, attempt })
      let r
      try { r = await speak(line, { ...VOICE }) } catch (e) { r = { status: 'failed', error: String(e?.message ?? e) } }
      const status = r?.status ?? 'failed'
      if (Number.isFinite(r?.startMs)) note('speak.start', { step: s.step, latMs: sent + r.startMs - (from ?? sent) })
      note('speak.end', { status, ms: r?.ms })
      // 'cancelled' (barge-in/abort silenced the line) is final: retrying it would speak into the open mic.
      // 'cut' (the user silenced the line, Ctrl+Alt+M) is final as well: playing it again would defeat the silencing.
      // 'muted' (tts-muted.flag was set when the worker took the line) is final and silent as well.
      if (status === 'done' || status === 'cancelled' || status === 'muted' || status === 'cut' || turn !== s.turn) return status
    }
    return 'failed'
  }

  /** The speaker is gone: go IDLE without trying to say anything else. */
  function dead(line) {
    note('speak-dead', { line, state: s.state })
    clearGuard(); reset()
  }

  /** A line that did not finish: 'cancelled' and 'muted' are deliberate silences (no speak-dead), anything else means the speaker is dead. */
  function lineFailed(status, line) {
    if (status !== 'cancelled' && status !== 'muted') return dead(line)
    note(status === 'muted' ? 'speak-muted' : 'speak-cancelled', { line, state: s.state })
    clearGuard(); reset()
  }

  async function sayThenListen(prefix, line, step, from) {
    const turn = enter(prefix + '_SPEAK'); s.step = step
    const status = await speakOnce(line, turn, from)
    if (turn !== s.turn) return // barge-in / abort while speaking: no listen
    // A cut echo or read-back was not fully heard: no mic and nothing executes. A cut clarify question only asks again.
    if (status === 'cut' && step !== 'clarify') { note('speak-cut', { line, step }); return end(LINES.cancelled) }
    if (status !== 'done' && status !== 'cut') return lineFailed(status, line)
    await openListen(prefix + '_LISTEN', step)
  }

  /** T4/T20: open the mic for the current step; T10 retry once after 500 ms; T11 rejection ends. */
  async function openListen(state, step) {
    const turn = enter(state); s.step = step
    const arg = { context: ctxFor(step), window_s: windowS }
    for (let attempt = 0; attempt < 2; attempt++) {
      let res
      s.listenAt = now() // listen.open reports the time from this POST to the STT 'listening' event (§6)
      try { res = await listen({ ...arg, context: { ...arg.context } }) } catch (e) {
        note('listen.post', { step, error: String(e?.message ?? e) })
        if (turn === s.turn) await end(LINES.sttDown)
        return
      }
      if (turn !== s.turn) return
      note('listen.post', { step, started: !!res?.started, attempt })
      if (res?.started) return armGuard(turn)
      if (attempt === 0) { await sleep(LISTEN_RETRY_MS); if (turn !== s.turn) return }
    }
    await end(LINES.micBusy)
  }

  // ---- answer guard (T8) -------------------------------------------------------------------------------

  function armGuard(turn) {
    clearGuard()
    s.guard = setTimer(() => {
      s.guard = null
      if (turn !== s.turn) return
      note('guard', { step: s.step })
      detach(end(LINES.noAnswer))
    }, windowS * 1000 + guardExtraMs)
  }

  function rearmGuard() { armGuard(s.turn) }

  function clearGuard() {
    if (s.guard == null) return
    clearTimer(s.guard); s.guard = null
  }

  // ---- decide & execute --------------------------------------------------------------------------------

  async function safeDecide(signal) {
    try { return (await decide(s.utterance, { history: [...s.history], signal })) ?? { ok: false, error: 'llm' } } catch (e) {
      return { ok: false, error: 'llm', message: String(e?.message ?? e) }
    }
  }

  function safeValidate(raw) {
    try { return validate(raw, { utterance: s.utterance }) ?? { ok: false, error: 'invalid' } } catch (e) {
      return { ok: false, error: 'invalid', message: String(e?.message ?? e) }
    }
  }

  /** The decider's raw action as text cut to 300 chars, so one odd reply cannot bloat the log. */
  function rawForLog(raw) {
    if (raw === undefined) return undefined
    let text
    try { text = typeof raw === 'string' ? raw : JSON.stringify(raw) } catch { text = String(raw) }
    return String(text).slice(0, LOG_RAW_MAX)
  }

  function invalidLine(v) {
    if (v.error === 'no-session') return LINES.noSession
    if (v.error === 'too-long') return LINES.tooLong
    if (v.error === 'not-approvable') return LINES.notApprovable
    if (v.error === 'no-approval') return v.title + ' has no pending permission request. Cancelled.'
    return LINES.badAnswer
  }

  /**
   * The bowl strike that tells the user the LLM is deciding. Best-effort and silent on any trouble: a chime that fails, is muted, cut,
   * has no player or throws is skipped, never retried (a second bowl is noise) and never ends the flow (unlike a spoken line).
   */
  async function playChime() {
    if (!chime) return 'none'
    note('chime.sent')
    let status
    try { status = (await chime())?.status ?? 'failed' } catch (e) {
      note('chime.error', { message: String(e?.message ?? e) })
      return 'failed'
    }
    note('chime.end', { status })
    return status
  }

  /** T5 → T12..T19. The bowl chime and decide() run in parallel; the next line waits for both (a failed chime counts as done). */
  async function decideNow() {
    const turn = enter('DECIDE')
    note('decide.start', { utterance: s.utterance })
    const t = now()
    // A barge-in or abort during the decision aborts the model call too (abortTurn), instead of letting it run to its timeout.
    const ac = new AbortController()
    s.decideAc = ac
    let d
    try {
      ;[d] = await Promise.all([safeDecide(ac.signal), playChime()])
    } finally {
      if (s.decideAc === ac) s.decideAc = null // also when a step rejects: a stale controller must not outlive its decision
    }
    if (turn !== s.turn) return note('stale', { stage: 'decide' })
    note('decide.end', { ms: now() - t, model: d.model, ok: d.ok, error: d.error, raw: rawForLog(d.raw) })
    if (!d.ok) return end(LLM_ERRORS[d.error] ?? LLM_ERRORS.llm)
    const v = safeValidate(d.raw)
    note('validate', { ok: v.ok, error: v.error, action: loggable(v.action) })
    if (!v.ok) return end(invalidLine(v))
    if (v.action.action === 'clarify') return clarify(v.action.question)
    s.action = Object.freeze(v.action)
    await sayThenListen('READBACK', 'I will ' + readBack(s.action) + '. Shall I do it?', 'decision')
  }

  async function clarify(question) {
    if (s.clarifies >= maxClarify) return end(LINES.noIdea)
    s.clarifies++
    s.history = [...s.history, { utterance: s.utterance, question }]
    await sayThenListen('CLARIFY', question, 'clarify')
  }

  /** T21 → T23/T24: execute exactly the frozen action that was read back. */
  async function executeNow() {
    const turn = enter('EXECUTE'), action = s.action, t = now()
    const hold = beginHold()
    note('execute.start', { action: loggable(action) })
    let line
    try {
      const result = await executeWithTimeout(action)
      note('execute.end', { ms: now() - t, ok: true })
      line = resultText(action, result)
    } catch (e) {
      note('execute.end', { ms: now() - t, ok: false, error: String(e?.message ?? e) })
      line = failText(e)
    }
    await settleHeld(turn, hold, line)
  }

  /** Starts the EXECUTE hold: a barge-in or capture meanwhile is held, the action's outcome is always said. */
  function beginHold() {
    s.hold = { capture: null, listening: false, wake: null, timer: null }
    return s.hold
  }

  /** Says the action's outcome (none: silence) once no barge-in mic is open, then replays a held capture. */
  async function settleHeld(turn, hold, line) {
    try {
      await waitHeldListen(hold) // never speak into a barge-in mic that is still open
      if (s.hold !== hold) return // abort() cleared the hold: nothing is said
      if (line) await end(line, turn)
      else { clearGuard(); reset() }
    } finally { release(hold) }
  }

  /** fn(), failing with 'timed out' when it has not settled after executeTimeoutMs (the timer never outlives the call). */
  async function withTimeout(fn) {
    let timer
    const timedOut = new Promise((_, reject) => { timer = setTimer(() => reject(new Error('timed out')), executeTimeoutMs) })
    try { return await Promise.race([(async () => fn())(), timedOut]) } finally { clearTimer(timer) }
  }

  const executeWithTimeout = (action) => withTimeout(() => execute(action))

  /** The result line is done: replay a capture held during EXECUTE. Dropped when abort() cleared the hold. */
  function release(hold) {
    if (s.hold !== hold) return
    s.hold = null
    if (hold.capture) capture(hold.capture)
  }

  // ---- ending & state helpers --------------------------------------------------------------------------

  /** Speak a final line (END_SPEAK, still active), then IDLE. Skipped when the turn moved on meanwhile. */
  async function end(line, turn = s.turn) {
    if (turn !== s.turn) return
    clearGuard()
    const t = enter('END_SPEAK')
    note('end', { line })
    const status = await speakOnce(line, t)
    if (t !== s.turn) return
    if (status !== 'done' && status !== 'cut') return lineFailed(status, line)
    reset()
  }

  function bargeIn() {
    note('barge-in', { from: s.state })
    abortTurn('barge-in') // the capture transcript that follows restarts at echo (T3 → T1)
  }

  function abortTurn(why) {
    clearGuard()
    s.decideAc?.abort(); s.decideAc = null
    if (s.state !== 'IDLE') { note('abort', { why, state: s.state }); silence() }
    s.turn++; s.state = 'IDLE'; s.reply = null
  }

  /** Cuts the line in flight and drops the queued ones; the speaker implementation decides how (best-effort). */
  function silence() {
    try { cancelSpeech?.() } catch (e) { note('cancel-speech.error', { message: String(e?.message ?? e) }) }
  }

  function enter(state) {
    s.turn++; s.state = state
    return s.turn
  }

  function reset() {
    s.state = 'IDLE'; s.id = null; s.step = null; s.action = null; s.utterance = ''; s.history = []; s.clarifies = 0; s.reply = null
    try { onIdle() } catch { /* a listener must never break the flow */ }
  }

  return {
    handle,
    active: () => s.state !== 'IDLE',
    abort: (why = 'abort') => { dropHold(); abortTurn(why); reset() },
    snapshot: () => ({ state: s.state, id: s.id, turn: s.turn, step: s.step, utterance: s.utterance, clarifies: s.clarifies, action: s.action }),
  }
}
