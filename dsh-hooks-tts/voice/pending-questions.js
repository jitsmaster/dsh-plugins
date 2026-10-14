/**
 * Which ask_user_question calls are waiting for an answer right now. tools/pre-execute only DECIDES whether the call may run (the
 * tool itself runs after it), so a call is noted there, before its alert hooks run (an alert held back can then record that the
 * question was pending), and released when the tool's result arrives (tools/post-execute: answered by voice or in the GUI, timed
 * out, failed). A held "Question" alert is stale once its call is no longer in here.
 * A call that never reaches post-execute (denied by a guard, cancelled, its session closed) must not stay pending forever: it is also
 * released when its signal aborts, when its session is dropped, and after maxAgeMs.
 */
import { isAskTool } from './alerts.js'

export function createPendingQuestions({ now = Date.now, maxAgeMs = 30 * 60_000 } = {}) {
  const waiting = new Set() // { sessionId, callId, at, detach }

  const remove = (entry) => { if (waiting.delete(entry)) entry.detach?.() }
  const prune = () => { const t = now(); for (const e of waiting) if (t - e.at > maxAgeMs) remove(e) }

  return {
    /** Notes the call as pending (an unknown tool name is ignored). Returns the function that releases it. */
    note({ sessionId, callId, name, signal }) {
      if (!isAskTool(name)) return () => {}
      prune()
      const entry = { sessionId, callId, at: now(), detach: undefined }
      if (signal?.aborted) return () => {}
      if (signal) {
        const onAbort = () => remove(entry)
        signal.addEventListener('abort', onAbort, { once: true })
        entry.detach = () => signal.removeEventListener('abort', onAbort)
      }
      waiting.add(entry)
      return () => remove(entry)
    },
    /** The tool settled (post-execute): every pending entry of that session and call goes. */
    release({ sessionId, callId }) {
      for (const e of [...waiting]) if (e.sessionId === sessionId && e.callId === callId) remove(e)
    },
    /** The session is gone: its questions can never be answered. */
    dropSession(sessionId) {
      for (const e of [...waiting]) if (e.sessionId === sessionId) remove(e)
    },
    list() {
      prune()
      return [...waiting].map(({ sessionId, callId }) => ({ sessionId, callId }))
    },
  }
}
