/**
 * Slice 7 (task list by voice): a headline alert says the item's queue position when the item is already in the task list
 * ("Item three, done in dsh-plugins."). The position is the item's place among the OPEN items in the order the cards show and
 * "read item N" / "reply to item N" count, read from the reviewQueue service's snapshot() (dsh-hooks-tts imports nothing from
 * dsh-review-queue). Every failure (no service, a throwing service, an item that is not there) is "no position": the caller
 * then speaks the old headline, so a misbehaving queue can never break or silence an alert.
 */

/** The service, given directly or as a getter resolved right now; a getter that throws is no service. */
function serviceOf(queue) {
  if (typeof queue !== 'function') return queue ?? undefined
  try { return queue() ?? undefined } catch { return undefined }
}

/** Whether an open item is the one the alert announced (same type and session; a question by its call id, a request by its tool). */
function isAlerted(entry, locator) {
  if (!entry || typeof entry !== 'object' || entry.type !== locator.type || entry.sessionId !== locator.sessionId) return false
  if (entry.status !== undefined && entry.status !== 'open') return false // snapshot().open holds open items only; belt and braces
  if (locator.type === 'question' && locator.callId !== undefined) return entry.key === locator.callId
  if (locator.type === 'permission' && locator.toolName !== undefined) return entry.payload?.toolName === locator.toolName
  return true
}

/**
 * The 1-based queue position of the open item an alert is about (locator: { type, sessionId, callId?, toolName? }, see
 * alerts.js alertLocator), or undefined when it is not in the list. With several candidates (two requests of one session) the
 * newest, the last in list order, is the one just announced.
 */
export function queuePositionOf(queue, locator) {
  if (!locator || typeof locator.sessionId !== 'string' || !locator.sessionId) return undefined
  try {
    const open = serviceOf(queue)?.snapshot?.()?.open
    if (!Array.isArray(open)) return undefined
    for (let i = open.length - 1; i >= 0; i--) if (isAlerted(open[i], locator)) return i + 1
  } catch { /* a queue that throws has no position */ }
  return undefined
}

/**
 * A held alert (item.locator + item.headlineAt(position), noted when it was held) with its headline re-rendered for where the
 * item is NOW (positionOf(locator)): the queue moved on while the flow ran. An item that left the list, or a lookup that throws,
 * gives the old session headline (headlineAt(undefined)); an alert without locator/renderer, or a renderer that fails, is returned
 * as it was.
 */
export function refreshHeldAlert(item, positionOf) {
  if (!item || typeof item.headlineAt !== 'function' || !item.locator || !item.body) return item
  let position
  try { position = positionOf(item.locator) } catch { position = undefined }
  let headline
  try { headline = item.headlineAt(position) } catch { return item }
  return typeof headline === 'string' ? { ...item, body: { ...item.body, headline } } : item
}
