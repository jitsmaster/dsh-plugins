/**
 * Approve / deny the first task-list item by voice (slice 6). The read-back says what is decided before the strict yes, with the
 * existing approval rules (actions.js, headline.js): approving needs a KNOWN tool and an operand that was read in full (not cut, no
 * hidden or unspeakable characters, the request's reason included); denying is always safe, so it says what it can.
 * The decision itself is the card's own service call (approve / deny). Anything but a yes at the read-back cancels.
 */
import { toolPhrase } from './actions.js'
import { isKnownTool, withReason } from './headline.js'
import { spokenName, spokenSummaryInfo } from './sanitize.js'
import { need } from './reply-common.js'

export const NOT_APPROVABLE = 'That request is too long or unclear to approve by voice. Answer it on screen.'
const DECISIONS = ['approve', 'deny']
const WORD = { approve: 'approved', deny: 'denied' }

/** { text, complete } of what the request will do, from the queue item's own payload. */
function summaryOf(item) {
  const p = item.payload ?? {}
  const operand = typeof p.detail === 'string' && p.detail.trim() ? spokenSummaryInfo(p.detail) : { text: undefined, complete: false }
  return withReason({ text: operand.text, complete: operand.complete === true && isKnownTool(p.toolName) }, p.reason)
}

/** "Warning: Deletes files recursively." for every risk the queue flagged (their labels are written by the queue, spoken like any name). */
const warnings = (item) => (Array.isArray(item.risks) ? item.risks : [])
  .map((r) => spokenName(r?.label, 80).text.replace(/[.!?]+$/, ''))
  .filter(Boolean)
  .map((label) => ' Warning: ' + label + '.')
  .join('')

function readBack(decision, item) {
  const info = summaryOf(item)
  const phrase = toolPhrase(item.payload?.toolName) + ' ' + (info.text || 'details not available')
  const session = spokenName(item.sessionTitle, 40).text
  return 'I will ' + decision + ' ' + phrase + (session ? ' in ' + session : '') + '.' + warnings(item) + ' Shall I do it?'
}

export const permissionHandler = {
  kinds: new Set(DECISIONS),
  changed: ['not-open', 'not-pending'],
  begin(item, intent) {
    const decision = intent.kind
    const info = summaryOf(item)
    if (decision === 'approve' && !(info.complete && info.text)) return { refuse: { outcome: 'not-approvable', line: NOT_APPROVABLE } }
    return { move: { kind: 'confirm', state: { decision }, line: readBack(decision, item) } }
  },
  /** Only a strict yes decides (the flow sends it); whatever else is said at the read-back cancels. */
  step: () => ({ kind: 'cancel' }),
  send(service, frozen, text, state) {
    const decision = state?.decision
    if (!DECISIONS.includes(decision)) throw new Error('no decision to send')
    return need(service, decision)[decision](frozen.id)
  },
  word: (frozen, state) => WORD[state?.decision],
}
