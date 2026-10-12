/**
 * Lets a spoken "approve" / "deny" answer a pending permission request. It sits in the approval/request waterfall:
 * the GUI's own answerer is awaited through next(), and whichever answers first wins. Off = a pure pass-through.
 */
export function createVoiceApprovals({ enabled = () => false } = {}) {
  const waiting = [] // { sessionId, toolName, settle }

  const drop = (entry) => {
    const i = waiting.indexOf(entry)
    if (i >= 0) waiting.splice(i, 1)
  }

  return {
    pendingCount: () => waiting.length,
    pending: () => waiting.map(({ sessionId, toolName }) => ({ sessionId, toolName })),

    intercept(req, next) {
      if (!enabled()) return next()
      return new Promise((resolve, reject) => {
        const entry = { sessionId: req.agent?.id, toolName: req.toolName }
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
