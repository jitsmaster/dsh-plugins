/**
 * Decides which phone pushes to send from what happens to the hub's items (docs/mobile.md "Notifier", hub.md 6.1). One push per type
 * and change burst, replaced by tag (the count in it is the number of items of that type still open), TTL 12 h, urgency high for
 * permission and question. Rules: a push is held while the desktop overlay was looked at within the last 60 s (presence) and goes out
 * once 60 s pass without a look, if the item is still open; a finished message ('completed') is pushed only after the actionable
 * verdict (a verdict of "no action" resolves the item, so it is never pushed; no verdict, an answer without one or a model failure
 * shows the item, so it is pushed once the summary had its time); a device's quiet hours hold done / merged items back and send them
 * as one count-only digest when they end, permission and question break through; a device's type switches are honoured. What goes
 * on the lock screen is the type and the count, never a title, command, question or reply, and neither the log nor errors repeat it.
 * Items already open when the notifier starts are not announced.
 */
import { PUSH_TYPES } from '../lib/mobile/push-client.js'
import { quietEndsAt } from './quiet.js'

export const HOLD_MS = 60_000
export const VERDICT_WAIT_MS = 15_000 // longer than the summarizer's own 10 s timeout
const COALESCE_MS = 200
const TTL_SEC = 12 * 3600

const WORDS = {
  permission: { title: 'Permission waiting', urgency: 'high' },
  question: { title: 'Question waiting', urgency: 'high' },
  'pr-merged': { title: 'Pull request merged', urgency: 'normal' },
  completed: { title: 'Done', urgency: 'normal' },
}
const TYPES = new Set(PUSH_TYPES.map((t) => t.id))
const BREAKS_QUIET = new Set(PUSH_TYPES.filter((t) => t.breaksQuiet).map((t) => t.id))
const DIGEST_WORDS = [['completed', 'done'], ['pr-merged', 'PR merged']]
const count = (n) => n + (n === 1 ? ' item' : ' items')

/**
 * @param {{ store: { list: Function, get: Function, onChange: Function }, push: ReturnType<import('./push.js').createPushStore>, now?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function }, presence?: () => number, log?: (line: string) => void,
 *   holdMs?: number, verdictMs?: number, coalesceMs?: number }} opts presence: when the desktop overlay was last seen looked at (ms, -Infinity: never)
 */
export function createNotifier({ store, push, now = Date.now, timers = globalThis, presence = () => -Infinity, log = () => {}, holdMs = HOLD_MS, verdictMs = VERDICT_WAIT_MS, coalesceMs = COALESCE_MS }) {
  const handled = new Set(store.list({ status: 'open' }).filter((i) => TYPES.has(i.type)).map((i) => i.id))
  /** @type {Map<string, { ids: Set<string>, timer: any }>} push record id -> items held for its digest */
  const digests = new Map()
  let evalTimer
  let evalAt = Infinity
  let disposed = false

  function schedule(at) {
    if (disposed || (evalTimer && evalAt <= at)) return
    timers.clearTimeout(evalTimer)
    evalAt = at
    evalTimer = timers.setTimeout(() => { evalTimer = undefined; evalAt = Infinity; evaluate() }, Math.max(0, at - now()))
    evalTimer.unref?.()
  }

  /** @returns {{ ok: true } | { ok: false, retryAt?: number }} whether an open item may be announced yet */
  function ready(item, t) {
    if (item.type !== 'completed') return { ok: true }
    if (item.actionable === false) return { ok: false }
    if (item.actionable === true || (item.summarySource !== undefined && item.summarySource !== 'fallback')) return { ok: true }
    const due = item.createdAt + verdictMs
    return t >= due ? { ok: true } : { ok: false, retryAt: due }
  }

  function evaluate() {
    if (disposed) return
    const t = now()
    for (const id of handled) if (!store.get(id)) handled.delete(id)
    const open = store.list({ status: 'open' }).filter((i) => TYPES.has(i.type))
    let wake = Infinity
    const fresh = []
    for (const item of open) {
      if (handled.has(item.id)) continue
      const r = ready(item, t)
      if (r.ok) fresh.push(item)
      else if (r.retryAt !== undefined) wake = Math.min(wake, r.retryAt)
    }
    if (fresh.length) {
      const holdUntil = presence() + holdMs
      if (t < holdUntil) wake = Math.min(wake, holdUntil)
      else { fresh.forEach((i) => handled.add(i.id)); dispatch(fresh, open, t) }
    }
    if (wake !== Infinity) schedule(wake)
  }

  const deliver = async (record, payload, urgency, what) => {
    try { return (await push.send(record.id, payload, { ttl: TTL_SEC, urgency, topic: payload.tag })).ok } catch { log('push ' + what + ' failed'); return false }
  }

  function dispatch(fresh, open, t) {
    const types = [...new Set(fresh.map((i) => i.type))]
    for (const record of push.devices()) {
      for (const type of types.filter((ty) => record.types?.[ty] !== false)) {
        if (!BREAKS_QUIET.has(type) && quietEndsAt(record.quiet, t) !== undefined) hold(record, fresh.filter((i) => i.type === type), t)
        else void announce(record, type, open)
      }
    }
  }

  async function announce(record, type, open) {
    const items = open.filter((i) => i.type === type)
    const payload = { title: WORDS[type].title, body: count(items.length), tag: type, url: items.length === 1 ? '#/item/' + items[0].id : '#/' }
    const ok = await deliver(record, payload, WORDS[type].urgency, type)
    log('push ' + type + ' (' + items.length + (items.length === 1 ? ' item' : ' items') + '): ' + (ok ? 'sent' : 'not delivered'))
  }

  function hold(record, items, t) {
    const entry = digests.get(record.id) ?? { ids: new Set(), timer: undefined }
    items.forEach((i) => entry.ids.add(i.id))
    digests.set(record.id, entry)
    timers.clearTimeout(entry.timer)
    entry.timer = timers.setTimeout(() => flushDigest(record.id), Math.max(0, quietEndsAt(record.quiet, t) - t))
    entry.timer.unref?.()
  }

  async function flushDigest(recordId) {
    const entry = digests.get(recordId)
    digests.delete(recordId)
    const record = push.devices().find((d) => d.id === recordId)
    if (disposed || !entry || !record) return
    const waiting = [...entry.ids].map((id) => store.get(id)).filter((i) => i?.status === 'open')
    const parts = DIGEST_WORDS.map(([type, words]) => [waiting.filter((i) => i.type === type).length, words]).filter(([n]) => n > 0).map(([n, words]) => n + ' ' + words)
    if (!parts.length) return
    const ok = await deliver(record, { title: 'Task list', body: parts.join(', ') + ' waiting', tag: 'digest', url: '#/' }, 'normal', 'digest')
    log('push digest (' + waiting.length + ' items): ' + (ok ? 'sent' : 'not delivered'))
  }

  const off = store.onChange(() => schedule(now() + coalesceMs))
  return {
    /** Stops listening and cancels everything pending. */
    dispose() {
      disposed = true
      off()
      timers.clearTimeout(evalTimer)
      for (const entry of digests.values()) timers.clearTimeout(entry.timer)
      digests.clear()
    },
  }
}
