/**
 * Voice reply to the first task-list item (dsh-review-queue/docs/voice-task-list.md, slice 5): the steps that sit between the
 * queue's reply intent and the queue service. flow.js owns the state machine and hands this module the few primitives it needs
 * (io); this module owns the order of the steps and their spoken lines.
 *
 *   start(intent)            prepare: the queue freezes the first item (queue.prepareReply) -> REPLY_DICTATE (listen window, no echo;
 *                            the queue-command matcher never runs on what is said there, only on a capture)
 *   answer(step, kind, text) the dictation (step 'reply-dictate') or the answer to the read-back (step 'reply-confirm'):
 *                            "cancel" aborts, a strict yes sends, any other speech replaces the whole text and is read back again
 *
 * The text is sanitised exactly like a dictated utterance (speakableUtterance: 1500 characters, nothing the speaker would alter),
 * so what is read back is what is sent. The send goes through queue.sendReply, which uses the card's own service call.
 */
import { speakableUtterance } from './sanitize.js'

export const REPLY_STEPS = Object.freeze({ dictate: 'reply-dictate', confirm: 'reply-confirm' })
const message = (e) => String(e?.message ?? e)

/**
 * @param {{ queue: object, note: Function, now: () => number, io: object }} deps
 * io = { s (flow state), lines, failText, enter, end, reset, clearGuard, sayThenListen, openListen, withTimeout, beginHold, settleHeld }
 */
export function createReplyStep({ queue, note, now, io }) {
  const { s, lines, failText, enter, end, reset, clearGuard, sayThenListen, openListen, withTimeout, beginHold, settleHeld } = io
  const logged = (data) => note('queue.reply', data)
  const failure = (e) => note('queue.error', { phase: 'reply', message: message(e) })

  /** Ends the turn with a line, or with deliberate silence when there is none. */
  function finish(turn, line) {
    if (line) return end(String(line), turn)
    clearGuard(); reset()
  }

  async function start(intent) {
    const turn = enter('QUEUE'); s.step = 'queue'
    let r
    try {
      r = (await withTimeout(() => queue.prepareReply(intent))) ?? {}
    } catch (e) {
      failure(e)
      r = { ok: false, outcome: 'error', line: failText(e), error: message(e) }
    }
    if (turn !== s.turn) return note('stale', { stage: 'queue.reply' })
    if (!r.ok) {
      logged({ step: 'prepare', outcome: r.outcome ?? 'refused', ...(r.line ? { line: r.line } : {}), ...(r.error ? { error: r.error } : {}) })
      return finish(turn, r.line)
    }
    s.reply = { frozen: r.frozen, text: '' }
    logged({ step: 'prepare', outcome: 'dictate', item: r.frozen?.id, snapshotId: r.frozen?.snapshotId })
    await openListen('REPLY_DICTATE', REPLY_STEPS.dictate)
  }

  /** A dictation or a replacement: sanitise, then read it back and wait for the yes. */
  function accept(text, step) {
    const said = speakableUtterance(text)
    if (!said.ok) {
      logged({ step, outcome: said.error })
      return end(said.error === 'too-long' ? lines.tooLong : lines.unspeakable)
    }
    let line
    try {
      line = queue.replyReadBack(s.reply.frozen, said.text)
    } catch (e) {
      failure(e)
      return end(failText(e))
    }
    s.reply = { ...s.reply, text: said.text }
    logged({ step, outcome: 'confirm', chars: said.text.length })
    return sayThenListen('REPLY_CONFIRM', String(line), REPLY_STEPS.confirm)
  }

  /** The yes: send the frozen item and the confirmed text. Like any action, a barge-in meanwhile is held and the outcome is always said. */
  async function send() {
    const turn = enter('EXECUTE'), { frozen, text } = s.reply, t = now()
    const hold = beginHold()
    let result
    try {
      result = (await withTimeout(() => queue.sendReply(frozen, text))) ?? {}
    } catch (e) {
      failure(e)
      result = { outcome: 'error', line: failText(e), error: message(e) }
    }
    logged({ step: 'send', outcome: result.outcome ?? 'sent', item: frozen?.id, ...(result.line ? { line: result.line } : {}), ...(result.error ? { error: result.error } : {}), ms: now() - t })
    await settleHeld(turn, hold, result.line)
  }

  function answer(step, kind, text) {
    const dictating = step === REPLY_STEPS.dictate
    if (kind === 'stop') {
      logged({ step: dictating ? 'dictate' : 'confirm', outcome: 'cancelled' })
      return end(lines.cancelled)
    }
    if (kind === 'empty') return end(lines.noAnswer)
    // Whatever is said at the dictation is the text, "yes" and "no" included; only "cancel" (above) is a command there.
    if (dictating) return accept(text, 'dictated')
    if (kind === 'no') return sayThenListen('REPLY_CONFIRM', lines.sayAgain, REPLY_STEPS.confirm)
    if (kind === 'yes') return send()
    return accept(text, 'replaced')
  }

  return { start, answer }
}
