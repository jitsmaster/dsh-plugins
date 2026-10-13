/**
 * The `reviewQueue` service: the one API the sidebar, the overlay and (later) voice all use. It owns no state of its
 * own except the focused item; items live in the store and pending requests in capture.
 */
import { randomUUID } from 'node:crypto'
import { spokenFor } from './speech.js'

const MAX_REPLY = 4000

export function createReviewQueue({ store, capture, controllerOf, now = Date.now, uuid = () => randomUUID().slice(0, 8) }) {
  let focusId
  const listeners = new Set()
  const emit = () => { for (const l of [...listeners]) { try { l() } catch { /* ignore */ } } }

  // The store tells us about every change; a focused item that left the queue drops its focus.
  store.onChange(() => {
    if (focusId !== undefined && store.get(focusId)?.status !== 'open') focusId = undefined
    emit()
  })

  const openItem = (id) => {
    const item = store.get(id)
    return item?.status === 'open' ? item : undefined
  }

  return {
    snapshot() {
      const snap = store.snapshot()
      return {
        ...snap,
        serverNow: now(),
        focusId,
        open: snap.open.map((item) => ({ ...item, spoken: spokenFor(item, item.position) })),
      }
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    answer: (id, answers) => capture.answerQuestion(id, answers),
    lateAnswer: (id, answers) => capture.lateAnswerQuestion(id, answers),
    approve: (id) => capture.decidePermission(id, 'approve'),
    deny: (id) => capture.decidePermission(id, 'deny'),
    markReviewed(id) {
      const item = openItem(id)
      if (!item) return { ok: false, error: 'not-open' }
      if (item.type !== 'completed') return { ok: false, error: 'not-completed' }
      return store.resolve(id, { kind: 'reviewed', by: 'card' }) ? { ok: true } : { ok: false, error: 'not-open' }
    },
    async reply(id, text) {
      const item = openItem(id)
      if (!item) return { ok: false, error: 'not-open' }
      if (item.type !== 'completed') return { ok: false, error: 'not-completed' }
      const body = typeof text === 'string' ? text.trim() : ''
      if (!body) return { ok: false, error: 'empty' }
      if (body.length > MAX_REPLY) return { ok: false, error: 'too-long' }
      const controller = controllerOf()
      if (!controller?.prompt) return { ok: false, error: 'no-controller' }
      try {
        await controller.prompt({ requestId: 'review-' + uuid(), sessionId: item.sessionId, mode: 'queue', content: [{ type: 'text', text: body }] }, AbortSignal.timeout(30_000)) // the Remote method requires a caller signal
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
      store.resolve(id, { kind: 'replied', by: 'card' })
      return { ok: true }
    },
    getFocus: () => focusId,
    setFocus(id) {
      if (id !== undefined && !openItem(id)) return false
      if (focusId === id) return true
      focusId = id
      emit()
      return true
    },
  }
}
