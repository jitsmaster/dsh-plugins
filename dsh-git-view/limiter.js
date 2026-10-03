/**
 * Concurrency limiter for git child processes (performance / DoS fix): at most `max` run at once, up to
 * `queueCap` more wait, and anything beyond that is rejected immediately instead of piling up processes.
 */
export class BusyError extends Error {
  constructor() { super('git-view busy: too many concurrent git requests'); this.code = 'EBUSY'; this.status = 429 }
}

/** A queued job was cancelled (its client went away) before it started. */
export class AbortedError extends Error {
  constructor() { super('git-view: request aborted'); this.code = 'ABORT_ERR' }
}

export function createLimiter(max = 4, queueCap = 64) {
  let running = 0
  const queue = []
  const next = () => {
    while (running < max && queue.length) {
      const job = queue.shift()
      job.cleanup?.()
      // A job whose client already disconnected is skipped without spawning anything.
      if (job.signal?.aborted) { job.reject(new AbortedError()); continue }
      running++
      job.task().then(job.resolve, job.reject).then(() => { running--; next() })
    }
  }
  return {
    /** Run `task` when a slot is free; rejects with BusyError when the queue is full, AbortedError when `signal` fires while queued. */
    run(task, signal) {
      if (signal?.aborted) return Promise.reject(new AbortedError())
      if (running >= max && queue.length >= queueCap) return Promise.reject(new BusyError())
      return new Promise((resolve, reject) => {
        const job = { task, resolve, reject, signal, cleanup: undefined }
        if (signal) {
          // Drop a cancelled job from the queue at once so it stops counting against the queue cap.
          const onAbort = () => {
            const i = queue.indexOf(job)
            if (i >= 0) { queue.splice(i, 1); reject(new AbortedError()) }
          }
          signal.addEventListener('abort', onAbort, { once: true })
          job.cleanup = () => signal.removeEventListener('abort', onAbort)
        }
        queue.push(job)
        next()
      })
    },
    /** True when a new job would be rejected. */
    saturated: () => running >= max && queue.length >= queueCap,
    stats: () => ({ running, queued: queue.length }),
  }
}
