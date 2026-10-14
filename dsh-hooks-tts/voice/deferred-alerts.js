/**
 * Alerts (Stop / permission / question read-outs) that arrive while a voice flow runs used to be dropped: the mic is open and
 * speaking over it would be noise. They are held here instead and spoken once the flow is over. The queue is small and
 * expiring: a "done" read out ten minutes late is worse than none, and with read-outs switched off nothing is replayed later.
 * Alerts shaped { sessionId, event } are deduped (one held alert per session and event: the newest wins), and over capacity a
 * PermissionRequest alert (something is blocked on the user) outlives every other kind: it is never evicted for a Stop alert.
 */

import { cutBytes } from './sanitize.js'

const isPermission = (item) => item?.event === 'PermissionRequest'
const dedupeKey = (item) => (item && typeof item === 'object' && item.sessionId !== undefined && item.event !== undefined ? JSON.stringify([item.sessionId, item.event]) : undefined)

export const HELD_BODY_MAX_BYTES = 8192

/**
 * A hook body as it is held: tool_input and last_assistant_message can be megabytes and the queue keeps them for up to 90 s, so
 * each is cut to max bytes (an oversized tool_input object is kept as its truncated JSON text; one that cannot be serialised is replaced by an empty string, never kept whole). The headline the speaker reads
 * is already in the body; everything else is untouched. Returns the same object when nothing needed cutting.
 */
export function capHeldBody(body, max = HELD_BODY_MAX_BYTES) {
  if (!body || typeof body !== 'object') return body
  let out = body
  for (const key of ['tool_input', 'last_assistant_message']) {
    const value = body[key]
    if (value === undefined || value === null) continue
    let text = typeof value === 'string' ? value : undefined
    if (text === undefined) {
      try { text = JSON.stringify(value) } catch { out = { ...out, [key]: '' }; continue } // unmeasurable: it must not pass uncapped
    }
    if (typeof text === 'string' && Buffer.byteLength(text) > max) out = { ...out, [key]: cutBytes(text, max) }
  }
  return out
}

const isQuestion = (item) => item?.event === 'PreToolUse' && item.question === true

/**
 * The two alert kinds that can go stale. applies: is the held alert of this kind; matches: does a pending entry (of the list the
 * kind is judged against, state[list]) stand for the very request/call the alert announced.
 */
const KINDS = {
  // Voice control tracks a pending request in the alert's session for the same tool (body.tool_name) the alert announced.
  permission: {
    applies: isPermission,
    list: 'pending',
    matches: (item, p) => typeof item?.body?.tool_name === 'string' && p.sessionId === item.sessionId && p.toolName === item.body.tool_name,
  },
  // The alert's ask_user_question call (same session and call id) is still waiting for an answer.
  question: {
    applies: isQuestion,
    list: 'pendingQuestions',
    matches: (item, p) => p.sessionId === item?.sessionId && p.callId === item?.callId,
  },
}

const isPending = (kind, item, pending) => (pending ?? []).some((p) => KINDS[kind].matches(item, p))

/**
 * Whether a held alert of this kind is still worth speaking. It can go stale (its request answered, or its question answered by
 * voice or in the GUI, timed out or cancelled), but only when voice control was tracking it (item.tracked, noted at defer time):
 * with voice off, or a request/call voice never saw, nothing says it was answered, so it counts as relevant (a late alert beats a
 * lost one). An alert of another kind is never judged here; in particular a Stop alert is always replayed: the flow keeps no record
 * of which sessions it prompted or answered (see docs/voice-two-stage-flow.md, F-H4b).
 */
function relevantAs(kind, item, state) {
  if (!KINDS[kind].applies(item) || !state?.voiceOn || item.tracked !== true) return true
  return isPending(kind, item, state[KINDS[kind].list])
}

/** True when voice control tracks a pending request in the alert's session for the same tool (body.tool_name) as the alert announced. */
export const permissionIsPending = (item, pending) => isPending('permission', item, pending)
/** True when the alert's ask_user_question call (same session and call id) is still waiting for an answer. */
export const questionIsPending = (item, pendingQuestions) => isPending('question', item, pendingQuestions)
/** Whether a held PermissionRequest alert is still worth speaking (state: { voiceOn, pending }). */
export const permissionAlertRelevant = (item, state) => relevantAs('permission', item, state)
/** Whether a held ask_user_question ("Question") alert is still worth speaking (state: { voiceOn, pendingQuestions }). */
export const questionAlertRelevant = (item, state) => relevantAs('question', item, state)

/** Whether a held alert is still worth speaking: permission and question alerts can go stale, every other kind is relevant. */
export const alertRelevant = (item, state) => permissionAlertRelevant(item, state) && questionAlertRelevant(item, state)

export function createDeferredAlerts({ busy, enabled = () => true, relevant = () => true, play, now = Date.now, max = 5, maxAgeMs = 90_000, maxBodyBytes = HELD_BODY_MAX_BYTES, playTimeoutMs = 20_000, refresh, log = () => {} }) {
  let queue = [] // { item, at }
  let flushing // the running flush, if any

  const note = (event) => { try { log(event) } catch { /* logging is best-effort */ } }

  /** Starts one held alert and waits for its launcher (bounded), so the next one never overlaps it. Never throws. */
  async function launch(item) {
    let timer
    try {
      const started = play(item)
      if (started && typeof started.then === 'function') {
        const timedOut = new Promise((resolve) => { timer = setTimeout(() => { note({ type: 'alert', stage: 'play-timeout' }); resolve() }, playTimeoutMs); timer.unref?.() })
        await Promise.race([started, timedOut])
      }
    } catch (error) { note({ type: 'alert', stage: 'play-failed', error: String(error?.message ?? error) }) } finally { clearTimeout(timer) }
  }

  async function drain() {
    while (queue.length > 0) {
      let on, isBusy
      try { on = enabled() } catch { return }
      if (!on) { queue = []; return }
      try { isBusy = busy() } catch { return } // cannot tell: keep them for the next flush
      if (isBusy) return // a flow started again: what is left stays held (and keeps ageing)
      const { item, at } = queue.shift()
      if (now() - at > maxAgeMs) { note({ type: 'alert', stage: 'dropped-expired' }); continue }
      // The request the alert announced may have been answered (by voice or in the GUI) while the flow ran, or while an earlier alert played.
      let stillRelevant = true
      try { stillRelevant = relevant(item) !== false } catch { /* cannot tell: better a late alert than a lost one */ }
      if (!stillRelevant) { note({ type: 'alert', stage: 'dropped-stale' }); continue }
      // Last look before speaking: the item's queue position may have changed while the flow ran (refresh re-renders the headline).
      let toPlay = item
      if (refresh) { try { toPlay = refresh(item) ?? item } catch (error) { note({ type: 'alert', stage: 'refresh-failed', error: String(error?.message ?? error) }) } }
      await launch(toPlay)
    }
  }

  return {
    /**
     * Holds one alert (any value play() understands). An alert of the same session and event is replaced (the newest wins and takes
     * the later place). When more than max are waiting the oldest non-permission alert is dropped first (possibly the new one);
     * a permission alert is only dropped, oldest first, when every held alert is one.
     */
    defer(item) {
      if (item && typeof item === 'object' && item.body) {
        const body = capHeldBody(item.body, maxBodyBytes)
        if (body !== item.body) { item = { ...item, body }; note({ type: 'alert', stage: 'body-truncated' }) }
      }
      const key = dedupeKey(item)
      if (key !== undefined) queue = queue.filter((q) => dedupeKey(q.item) !== key)
      queue.push({ item, at: now() })
      while (queue.length > max) {
        const at = queue.findIndex((q) => !isPermission(q.item))
        queue.splice(at >= 0 ? at : 0, 1)
        note({ type: 'alert', stage: 'dropped-overflow' })
      }
    },
    /**
     * Plays the held alerts one after another, in arrival order, once the flow is over; a no-op while busy. Each launcher is awaited
     * (at most playTimeoutMs) before the next starts, and busy, age and relevance are checked again for every alert: when a flow
     * starts again meanwhile the rest stays held. Only one flush runs at a time (a second call joins it). Never rejects.
     */
    flush() {
      flushing ??= drain().catch(() => {}).finally(() => { flushing = undefined })
      return flushing
    },
    clear() { queue = [] },
    size: () => queue.length,
  }
}
