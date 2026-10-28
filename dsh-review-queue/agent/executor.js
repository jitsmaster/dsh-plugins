/**
 * Runs the hub's commands (docs/hub.md 6.2) against this app's own services, one at a time in the order given, and remembers the
 * last 200 results by cid: a command delivered again after a lost response gets the same answer and does not run twice.
 * `thread`, `sessions-list` and `model-efforts` are the exception: they only read and may run any number of times, so they run at once (a slow log read never delays an approve behind
 * them) and their results are not kept (a chat page would push the results that matter out of the 200).
 * Nothing here throws; a failure is the answer { ok: false, error }.
 */
import { SESSIONS_LIMIT, cleanSessions } from '../follow-up-shared.js'

const CACHE_SIZE = 200
/** Reads: they run at once and their results are not kept. */
const READS = new Set(['thread', 'sessions-list', 'model-efforts'])

/**
 * @param {{ queue: any, adapter: any, openSession?: (sessionId: string) => Promise<any>, cacheSize?: number }} deps
 *   queue: the local review queue service; adapter: the store adapter (adopt, applyRemote); openSession: shows a session of this app.
 */
export function createExecutor({ queue, adapter, openSession, cacheSize = CACHE_SIZE }) {
  const cache = new Map() // cid -> Promise<result>
  let chain = Promise.resolve()

  const handlers = {
    answer: (c) => queue.answer(c.itemId, c.args.answers),
    'late-answer': (c) => queue.lateAnswer(c.itemId, c.args.answers),
    approve: (c) => queue.approve(c.itemId, c.args),
    'approve-similar': (c) => queue.approveSimilar(c.itemId, c.args),
    deny: (c) => queue.deny(c.itemId),
    reply: (c) => (c.args.images !== undefined ? queue.reply(c.itemId, c.args.text, { images: c.args.images }) : queue.reply(c.itemId, c.args.text)),
    thread: (c) => queue.thread(c.itemId, c.args),
    post: (c) => queue.post(c.itemId, c.args.text, { key: c.args.key }),
    archive: (c) => queue.archive(c.itemId),
    'archive-session': (c) => queue.archiveSession(c.itemId),
    'paused-resume': (c) => queue.resumePaused(c.itemId),
    'paused-dismiss': (c) => queue.dismissPaused(c.itemId),
    hold: (c) => queue.holdItem(c.itemId, { reason: c.args.reason }),
    'hold-release': (c) => queue.releaseHold(c.itemId),
    'hold-continue': (c) => queue.continueHold(c.itemId),
    'todo-suggest': (c) => queue.addTodo(c.args.text, { sparc: c.args.sparc, ...(c.args.effort !== undefined ? { effort: c.args.effort } : {}), workspaces: c.args.workspaces, ...(c.args.images !== undefined ? { images: c.args.images } : {}) }),
    'todo-cancel': (c) => queue.cancelTodo(c.itemId),
    // Follow-up todo: this app's candidates (a read), the follow-up item with the hub's union of sessions, and the send of its message (an item moved here is adopted first).
    // args.snippets false: the hub is not after the snippets (yet: a ticket number of the words may decide without them).
    'model-efforts': () => queue.modelEfforts(),
    'sessions-list': async (c) => ({ ok: true, sessions: cleanSessions(await (c.args.snippets === false ? queue.followUpSessions({ snippets: false }) : queue.followUpSessions())).slice(0, SESSIONS_LIMIT) }),
    'followup-suggest': (c) => queue.addTodo(c.args.text, { followUp: c.args.followUp, sessions: c.args.sessions, ...(c.args.images !== undefined ? { images: c.args.images } : {}), ...(c.args.skippedApps ? { skippedApps: c.args.skippedApps } : {}) }),
    'followup-send'(c) {
      if (c.args.item) adapter.adopt(c.args.item)
      return queue.confirmTodo(c.itemId, { sessionId: c.args.sessionId })
    },
    'open-session': (c) => (typeof openSession === 'function' ? openSession(c.args.sessionId) : { ok: false, error: 'no-controller' }),
    apply: (c) => adapter.applyRemote(c.args.change),
    'todo-start'(c) {
      if (c.args.item) adapter.adopt(c.args.item) // an item moved here by the hub
      if (c.itemId) return queue.confirmTodo(c.itemId, { workspaceId: c.args.workspaceId })
      return queue.addTodo(c.args.text, { workspaceId: c.args.workspaceId, sparc: c.args.sparc, ...(c.args.effort !== undefined ? { effort: c.args.effort } : {}), ...(c.args.images !== undefined ? { images: c.args.images } : {}) })
    },
  }

  async function run(cmd) {
    const handler = Object.hasOwn(handlers, cmd?.kind) ? handlers[cmd.kind] : undefined
    if (!handler) return { ok: false, error: 'unknown-command' }
    try {
      const result = await handler({ ...cmd, args: cmd.args ?? {} })
      return result && typeof result === 'object' && typeof result.ok === 'boolean' ? result : { ok: false, error: 'failed' }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 200) }
    }
  }

  return {
    /** @returns {Promise<{ ok: boolean, error?: string }>} */
    execute(cmd) {
      if (READS.has(cmd?.kind)) return run(cmd)
      const known = cache.get(cmd?.cid)
      if (known) return known
      const result = chain.then(() => run(cmd))
      chain = result
      if (cmd?.cid !== undefined) {
        cache.set(cmd.cid, result)
        if (cache.size > cacheSize) cache.delete(cache.keys().next().value)
      }
      return result
    },
  }
}
