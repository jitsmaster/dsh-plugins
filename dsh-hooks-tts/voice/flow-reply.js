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
 * Stepped answers (slice 6: approve / deny a permission, answer a question; the queue's prepareReply returns a `move` with the frozen
 * item): the queue decides what happens next and the flow only carries it out. Moves: ask { state, line? } (say the line, then listen
 * at step 'reply-ask'), confirm { state, line } (read-back, strict yes sends), again (ask to say it again), cancel, reject { error }
 * and end { line? }. The answers of an ask / confirm step go to queue.replyStep(frozen, state, { step, kind, text }); the yes sends
 * queue.sendReply(frozen, undefined, state). Only "cancel" and silence are handled here, so words like "yes" or "show the task list"
 * are plain answers at an ask step and the matcher never sees them.
 *
 * The text is sanitised exactly like a dictated utterance (speakableUtterance: 1500 characters, nothing the speaker would alter),
 * so what is read back is what is sent. The send goes through queue.sendReply, which uses the card's own service call.
 */
import { speakableUtterance } from './sanitize.js'

export const REPLY_STEPS = Object.freeze({ dictate: 'reply-dictate', confirm: 'reply-confirm', ask: 'reply-ask' })
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
    s.reply = { frozen: r.frozen, text: '', ...(r.move ? { stepped: true } : {}) }
    if (r.move) return apply(r.move, 'prepare', turn)
    logged({ step: 'prepare', outcome: 'dictate', item: r.frozen?.id, snapshotId: r.frozen?.snapshotId })
    await openListen('REPLY_DICTATE', REPLY_STEPS.dictate)
  }

  /** Carries out one move of the queue's stepped answer (see the header); `step` names where it came from, for the log. */
  function apply(move, step, turn) {
    const line = move?.line
    const base = { step, item: s.reply?.frozen?.id }
    switch (move?.kind) {
      case 'ask':
        s.reply = { ...s.reply, state: move.state }
        logged({ ...base, outcome: 'ask' })
        return line ? sayThenListen('REPLY_ASK', String(line), REPLY_STEPS.ask) : openListen('REPLY_ASK', REPLY_STEPS.ask)
      case 'confirm':
        s.reply = { ...s.reply, state: move.state }
        logged({ ...base, outcome: 'confirm' })
        return sayThenListen('REPLY_CONFIRM', String(line), REPLY_STEPS.confirm)
      case 'again':
        logged({ ...base, outcome: 'again' })
        return sayThenListen('REPLY_CONFIRM', lines.sayAgain, REPLY_STEPS.confirm)
      case 'cancel':
        logged({ ...base, outcome: 'cancelled' })
        return end(lines.cancelled)
      case 'reject':
        logged({ ...base, outcome: move.error })
        return end(move.error === 'too-long' ? lines.tooLong : lines.unspeakable)
      case 'end':
        logged({ ...base, outcome: move.outcome ?? 'ended', ...(line ? { line } : {}) })
        return finish(turn, line)
      default:
        failure(new Error('unknown reply move ' + move?.kind))
        return end(failText(new Error('unknown reply move')))
    }
  }

  /** What was said at an ask or confirm step: the queue turns it into the next move. */
  async function advance(input) {
    const turn = s.turn, { frozen, state } = s.reply
    let move
    try {
      move = await queue.replyStep(frozen, state, input)
    } catch (e) {
      failure(e)
      return end(failText(e))
    }
    if (turn !== s.turn) return note('stale', { stage: 'queue.reply' })
    return apply(move, input.step, turn)
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
      result = (await withTimeout(() => (s.reply.stepped ? queue.sendReply(frozen, undefined, s.reply.state) : queue.sendReply(frozen, text)))) ?? {}
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
      logged({ step: dictating ? 'dictate' : step === REPLY_STEPS.ask ? 'ask' : 'confirm', outcome: 'cancelled' })
      return end(lines.cancelled)
    }
    if (kind === 'empty') return end(lines.noAnswer)
    if (s.reply?.stepped) {
      if (step === REPLY_STEPS.confirm && kind === 'yes') return send()
      return advance({ step: step === REPLY_STEPS.ask ? 'ask' : 'confirm', kind, text })
    }
    // Whatever is said at the dictation is the text, "yes" and "no" included; only "cancel" (above) is a command there.
    if (dictating) return accept(text, 'dictated')
    if (kind === 'no') return sayThenListen('REPLY_CONFIRM', lines.sayAgain, REPLY_STEPS.confirm)
    if (kind === 'yes') return send()
    return accept(text, 'replaced')
  }

  return { start, answer }
}
