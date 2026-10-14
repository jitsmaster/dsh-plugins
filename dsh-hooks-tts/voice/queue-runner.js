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
 *
 * Spoken lines (spec, "Spoken lines"): "Task list showing." · "Task list hidden." · "Three waiting: one question, one permission,
 * one done." · "Nothing waiting." · "There is no item 7." · "Nothing has been read yet." · "The speaker is not available." ·
 * "Opened <title>.". A read that starts says nothing; a muted speaker is silence.
 */
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

export function createQueueRunner({ queue = () => undefined, select }) {
  const service = () => { try { return queue() } catch { return undefined } }

  function need(q, method) {
    if (!q) throw new Error('task list is not available')
    if (typeof q[method] !== 'function') throw new Error('task list ' + method + ' is not available')
    return q
  }

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

  return {
    // Without the service nothing is a command: the flow echoes the words like any other utterance.
    match: (text) => (service() ? matchQueueCommand(text) : undefined),
    run,
    stop: () => { service()?.stop?.() },
  }
}
