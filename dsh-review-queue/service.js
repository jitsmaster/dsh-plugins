/**
 * The `reviewQueue` service: the one API the sidebar, the overlay and (later) voice all use. It owns no state of its
 * own except the focused item; items live in the store and pending requests in capture.
 */
import { randomUUID } from 'node:crypto'
import { spokenFor, titleFor, fullTextFor, chunkForSpeech } from './speech.js'

const MAX_REPLY = 4000

export function createReviewQueue({ store, capture, controllerOf, speaker, now = Date.now, uuid = () => randomUUID().slice(0, 8) }) {
  let focusId
  let reading // id of the item being read aloud
  let readSeq = 0 // a read that was replaced or stopped must not clear the state of its successor
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
        reading,
        open: snap.open.map((item) => ({ ...item, title: titleFor(item), spoken: spokenFor(item, item.position) })),
        resolved: snap.resolved.map((item) => ({ ...item, title: titleFor(item) })),
      }
    },
    /** Reads the whole message of an item aloud (not its summary). */
    read(id) {
      const item = store.get(id)
      if (!item) return { ok: false, error: 'not-found' }
      if (!speaker) return { ok: false, error: 'no-speaker' }
      const position = store.snapshot().open.find((i) => i.id === id)?.position
      const token = readSeq + 1
      const result = speaker.speak(chunkForSpeech(fullTextFor(item, position)), {
        onEnd: () => { if (readSeq === token && reading === id) { reading = undefined; emit() } },
      })
      if (!result?.ok) return { ok: false, error: result?.error ?? 'no-speaker' }
      readSeq = token
      reading = id
      emit()
      return { ok: true }
    },
    stop() {
      readSeq++
      try { speaker?.stop() } catch { /* nothing to stop */ }
      if (reading !== undefined) { reading = undefined; emit() }
      return { ok: true }
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
