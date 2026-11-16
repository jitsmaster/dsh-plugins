import { recommendedOf } from './speech.js'

/**
 * Expires the detached questions among `olds` (their live request ended, so the assistant carried on with the recommended option).
 * skip(item) spares an item; onError receives a failing resolve and the loop goes on (without it the error propagates).
 */
export function expireDetachedQuestions(store, olds, { skip = () => false, onError } = {}) {
  for (const old of olds) {
    if (old.type !== 'question' || old.detached !== true || skip(old)) continue
    try { store.resolve(old.id, { kind: 'expired', assumed: (old.payload?.questions ?? []).map(recommendedOf).filter(Boolean) }) } catch (error) { if (!onError) throw error; onError(error) }
  }
}

/**
 * The open items of one session: the store's per-session index when it has one (peekOpen), else the open list filtered by session.
 * onlyOpen also drops anything in the index that is no longer open (a caller that resolves items while it walks the list).
 */
export function openOf(store, sessionId, { onlyOpen = false } = {}) {
  if (typeof store.peekOpen !== 'function') return store.list({ status: 'open' }).filter((i) => i.sessionId === sessionId)
  const indexed = store.peekOpen(sessionId)
  return onlyOpen ? indexed.filter((i) => i.status === 'open') : indexed
}
