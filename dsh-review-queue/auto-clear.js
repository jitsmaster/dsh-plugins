/**
 * Two housekeeping rules of the task list, applied by one small sweep (every few seconds, see index.js):
 *   - A question whose wait has run out (its expiresAt has passed) leaves the open list at once: it is resolved as 'expired' (the assistant has
 *     carried on with the recommended option; the late-answer card stays under Resolved).
 *   - A finished message ('completed') with nothing for the user to do - its summary has no bold action item (<u>**...**</u>) and the reply
 *     has nothing the guard (actionable.js) sees for the user - leaves the list 30 seconds after it arrived: resolved as 'no-action', so it
 *     is still found under Resolved and can be reopened.
 * An item the user already handled is not open any more and is never touched.
 */
import { needsUser } from './actionable.js'
import { recommendedOf } from './speech.js'

export const DONE_NO_ACTION_MS = 30_000

/** The summary holds a bold action item. */
export const hasActionItem = (summary) => typeof summary === 'string' && summary.includes('**')

export function createAutoClear({ store, now = Date.now, doneMs = DONE_NO_ACTION_MS, log = () => {} }) {
  const guard = (fn, fallback) => { try { return fn() } catch (error) { log('auto-clear: ' + String(error?.message ?? error).slice(0, 160)); return fallback } }

  function expiredQuestion(item, t) {
    return item.type === 'question' && Number.isFinite(item.expiresAt) && t >= item.expiresAt
  }
  function quietDone(item, t) {
    return item.type === 'completed' && t - item.createdAt >= doneMs && item.actionable !== true
      && !hasActionItem(item.summary) && !guard(() => needsUser(String(item.payload?.reply ?? '')), true)
  }

  /** One pass: { questions, done } = how many items were cleared. */
  function sweep() {
    const out = { questions: 0, done: 0 }
    guard(() => {
      const t = now()
      for (const item of store.list({ status: 'open' })) {
        if (expiredQuestion(item, t)) {
          const assumed = (item.payload?.questions ?? []).map(recommendedOf).filter(Boolean)
          if (store.resolve(item.id, { kind: 'expired', assumed })) { out.questions++; log('auto-clear: question ' + item.id + ' expired, removed from the list') }
        } else if (quietDone(item, t)) {
          if (store.resolve(item.id, { kind: 'no-action', by: 'auto' })) { out.done++; log('auto-clear: done item ' + item.id + ' needs no action, removed after ' + Math.round(doneMs / 1000) + ' s') }
        }
      }
    })
    return out
  }
  return { sweep }
}
