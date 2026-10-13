import { randomUUID } from 'node:crypto'
import { buildEventsUrl, createVoiceClient } from './client.js'
import { createVoiceApprovals } from './approvals.js'
import { createVoiceFlow } from './flow.js'
import { createExecutor, readBack, resultText, validateAction } from './actions.js'
import { classifyAnswer } from './answers.js'
import { permissionHeadline } from './headline.js'

const VOICE = Object.freeze({ priority: 'High', gender: 'female' })
const CLOSED_LINE = 'That session closed. Cancelled.'

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
  let handles = [] // session handles as the decider last saw them: [{ handle, id }]
  const approvals = createVoiceApprovals({ enabled })

  const safe = (fn) => { try { return fn() } catch (e) { trace('voice: ' + String(e?.message ?? e)) } }
  const target = () => ({ selected, lastAlerted, lastActive })

  /** A pending permission request in words, e.g. "permission: run command". */
  function pendingOf(id) {
    const p = approvals.peek({ sessionId: id })
    return p ? 'permission: ' + permissionHeadline({ toolName: p.toolName }).replace(/^Approve /, '').replace(/\?$/, '') : null
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
      sessions: list.map((s) => ({ handle: s.handle, title: s.title || 'session ' + s.handle.slice(1), selected: s.id === selected, lastAlerted: s.id === lastAlerted, pending: pendingOf(s.id) })),
      slash,
      target: target(),
    }
  }

  /** Validates against the handles the decider saw (only sessions still alive). */
  function validate(raw) {
    const live = sessions()
    const list = handles.length
      ? handles.filter((h) => agents.has(h.id)).map((h) => ({ ...h, title: titleOf(h.id) }))
      : live
    return validateAction(raw, {
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

  async function listen({ context: ctx, window_s }) {
    if (!client) throw new Error('voice control is not running')
    const res = await fetchImpl(`http://127.0.0.1:${port}/listen`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: ctx, window_s }),
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
      uuid: () => randomUUID().slice(0, 8),
    }),
    classify: classifyAnswer,
    log,
    setTimer,
    clearTimer,
    uuid: () => randomUUID().slice(0, 8),
  })

  const onEvent = (event) => {
    if (event.type === 'transcript' && String(event.text ?? '').trim()) lastTranscript = event
    try { flow.handle(event) } catch (e) { trace('voice flow error: ' + String(e?.message ?? e)) }
  }

  function startClient() {
    try {
      secret = readSecret()
      error = undefined
    } catch (e) {
      error = String(e?.message ?? e)
      return
    }
    client = createVoiceClient({ url: buildEventsUrl({ port, token: secret }), WebSocketImpl, setTimer, clearTimer, onEvent })
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
      if (on && ensureStt && client?.state !== 'connected') {
        Promise.resolve().then(ensureStt).then((r) => { sttState = r }, (e) => { sttState = 'failed: ' + (e?.message ?? e) })
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
    async control(action) {
      if (!['listen', 'finish', 'cancel'].includes(action)) throw new Error('unknown voice action ' + action)
      if (!client) throw new Error('voice control is not running')
      const res = await fetchImpl(`http://127.0.0.1:${port}/${action}`, { method: 'POST', headers: { Authorization: 'Bearer ' + secret } })
      if (!res.ok) throw new Error(`STT service answered HTTP ${res.status}`)
    },
    listen,
    context,
    // Read-outs stay quiet for the whole conversation, not just while the mic is open.
    busy: () => (client?.busy ?? false) || flow.active(),
    intercept: (req, next) => approvals.intercept(req, next),
    agentCreated: (id) => { agents.add(id) },
    agentDisposed: (id) => {
      agents.delete(id)
      if (lastAlerted === id) lastAlerted = undefined
      if (lastActive === id) lastActive = undefined
      if (selected === id) selected = undefined
      if (flow.snapshot()?.action?.sessionId !== id) return
      flow.abort('session closed')
      Promise.resolve().then(() => speaker.speak(CLOSED_LINE, { ...VOICE })).catch(() => {})
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
