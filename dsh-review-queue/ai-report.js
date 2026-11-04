/**
 * The hourly "AI handled" report, the PURE part: counts only, no I/O. buildReport() tallies what the AI did in a window [from, to) from the store's items
 * (item.resolvedAt, item.resolution) and the triage log (observe-mode proposals, user feedback); reportText() turns the tally into one short sentence
 * for the speaker and the chat. The text carries counts and nouns only, never an id, a path or any item text.
 */
import { classOf } from './triage.js'

const CLASS_KEYS = ['done', 'permission', 'question', 'idle', 'other']
const NOUNS = { done: ['done card', 'done cards'], permission: ['approval', 'approvals'], question: ['question', 'questions'], idle: ['idle session', 'idle sessions'], other: ['other item', 'other items'] }
const MAX_TEXT = 300

const inWindow = (at, from, to) => typeof at === 'number' && Number.isFinite(at) && at >= from && at < to
const keyOf = (type) => classOf({ type }) ?? 'other'

/** Counts one entry per id into `seen`, bumping the class tally; returns whether it was new. */
function tally(seen, by, id, type) {
  if (seen.has(id)) return false
  seen.add(id)
  const k = keyOf(type)
  by[k] = (by[k] ?? 0) + 1
  return true
}

/**
 * @param {{ items?: object[], entries?: object[], from: number, to: number }} input
 * @returns {{ from: number, to: number, aiResolved: number, autoCleared: number, wouldHandle: number, overruled: number, handled: number, total: number, byClass: object }}
 */
export function buildReport({ items = [], entries = [], from, to }) {
  const byClass = { aiResolved: {}, autoCleared: {}, wouldHandle: {}, overruled: {} }
  const seen = { aiResolved: new Set(), autoCleared: new Set(), wouldHandle: new Set(), overruled: new Set() }
  const n = { aiResolved: 0, autoCleared: 0, wouldHandle: 0, overruled: 0 }
  const count = (bucket, id, type) => { if (tally(seen[bucket], byClass[bucket], id, type)) n[bucket]++ }
  for (const it of items) {
    // Only resolved items with a real resolution time in the window count; an open item never does.
    if (!it || it.status !== 'resolved' || !inWindow(it.resolvedAt, from, to)) continue
    const r = it.resolution ?? {}
    if (r.kind === 'ai-resolved') count('aiResolved', it.id, it.type)
    else if (r.kind === 'no-action' && r.by === 'auto') count('autoCleared', it.id, it.type)
    if (r.review === 'overruled') count('overruled', it.id, it.type)
  }
  for (const e of entries) {
    if (!e || !inWindow(e.at, from, to)) continue
    if (e.stage === 'judge' && e.verdict === 'handle') count('wouldHandle', e.itemId, e.type)
    else if (e.stage === 'feedback' && e.review === 'overruled') count('overruled', e.itemId, e.type)
  }
  return { from, to, ...n, handled: n.aiResolved + n.autoCleared, total: n.aiResolved + n.autoCleared + n.wouldHandle, byClass }
}

const plural = (k, c) => c + ' ' + NOUNS[k][c === 1 ? 0 : 1]
const sum = (a = {}, b = {}) => Object.fromEntries(CLASS_KEYS.map((k) => [k, (a[k] ?? 0) + (b[k] ?? 0)]).filter(([, c]) => c > 0))

/** One line (<= 300 chars) for voice and chat: handled count with class split, the would-also-have count, the overruled count; zero parts are left out. */
export function reportText(report) {
  const { aiResolved = 0, autoCleared = 0, wouldHandle = 0, overruled = 0, byClass = {} } = report ?? {}
  const handled = aiResolved + autoCleared
  const parts = []
  if (handled > 0) {
    const split = Object.entries(sum(byClass.aiResolved, byClass.autoCleared)).map(([k, c]) => plural(k, c)).join(', ')
    parts.push('AI handled ' + handled + ' in the last hour' + (split ? ': ' + split : '') + '.')
  }
  if (wouldHandle > 0) parts.push(handled > 0 ? 'It would also have handled ' + wouldHandle + ' more.' : 'In the last hour the AI would have handled ' + wouldHandle + ' (proposals only).')
  if (overruled > 0) parts.push('You overruled ' + overruled + '.')
  const text = parts.join(' ')
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text
}
