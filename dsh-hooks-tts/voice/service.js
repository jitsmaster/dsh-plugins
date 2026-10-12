import { buildEventsUrl, createVoiceClient } from './client.js'
import { createDispatcher } from './dispatcher.js'
import { createVoiceApprovals } from './approvals.js'

/**
 * Glue: owns the STT client, the dispatcher and the approvals race, and reconciles them with the voiceControl
 * setting. Every DSH dependency is injected so the plugin entry point stays thin and this stays testable.
 */
export function createVoiceService({
  enabled,
  readSecret,
  port = 8890,
  WebSocketImpl,
  setTimer,
  clearTimer,
  titleOf,
  controller,
  runSlash,
  switchTo,
  speak = () => {},
  trace = () => {},
  minConfidence = 0.3,
  fetchImpl = globalThis.fetch,
  ensureStt,
  router,
  confirm,
  record = () => {},
}) {
  let secret
  const agents = new Set()
  let lastAlerted
  let lastActive
  let client
  let error
  let lastTranscript
  let sttState
  const approvals = createVoiceApprovals({ enabled })

  const dispatcher = createDispatcher({
    sessions: () => [...agents].map((id) => ({ id, title: titleOf(id) ?? id })),
    lastAlerted: () => lastAlerted ?? lastActive,
    session: controller,
    approvals: { answer: async (a) => approvals.answer(a), peek: (a) => approvals.peek(a) },
    slash: runSlash,
    ui: { switchTo },
    speak,
    minConfidence,
    router,
    ...(confirm === undefined ? {} : { confirm }),
  })

  const onEvent = (event) => {
    if (event.type === 'transcript' && String(event.text ?? '').trim()) lastTranscript = event
    dispatcher.handle(event).then(
      (r) => {
        if (r.kind !== 'ignored') trace(`voice ${event.type}: ${r.kind}${r.id ? ' ' + r.id : ''}`)
        if (event.type !== 'transcript') return
        try { record({ type: 'transcript', text: event.text, confidence: event.confidence, kind: r.kind, id: r.id, error: r.error, ...(r.text !== undefined ? { sent: r.text } : {}) }) } catch { /* logging must not break voice */ }
      },
      (e) => {
        trace('voice dispatch error: ' + (e?.message ?? e))
        try { record({ type: 'transcript', text: event.text, confidence: event.confidence, kind: 'error', error: String(e?.message ?? e) }) } catch { /* ignore */ }
      },
    )
  }

  return {
    reconcile() {
      if (enabled() && ensureStt && client?.state !== 'connected') {
        Promise.resolve().then(ensureStt).then((r) => { sttState = r }, (e) => { sttState = 'failed: ' + (e?.message ?? e) })
      }
      if (enabled() && !client) {
        let token
        try {
          token = readSecret()
          secret = token
          error = undefined
        } catch (e) {
          error = String(e?.message ?? e)
          return
        }
        client = createVoiceClient({
          url: buildEventsUrl({ port, token }),
          WebSocketImpl,
          setTimer,
          clearTimer,
          onEvent,
        })
        client.start()
      } else if (!enabled() && client) {
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
    }),
    async control(action) {
      if (!['listen', 'finish', 'cancel'].includes(action)) throw new Error('unknown voice action ' + action)
      if (!client) throw new Error('voice control is not running')
      const res = await fetchImpl(`http://127.0.0.1:${port}/${action}`, { method: 'POST', headers: { Authorization: 'Bearer ' + secret } })
      if (!res.ok) throw new Error(`STT service answered HTTP ${res.status}`)
    },
    busy: () => client?.busy ?? false,
    intercept: (req, next) => approvals.intercept(req, next),
    agentCreated: (id) => { agents.add(id) },
    agentDisposed: (id) => {
      agents.delete(id)
      if (lastAlerted === id) lastAlerted = undefined
      if (lastActive === id) lastActive = undefined
      dispatcher.clear(id)
    },
    noteAlert: (id) => { lastAlerted = id },
    // A session doing work is a valid target even if it was created before the plugin loaded.
    noteActive: (id) => { agents.add(id); lastActive = id },
    stop() {
      dispatcher.clear()
      client?.stop()
      client = undefined
    },
  }
}
