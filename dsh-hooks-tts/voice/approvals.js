/**
 * Lets a spoken "approve" / "deny" answer a pending permission request. It sits in the approval/request waterfall:
 * the GUI's own answerer is awaited through next(), and whichever answers first wins. Off = a pure pass-through.
 */
/**
 * summaryOf(req) -> { text, complete }: a bounded, speakable summary of what the request will do (headline.js toolSummaryInfo of the
 * tool input) and whether it is complete (only then may voice APPROVE it); a bare string counts as text of unknown completeness,
 * i.e. incomplete. It is taken once, when the request arrives, and handed to peek() so the read-back can say what is being approved.
 */
export function createVoiceApprovals({ enabled = () => false, summaryOf } = {}) {
  const waiting = [] // { sessionId, toolName, summary, complete, settle }

  const drop = (entry) => {
    const i = waiting.indexOf(entry)
    if (i >= 0) waiting.splice(i, 1)
  }

  /** A broken or missing summariser must never break approvals: the read-back then says the details are not available. */
  function summarise(req) {
    let r
    try { r = summaryOf?.(req) } catch { return { summary: undefined, complete: false } }
    if (typeof r === 'string') return { summary: r || undefined, complete: false }
    const text = typeof r?.text === 'string' && r.text ? r.text : undefined
    return { summary: text, complete: text !== undefined && r.complete === true }
  }

  return {
    pendingCount: () => waiting.length,
    peek: ({ sessionId }) => {
      const entry = waiting.findLast((w) => w.sessionId === sessionId)
      if (!entry) return undefined
      const count = waiting.filter((w) => w.sessionId === sessionId).length
      return { toolName: entry.toolName, token: entry, summary: entry.summary, complete: entry.complete, count }
    },
    pending: () => waiting.map(({ sessionId, toolName }) => ({ sessionId, toolName })),

    intercept(req, next) {
      if (!enabled()) return next()
      return new Promise((resolve, reject) => {
        const entry = { sessionId: req.agent?.id, toolName: req.toolName, ...summarise(req) }
        let done = false
        const settle = (outcome) => {
          if (done) return
          done = true
          drop(entry)
          resolve(outcome)
        }
        entry.settle = settle
        waiting.push(entry)
        req.signal?.addEventListener('abort', () => settle('cancelled'), { once: true })
        if (req.signal?.aborted) return settle('cancelled')
        Promise.resolve(next()).then(settle, (error) => {
          if (done) return
          done = true
          drop(entry)
          reject(error)
        })
      })
    },

    answer({ sessionId, decision }) {
      if (decision === 'option') throw new Error('Choosing an option is not supported for permission requests')
      const entry = waiting.findLast((w) => w.sessionId === sessionId)
      if (!entry) throw new Error('No pending permission request in that session')
      entry.settle(decision === 'approve' ? 'allowed-once' : 'rejected')
      return { answered: true }
    },
  }
}
