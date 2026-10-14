/**
 * Shared pieces of the voice answers to the first task-list item (queue-runner.js and its per-type handlers reply-permission.js,
 * reply-question.js): number words, the service guard, the frozen-item fingerprint, spoken titles and the result line.
 */
import { createHash } from 'node:crypto'
import { spokenName } from './sanitize.js'

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
/** Number words one..twenty, digits above. */
export const say = (n) => (Number.isInteger(n) && n >= 0 && n <= 20 ? WORDS[n] : String(n))
export const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1)

export const CHANGED = 'That item changed. Nothing done.'

/** The service with a method, or a short reason the flow speaks as "That failed: <reason>.". */
export function need(q, method) {
  if (!q) throw new Error('task list is not available')
  if (typeof q[method] !== 'function') throw new Error('task list ' + method + ' is not available')
  return q
}

/** What a reply is a reply TO: the item's identity and its message. Titles, summaries and queue positions may change meanwhile without it being another item. */
export const fingerprintOf = (item) => createHash('sha256').update(JSON.stringify([item.type, item.sessionId, item.createdAt, item.seq, item.payload?.reply])).digest('hex')

/** The item as the listener knows it: cleaned for speech, no trailing full stop (the lines add their own). */
export const spokenTitle = (title) => spokenName(title, 60).text.replace(/[.!?]+$/, '').trim() || 'the first item'

/** "Task <title>, <word>." plus " N waiting." / " Nothing waiting."; a count that cannot be read is simply left out (the action is done). */
export function resultLine(title, word, service) {
  let waiting = ''
  try {
    const total = service.count()?.total
    if (Number.isInteger(total)) waiting = total > 0 ? ' ' + cap(say(total)) + ' waiting.' : ' Nothing waiting.'
  } catch { /* the action is done; only the count is missing */ }
  return 'Task ' + title + ', ' + word + '.' + waiting
}
