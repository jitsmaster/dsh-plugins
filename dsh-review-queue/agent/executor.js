/**
 * Runs the hub's commands (docs/hub.md 6.2) against this app's own services, one at a time in the order given, and remembers the
 * last 200 results by cid: a command delivered again after a lost response gets the same answer and does not run twice.
 * Nothing here throws; a failure is the answer { ok: false, error }.
 */
const CACHE_SIZE = 200

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
    reply: (c) => queue.reply(c.itemId, c.args.text),
    archive: (c) => queue.archive(c.itemId),
    'todo-suggest': (c) => queue.addTodo(c.args.text, { sparc: c.args.sparc, workspaces: c.args.workspaces }),
    'todo-cancel': (c) => queue.cancelTodo(c.itemId),
    'open-session': (c) => (typeof openSession === 'function' ? openSession(c.args.sessionId) : { ok: false, error: 'no-controller' }),
    apply: (c) => adapter.applyRemote(c.args.change),
    'todo-start'(c) {
      if (c.args.item) adapter.adopt(c.args.item) // an item moved here by the hub
      if (c.itemId) return queue.confirmTodo(c.itemId, { workspaceId: c.args.workspaceId })
      return queue.addTodo(c.args.text, { workspaceId: c.args.workspaceId, sparc: c.args.sparc })
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
