/**
 * Two-stage voice conversation flow (docs/voice-two-stage-flow.md §1, §2, §5).
 * Every outcome is spoken; nothing executes without two yeses (echo confirm + read-back confirm).
 * All collaborators are injected so the state machine is deterministic under fake timers.
 *
 * Turn discipline: every state entry bumps s.turn. Every await re-checks its captured turn afterwards, so a
 * barge-in, abort or re-capture silently drops pending speak/listen/decide/execute continuations. Listens carry
 * {flow:'voice', id, turn, step}; only an exact match with the current listen is consumed, anything else is stale.
 */

const VOICE = Object.freeze({ priority: 'High', gender: 'female' })
const LISTEN_RETRY_MS = 500

const LINES = Object.freeze({
  notCaught: 'I did not catch that.',
  deciding: 'Deciding with LLM.',
  sayAgain: 'Please say it again.',
  cancelled: 'Cancelled.',
  noAnswer: 'No answer. Cancelled.',
  sttFailed: 'Speech recognition failed. Cancelled.',
  micBusy: 'The microphone is busy. Cancelled.',
  sttDown: 'Speech service unavailable. Cancelled.',
  noIdea: 'I could not work out what to do. Cancelled.',
  noSession: 'No session is known. Cancelled.',
  badAnswer: "I could not understand the LLM's answer. Cancelled.",
})

/** decide() error kind → final line (T15–T17). Unknown kinds count as "LLM not available". */
const LLM_ERRORS = Object.freeze({
  timeout: 'The LLM did not answer in time. Cancelled.',
  llm: 'The LLM is not available. Cancelled.',
  unparseable: LINES.badAnswer,
})

/** Listen step → state-name prefix of its *_SPEAK / *_LISTEN pair. */
const PREFIX = Object.freeze({ echo: 'ECHO', decision: 'READBACK', clarify: 'CLARIFY' })

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
  uuid, windowS = 10, guardExtraMs = 15000, maxClarify = 2,
}) {
  const s = { state: 'IDLE', id: null, turn: 0, step: null, utterance: '', history: [], action: null, clarifies: 0, t0: 0, guard: null }

  const ctxFor = (step) => ({ flow: 'voice', id: s.id, turn: s.turn, step })
  const mine = (c) => !!c && c.flow === 'voice' && c.id === s.id && c.turn === s.turn && c.step === s.step

  /** log() must never break the flow; every entry carries the conversation id/turn and ms since capture. */
  function note(stage, data = {}) {
    try { log(stage, { id: s.id, turn: s.turn, dt: now() - s.t0, ...data }) } catch { /* logging is best-effort */ }
  }

  /** Runs a detached async step; an unexpected throw (e.g. a dep bug) ends the conversation instead of crashing. */
  function detach(promise) {
    promise.catch((e) => { note('error', { message: String(e?.message ?? e) }); clearGuard(); reset() })
  }

  const sleep = (ms) => new Promise((resolve) => setTimer(resolve, ms))

  // ---- event entry point -------------------------------------------------------------------------------

  function handle(ev) {
    if (!ev || typeof ev !== 'object') return
    const c = ev.context
    if (c && c.flow === 'voice' && !mine(c)) return note('stale', { ev: ev.type, c })
    if (ev.type === 'listening') return c == null ? (s.state !== 'IDLE' ? bargeIn() : undefined) : note('listen.open')
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
    s.id = uuid(); s.history = []; s.clarifies = 0; s.action = null; s.t0 = now()
    note('capture.transcript', { text: ev.text, sttSeconds: ev.seconds, source: ev.source })
    const text = String(ev.text ?? '').trim()
    if (!text) return void detach(end(LINES.notCaught))
    echo(text, s.t0)
  }

  /** T1/T7/T22: (re)start at the echo confirm with a new utterance; any frozen action is discarded. */
  function echo(text, heardAt = now()) {
    s.utterance = text; s.action = null
    // Echo latency is measured from when the utterance was heard (the capture transcript time t0 for a capture).
    detach(sayThenListen('ECHO', echoLine(text), 'echo', heardAt))
  }

  function answer(raw) {
    clearGuard()
    const text = String(raw ?? '').trim()
    const kind = classify(text)
    note('answer', { step: s.step, text, kind })
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
      if (status === 'done' || turn !== s.turn) return status
    }
    return 'failed'
  }

  /** The speaker is gone: go IDLE without trying to say anything else. */
  function dead(line) {
    note('speak-dead', { line, state: s.state })
    clearGuard(); reset()
  }

  async function sayThenListen(prefix, line, step, from) {
    const turn = enter(prefix + '_SPEAK'); s.step = step
    const status = await speakOnce(line, turn, from)
    if (turn !== s.turn) return // barge-in / abort while speaking: no listen
    if (status !== 'done') return dead(line)
    await openListen(prefix + '_LISTEN', step)
  }

  /** T4/T20: open the mic for the current step; T10 retry once after 500 ms; T11 rejection ends. */
  async function openListen(state, step) {
    const turn = enter(state); s.step = step
    const arg = { context: ctxFor(step), window_s: windowS }
    for (let attempt = 0; attempt < 2; attempt++) {
      let res
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

  async function safeDecide() {
    try { return (await decide(s.utterance, { history: [...s.history] })) ?? { ok: false, error: 'llm' } } catch (e) {
      return { ok: false, error: 'llm', message: String(e?.message ?? e) }
    }
  }

  function safeValidate(raw) {
    try { return validate(raw) ?? { ok: false, error: 'invalid' } } catch (e) {
      return { ok: false, error: 'invalid', message: String(e?.message ?? e) }
    }
  }

  function invalidLine(v) {
    if (v.error === 'no-session') return LINES.noSession
    if (v.error === 'no-approval') return v.title + ' has no pending permission request. Cancelled.'
    return LINES.badAnswer
  }

  /** T5 → T12..T19. The "Deciding" line and decide() run in parallel; the next line waits for both. */
  async function decideNow() {
    const turn = enter('DECIDE')
    note('decide.start', { utterance: s.utterance })
    const t = now()
    const [d, said] = await Promise.all([safeDecide(), speakOnce(LINES.deciding, turn)])
    if (turn !== s.turn) return note('stale', { stage: 'decide' })
    note('decide.end', { ms: now() - t, ok: d.ok, error: d.error, raw: d.raw })
    if (said !== 'done') return dead(LINES.deciding)
    if (!d.ok) return end(LLM_ERRORS[d.error] ?? LLM_ERRORS.llm)
    const v = safeValidate(d.raw)
    note('validate', { ok: v.ok, error: v.error, action: v.action })
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
    note('execute.start', { action })
    let line
    try {
      const result = await execute(action)
      note('execute.end', { ms: now() - t, ok: true })
      line = resultText(action, result)
    } catch (e) {
      note('execute.end', { ms: now() - t, ok: false, error: String(e?.message ?? e) })
      line = failText(e)
    }
    await end(line, turn)
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
    if (status !== 'done') return dead(line)
    reset()
  }

  function bargeIn() {
    note('barge-in', { from: s.state })
    abortTurn('barge-in') // the capture transcript that follows restarts at echo (T3 → T1)
  }

  function abortTurn(why) {
    clearGuard()
    if (s.state !== 'IDLE') note('abort', { why, state: s.state })
    s.turn++; s.state = 'IDLE'
  }

  function enter(state) {
    s.turn++; s.state = state
    return s.turn
  }

  function reset() {
    s.state = 'IDLE'; s.id = null; s.step = null; s.action = null; s.utterance = ''; s.history = []; s.clarifies = 0
  }

  return {
    handle,
    active: () => s.state !== 'IDLE',
    abort: (why = 'abort') => { abortTurn(why); reset() },
    snapshot: () => ({ state: s.state, id: s.id, turn: s.turn, step: s.step, utterance: s.utterance, clarifies: s.clarifies, action: s.action }),
  }
}
