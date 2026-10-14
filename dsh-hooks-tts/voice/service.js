import { randomUUID } from 'node:crypto'
import { buildEventsUrl, createVoiceClient } from './client.js'
import { createVoiceApprovals } from './approvals.js'
import { createVoiceFlow } from './flow.js'
import { createExecutor, readBack, resultText, toolPhrase, validateAction } from './actions.js'
import { classifyAnswer } from './answers.js'
import { VOICE } from './speaker.js'
import { cleanTitle } from './sanitize.js'

const CLOSED_LINE = 'That session closed. Cancelled.'
/** How long a POST to the STT daemon may take before it counts as unavailable (it normally answers within ms). */
const STT_REQUEST_TIMEOUT_MS = 5000
/** Minimum time between two ensureStt calls (the launcher's own start throttle is separate). */
const STT_RETRY_MS = 30_000
/** After a result other than 'running' (down, starting, failed) the next probe comes sooner. */
const STT_RETRY_DOWN_MS = 10_000

/** Short random id for voice requests and conversations. */
const uuid8 = () => randomUUID().slice(0, 8)

/**
 * Glue for voice control (docs/voice-two-stage-flow.md §2): owns the STT client, the two-stage conversation flow,
 * the approvals race and the voice target ('selected'), and reconciles them with the voiceControl setting.
 * Every DSH dependency is injected so the plugin entry point stays thin and this stays testable.
 */
export function createVoiceService({
  enabled,
  readSecret,
  port = 8890,
  WebSocketImpl,
  setTimer,
  clearTimer,
  titleOf = () => undefined,
  controller,
  runSlash,
  speaker,
  decide = async () => ({ ok: false, error: 'llm' }),
  cwdOf = () => undefined,
  slashOf = () => [],
  createFlow = createVoiceFlow,
  trace = () => {},
  fetchImpl = globalThis.fetch,
  ensureStt,
  record = () => {},
  requestTimeoutMs = STT_REQUEST_TIMEOUT_MS,
  summaryOf,
  now = Date.now,
  onIdle, // called when voice may just have stopped being busy (mic closed, flow ended): see notifyIdle
}) {
  let secret
  const agents = new Set()
  let lastAlerted
  let lastActive
  let selected
  let client
  let error
  let lastTranscript
  let sttState
  let sttBusy = false // an ensureStt call is in flight
  let sttNextAt = 0 // earliest time of the next ensureStt call
  let handles = [] // session handles as the decider last saw them: [{ handle, id }]
  const approvals = createVoiceApprovals({ enabled, summaryOf })

  /** busy() is false now: tell the owner (it replays the alerts held while voice was busy). A listener's failure never reaches the flow or the client. */
  const notifyIdle = () => { if (onIdle && !busy()) safe(() => onIdle()) }
  const busy = () => (client?.busy ?? false) || flow.active()

  const safe = (fn) => { try { return fn() } catch (e) { trace('voice: ' + String(e?.message ?? e)) } }
  const target = () => ({ selected, lastAlerted, lastActive })

  /** A pending permission request in words, e.g. "permission: run command npm test" (the summary is untrusted data for the decider). */
  function pendingOf(id) {
    const p = approvals.peek({ sessionId: id })
    return p ? 'permission: ' + toolPhrase(p.toolName) + (p.summary ? ' ' + p.summary : '') : null
  }

  /** Live sessions with stable handles s1..sN (the LLM only ever sees handles). */
  function sessions() {
    return [...agents].map((id, i) => ({ handle: 's' + (i + 1), id, title: titleOf(id) }))
  }

  /** Decider context: sessions (with selected/lastAlerted/pending), the default target's slash list, the target. */
  function context() {
    const list = sessions()
    handles = list.map(({ handle, id }) => ({ handle, id }))
    const def = selected ?? lastAlerted ?? lastActive
    let slash = []
    if (def !== undefined) slash = safe(() => slashOf(def)) ?? []
    return {
      sessions: list.map((s) => ({ handle: s.handle, title: cleanTitle(s.title) || 'session ' + s.handle.slice(1), selected: s.id === selected, lastAlerted: s.id === lastAlerted, pending: pendingOf(s.id) })),
      slash,
      target: target(),
    }
  }

  /** Validates against the handles the decider saw (only sessions still alive). */
  function validate(raw, { utterance } = {}) {
    const live = sessions()
    const list = handles.length
      ? handles.filter((h) => agents.has(h.id)).map((h) => ({ ...h, title: titleOf(h.id) }))
      : live
    return validateAction(raw, {
      utterance,
      sessions: list,
      target: target(),
      peek: (a) => approvals.peek(a),
      slashNames: (id) => (safe(() => slashOf(id)) ?? []).map((c) => String(c?.name ?? c)),
    })
  }

  function log(stage, data) {
    try {
      // A data key named 'stage' (e.g. stale {stage:'decide'}) is kept as 'sub' so it cannot hide the flow stage.
      const { stage: sub, ...rest } = data ?? {}
      record({ ...rest, ...(sub !== undefined ? { sub } : {}), type: 'flow', stage })
    } catch { /* logging must not break voice */ }
  }

  // Reliability: a daemon that accepts the connection but never answers would leave the flow in *_LISTEN with no guard
  // armed (the guard starts only once started:true came back), so every hook read-out would stay suppressed. The
  // timeout makes fetch reject, which the flow reports as "Speech service unavailable. Cancelled." (T11).
  const requestSignal = () => AbortSignal.timeout(requestTimeoutMs)

  async function listen({ context: ctx, window_s }) {
    if (!client) throw new Error('voice control is not running')
    const res = await fetchImpl(`http://127.0.0.1:${port}/listen`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: ctx, window_s }),
      signal: requestSignal(),
    })
    if (!res.ok) throw new Error(`STT service answered HTTP ${res.status}`)
    let body
    try { body = await res.json() } catch { body = undefined }
    return { started: body?.started === true }
  }

  const flow = createFlow({
    speak: (text, opts) => speaker.speak(text, opts),
    listen,
    decide,
    validate,
    readBack,
    resultText,
    execute: createExecutor({
      controller,
      runSlash,
      approvals: { peek: (a) => approvals.peek(a), answer: async (a) => approvals.answer(a) },
      select: (id) => { selected = id },
      cwdOf,
      uuid: uuid8,
    }),
    classify: classifyAnswer,
    // Barge-in / abort: silence the speak worker (queued lines dropped, the line in flight cut).
    cancelSpeech: () => safe(() => speaker?.cancel?.()),
    log,
    setTimer,
    clearTimer,
    uuid: uuid8,
    onIdle: notifyIdle,
  })

  const onEvent = (event) => {
    if (event.type === 'transcript' && String(event.text ?? '').trim()) lastTranscript = event
    try { flow.handle(event) } catch (e) { trace('voice flow error: ' + String(e?.message ?? e)) }
  }

  /** POSTs a GUI/STT control action (listen | finish | cancel) without a body. */
  async function control(action) {
    if (!['listen', 'finish', 'cancel'].includes(action)) throw new Error('unknown voice action ' + action)
    if (!client) throw new Error('voice control is not running')
    const res = await fetchImpl(`http://127.0.0.1:${port}/${action}`, { method: 'POST', headers: { Authorization: 'Bearer ' + secret }, signal: requestSignal() })
    if (!res.ok) throw new Error(`STT service answered HTTP ${res.status}`)
  }

  /**
   * The flow's frozen action targets a session that just closed: abort the flow and say so. While the flow waits on an
   * answer (*_LISTEN) the STT mic window is still open, so it is cancelled first; otherwise the line would be spoken
   * into it. A 'new' action only uses its session as the cwd source and stays valid (cwdOf falls back), so it is kept.
   * Only READBACK_* counts: from EXECUTE on the action already ran, and its own result line says how it went.
   */
  function abortForClosedSession(id) {
    const snap = flow.snapshot()
    if (!String(snap?.state ?? '').startsWith('READBACK_')) return
    const action = snap?.action
    if (action?.sessionId !== id || action.action === 'new') return
    const listening = String(snap.state ?? '').endsWith('_LISTEN')
    flow.abort('session closed')
    Promise.resolve()
      .then(() => (listening ? control('cancel') : undefined))
      .catch((e) => trace('voice: cancel listen failed: ' + String(e?.message ?? e)))
      .then(() => speaker.speak(CLOSED_LINE, { ...VOICE }))
      .catch(() => {})
  }

  function startClient() {
    try {
      secret = readSecret()
      error = undefined
    } catch (e) {
      error = String(e?.message ?? e)
      return
    }
    client = createVoiceClient({ url: buildEventsUrl({ port, token: secret }), WebSocketImpl, setTimer, clearTimer, onEvent, onBusy: (b) => { if (!b) notifyIdle() } })
    client.start()
  }

  return {
    reconcile() {
      const on = enabled()
      if (on) safe(() => speaker?.warm()) // prewarm the speak worker (no audio)
      else {
        if (flow.active()) flow.abort('disabled')
        safe(() => speaker?.stop())
      }
      // Throttled: reconcile runs every 5 s, and a TCP probe of a daemon that is down (or still starting) that often is waste.
      if (!on) sttNextAt = 0
      else if (ensureStt && client?.state !== 'connected' && !sttBusy && now() >= sttNextAt) {
        sttBusy = true
        Promise.resolve().then(ensureStt).then((r) => { sttState = r }, (e) => { sttState = 'failed: ' + (e?.message ?? e) })
          .finally(() => { sttBusy = false; sttNextAt = now() + (sttState === 'running' ? STT_RETRY_MS : STT_RETRY_DOWN_MS) })
      }
      if (on && !client) startClient()
      else if (!on && client) {
        client.stop()
        client = undefined
      }
    },
    status: () => ({
      running: Boolean(client),
      connection: client?.state ?? 'disconnected',
      busy: client?.busy ?? false,
      error,
      stt: sttState,
      lastTranscript,
      pendingApprovals: approvals.pending(),
      flow: flow.snapshot(),
      selected,
    }),
    control,
    listen,
    context,
    // Read-outs stay quiet for the whole conversation, not just while the mic is open.
    busy,
    intercept: (req, next) => approvals.intercept(req, next),
    agentCreated: (id) => { agents.add(id) },
    agentDisposed: (id) => {
      agents.delete(id)
      if (lastAlerted === id) lastAlerted = undefined
      if (lastActive === id) lastActive = undefined
      if (selected === id) selected = undefined
      abortForClosedSession(id)
    },
    noteAlert: (id) => { lastAlerted = id },
    // A session doing work is a valid target even if it was created before the plugin loaded.
    noteActive: (id) => { agents.add(id); lastActive = id },
    stop() {
      flow.abort('stop')
      client?.stop()
      client = undefined
      safe(() => speaker?.stop())
    },
  }
}
