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