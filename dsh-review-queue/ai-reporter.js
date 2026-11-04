/**
 * The hourly AI report timer: every interval it builds the report for the period since the last one (ai-report.js) and says it through the speaker and
 * the chat channel. { lastTickAt } is kept in a state file, so a restart neither repeats nor skips a period (the catch-up is capped at 24 h). A period with
 * nothing to tell is silent. Each channel is best effort: a failure is logged (redacted) and never reaches the caller or the other channel.
 */
import { buildReport, reportText } from './ai-report.js'
import { redact } from './triage-log.js'

export const REPORT_INTERVAL_MS = 3600_000
const CATCH_UP_DELAY_MS = 60_000
const MAX_CATCH_UP_MS = 24 * 3600_000

/**
 * @param {{ store: { list: () => object[] }, triageLog?: { entries: (o: object) => object[] }, speaker?: { speak: Function }, notify?: (text: string) => Promise<void>,
 *   now?: () => number, intervalMs?: number, io?: { read: () => string|undefined, write: (t: string) => void }, enabled?: () => boolean,
 *   channels?: { voice?: boolean, chat?: boolean }, log?: (m: string) => void }} deps
 */
export function createAiReporter({ store, triageLog, speaker, notify, now = Date.now, intervalMs = REPORT_INTERVAL_MS, io, enabled = () => true, channels = {}, log = () => {}, setTimeoutFn = setTimeout, catchUpDelayMs = CATCH_UP_DELAY_MS }) {
  let last
  let running = false
  let timer
  let catchUp
  const fail = (what, error) => log('ai-report: ' + what + ' failed: ' + redact(error?.message ?? error)) // redacted: a channel error may quote a credential

  const windowStart = (to) => {
    let at
    try { at = JSON.parse(io?.read() ?? '').lastTickAt } catch { /* corrupt or missing: the last interval */ }
    return typeof at === 'number' && at < to ? Math.max(at, to - MAX_CATCH_UP_MS) : to - intervalMs
  }
  const isStale = () => {
    let at
    try { at = JSON.parse(io?.read() ?? '').lastTickAt } catch { /* corrupt or missing: stale */ }
    return typeof at !== 'number' || now() - at > intervalMs
  }
  const send = async (text) => {
    if (channels.voice !== false && speaker) { try { speaker.speak([text]) } catch (e) { fail('voice channel', e) } }
    if (channels.chat !== false && notify) { try { await notify(text) } catch (e) { fail('chat channel', e) } }
  }

  /** One period. Returns the report (with its text) or undefined when disabled, already running, or the items could not be read. */
  async function tick() {
    if (running || !enabled()) return undefined
    running = true
    try {
      const to = now()
      const from = windowStart(to)
      let items
      try { items = store.list() } catch (e) { fail('items', e); return undefined }
      let entries = []
      try { entries = triageLog?.entries({ since: from, until: to }) ?? [] } catch (e) { fail('triage log', e) }
      const report = buildReport({ items, entries, from, to })
      last = { ...report, text: reportText(report) }
      // lastTickAt is written before the send on purpose: a failed channel loses this period (best effort, no resend).
      try { io?.write(JSON.stringify({ lastTickAt: to })) } catch (e) { fail('state write', e) }
      if (report.total > 0 || report.overruled > 0) await send(last.text)
      return last
    } finally { running = false }
  }

  return {
    tick,
    /** The latest report with its text, undefined before the first tick. */
    last: () => last,
    start() {
      if (timer) return
      timer = setInterval(() => { void tick() }, intervalMs); timer.unref?.()
      // A restart more often than hourly would never reach the first interval: one early tick covers [lastTickAt, now).
      if (isStale()) { catchUp = setTimeoutFn(() => { catchUp = undefined; return tick() }, catchUpDelayMs); catchUp.unref?.() }
    },
    stop() { clearInterval(timer); timer = undefined; clearTimeout(catchUp); catchUp = undefined },
  }
}
