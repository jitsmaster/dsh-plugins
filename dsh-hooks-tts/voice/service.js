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
}) {
  const agents = new Set()
  let lastAlerted
  let client
  let error
  let lastTranscript
  const approvals = createVoiceApprovals({ enabled })

  const dispatcher = createDispatcher({
    sessions: () => [...agents].map((id) => ({ id, title: titleOf(id) ?? id })),
    lastAlerted: () => lastAlerted,
    session: controller,
    approvals: { answer: async (a) => approvals.answer(a) },
    slash: runSlash,
    ui: { switchTo },
    speak,
    minConfidence,
  })

  const onEvent = (event) => {
    if (event.type === 'transcript' && String(event.text ?? '').trim()) lastTranscript = event
    dispatcher.handle(event).then(
      (r) => { if (r.kind !== 'ignored') trace(`voice ${event.type}: ${r.kind}${r.id ? ' ' + r.id : ''}`) },
      (e) => trace('voice dispatch error: ' + (e?.message ?? e)),
    )
  }

  return {
    reconcile() {
      if (enabled() && !client) {
        let token
        try {
          token = readSecret()
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
      lastTranscript,
      pendingApprovals: approvals.pending(),
    }),
    busy: () => client?.busy ?? false,
    intercept: (req, next) => approvals.intercept(req, next),
    agentCreated: (id) => { agents.add(id) },
    agentDisposed: (id) => {
      agents.delete(id)
      if (lastAlerted === id) lastAlerted = undefined
    },
    noteAlert: (id) => { lastAlerted = id },
    stop() {
      client?.stop()
      client = undefined
    },
  }
}
