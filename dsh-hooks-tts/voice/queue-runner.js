/**
 * Adapter between the voice flow's task-list fast path (flow.js `queue` dependency) and the dsh-review-queue
 * `reviewQueue` service (ctx.get('reviewQueue'); the plugin may be absent). Pure glue: intents in, outcome lines out.
 *
 *   createQueueRunner({ queue, select }) → { match(text), run(intent), stop() }
 *     queue()      → the reviewQueue service or undefined, resolved on every call (the plugin may load later or not at all)
 *     select(id)   → makes a session the voice target (the same path as the "switch" action)
 *     match(text)  → intent | undefined; undefined too whenever the queue is absent, so the flow behaves as it did before
 *     run(intent)  → Promise<{ outcome, line?, silence? }>; rejects with a short Error, which the flow speaks as "That failed: ..."
 *     stop()       → stops the reader (the hotkey path); throws if the service does, the flow guards it
 *     prepareReply(intent) → Promise<{ ok:true, frozen } | { ok:false, outcome, line? }>: freezes the first item for a voice reply
 *     replyReadBack(frozen, text) → the confirm line; sendReply(frozen, text) → Promise<{ outcome, line }> (re-checks the item first)
 *
 * Spoken lines (spec, "Spoken lines"): "Task list showing." · "Task list hidden." · "Three waiting: one question, one permission,
 * one done." · "Nothing waiting." · "There is no item 7." · "Nothing has been read yet." · "The speaker is not available." ·
 * "Opened <title>.". A read that starts says nothing; a muted speaker is silence.
 * Reply lines: "Send to <title>: <text>. Say yes to send, or say the prompt again to replace it." · "Task <title>, reply sent. N waiting." ·
 * "That item changed. Nothing done." · "Voice reply works on done items only. Answer it on screen."
 */
import { createHash } from 'node:crypto'
import { matchQueueCommand } from './queue-commands.js'
import { spokenName } from './sanitize.js'

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
/** Number words one..twenty, digits above. */
const say = (n) => (Number.isInteger(n) && n >= 0 && n <= 20 ? WORDS[n] : String(n))
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1)

/** [byType key, singular, plural] in spoken order; "done" has no plural. */
const TYPES = [['question', 'question', 'questions'], ['permission', 'permission', 'permissions'], ['completed', 'done', 'done']]

/** "Three waiting: one question, one permission, one done." / "Nothing waiting." — total first, zero types omitted. */
export function countLine(count) {
  const total = count?.total
  if (!Number.isInteger(total) || total <= 0) return 'Nothing waiting.'
  const parts = []
  for (const [key, one, many] of TYPES) {
    const n = count.byType?.[key]
    if (Number.isInteger(n) && n > 0) parts.push(say(n) + ' ' + (n === 1 ? one : many))
  }
  return cap(say(total)) + ' waiting' + (parts.length ? ': ' + parts.join(', ') : '') + '.'
}

/** Reading errors that have a spoken line (or silence); anything else is thrown. */
function readOutcome(result, intent) {
  if (result?.ok === true) return { outcome: 'reading' }
  switch (result?.error) {
    case 'empty': return { outcome: 'empty', line: 'Nothing waiting.' }
    case 'no-item': {
      const n = result.n ?? intent.n
      return { outcome: 'no-item', line: n === undefined ? 'There is no next item.' : 'There is no item ' + n + '.' }
    }
    case 'nothing-read': return { outcome: 'nothing-read', line: 'Nothing has been read yet.' }
    case 'muted': return { outcome: 'muted' }
    case 'no-speaker': return { outcome: 'no-speaker', line: 'The speaker is not available.' }
    default: throw new Error(String(result?.error ?? 'could not read'))
  }
}

const UNSUPPORTED_REPLY = 'Voice reply works on done items only. Answer it on screen.'
const CHANGED = 'That item changed. Nothing done.'

/**
 * Voice reply, one handler per item type (the first item decides). `send` goes through the SAME service call as the card's button, so
 * there is no second action path. Question and permission items get their handler in a later slice; until then they are answered on screen.
 */
const REPLY_HANDLERS = {
  completed: { send: (service, frozen, text) => need(service, 'reply').reply(frozen.id, text) },
}

/** What a reply is a reply TO: the item's identity and its message. Titles, summaries and queue positions may change meanwhile without it being another item. */
const fingerprintOf = (item) => createHash('sha256').update(JSON.stringify([item.type, item.sessionId, item.createdAt, item.seq, item.payload?.reply])).digest('hex')

/** The item as the listener knows it: cleaned for speech, no trailing full stop (the lines add their own). */
const spokenTitle = (title) => spokenName(title, 60).text.replace(/[.!?]+$/, '').trim() || 'the first item'

/** "Task <title>, reply sent." plus " N waiting." / " Nothing waiting."; a count that cannot be read is simply left out. */
function sentLine(title, service) {
  let waiting = ''
  try {
    const total = service.count()?.total
    if (Number.isInteger(total)) waiting = total > 0 ? ' ' + cap(say(total)) + ' waiting.' : ' Nothing waiting.'
  } catch { /* the reply is sent; only the count is missing */ }
  return 'Task ' + title + ', reply sent.' + waiting
}

function need(q, method) {
  if (!q) throw new Error('task list is not available')
  if (typeof q[method] !== 'function') throw new Error('task list ' + method + ' is not available')
  return q
}

export function createQueueRunner({ queue = () => undefined, select }) {
  const service = () => { try { return queue() } catch { return undefined } }

  function uiCommand(q, cmd) {
    const r = need(q, 'uiCommand').uiCommand(cmd)
    if (!r?.ok) throw new Error(String(r?.error ?? 'the task list did not answer'))
  }

  function open(q) {
    const target = need(q, 'openTarget').openTarget()
    if (!target) return { outcome: 'empty', line: 'Nothing waiting.' }
    if (!target.sessionId) throw new Error('the item has no session')
    select(target.sessionId)
    // The session is selected now; failing to close the list on screen must not turn that into a failure line.
    try { uiCommand(q, 'hide') } catch { /* the overlay stays open; the user can close it */ }
    const title = spokenName(target.title, 60).text.replace(/[.!?]+$/, '').trim()
    return { outcome: 'opened', line: 'Opened ' + (title || 'the first item') + '.' }
  }

  async function run(intent) {
    const q = service()
    switch (intent?.kind) {
      case 'show': uiCommand(q, 'show'); return { outcome: 'show', line: 'Task list showing.' }
      case 'hide': uiCommand(q, 'hide'); return { outcome: 'hide', line: 'Task list hidden.' }
      case 'count': return { outcome: 'count', line: countLine(need(q, 'count').count()) }
      case 'read': return readOutcome(need(q, 'readPosition').readPosition(intent.n), intent)
      case 'next': return readOutcome(need(q, 'next').next(), intent)
      case 'again': return readOutcome(need(q, 'again').again(), intent)
      case 'stop': need(q, 'stop').stop(); return { outcome: 'stopped', silence: true }
      case 'open': return open(q)
      default: throw new Error('unknown task list command ' + intent?.kind)
    }
  }

  /** Freezes the first open item for a voice reply: id, type, snapshotId and spoken title; or the reason it cannot be replied to. */
  async function prepareReply() {
    const q = need(service(), 'snapshot')
    const snap = q.snapshot()
    const item = snap?.open?.[0]
    if (!item) return { ok: false, outcome: 'empty', line: 'Nothing waiting.' }
    if (!REPLY_HANDLERS[item.type]) return { ok: false, outcome: 'unsupported', line: UNSUPPORTED_REPLY }
    const frozen = Object.freeze({ id: item.id, type: item.type, snapshotId: snap.snapshotId, title: spokenTitle(item.title), fingerprint: fingerprintOf(item) })
    return { ok: true, frozen }
  }

  /**
   * The yes: the frozen item must still be waiting and unchanged (the snapshot id is the cheap check; when the queue moved on for
   * another reason the item's own fingerprint decides, so a new item arriving while the user dictates does not cancel the reply).
   */
  async function sendReply(frozen, text) {
    const q = need(service(), 'snapshot')
    const handler = REPLY_HANDLERS[frozen?.type]
    if (!handler) throw new Error('no voice reply for ' + frozen?.type + ' items')
    const snap = q.snapshot()
    const item = snap?.open?.find((i) => i.id === frozen.id)
    const same = item && item.type === frozen.type && (snap.snapshotId === frozen.snapshotId || fingerprintOf(item) === frozen.fingerprint)
    if (!same) return { outcome: 'changed', line: CHANGED }
    const result = await handler.send(q, frozen, text)
    if (result?.error === 'not-open') return { outcome: 'changed', line: CHANGED }
    if (!result?.ok) throw new Error(String(result?.error ?? 'could not send'))
    return { outcome: 'sent', line: sentLine(frozen.title, q) }
  }

  return {
    // Without the service nothing is a command: the flow echoes the words like any other utterance.
    match: (text) => (service() ? matchQueueCommand(text) : undefined),
    run,
    prepareReply,
    sendReply,
    replyReadBack: (frozen, text) => 'Send to ' + frozen.title + ': ' + text + (/[.!?]$/.test(text) ? ' ' : '. ') + 'Say yes to send, or say the prompt again to replace it.',
    stop: () => { service()?.stop?.() },
  }
}
