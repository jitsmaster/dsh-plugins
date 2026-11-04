/**
 * Evidence for question triage: what the USER wrote earlier in the session, read from the session thread. Only user messages are ever quotable
 * evidence; assistant text never is (the judged agent could plant its own basis there). Never throws: any problem means no sources, so no quote is admissible.
 */
const MAX_SOURCES = 8
const DEFAULT_LIMIT = 40

/**
 * @param {(opts: { sessionId: string, limit: number }) => any} threadOf the thread reader (sync or async), as index.js passes it to the queue
 * @param {{ limit?: number }} [opts] how many thread messages to read (the newest user messages among them become the sources)
 * @returns {(item: { sessionId?: string }) => Promise<{ id: string, text: string, userAuthored: true }[]>}
 */
export function userSourcesFromThread(threadOf, { limit = DEFAULT_LIMIT } = {}) {
  return async (item) => {
    const sessionId = item?.sessionId
    if (typeof sessionId !== 'string' || !sessionId || typeof threadOf !== 'function') return []
    try {
      const out = await threadOf({ sessionId, limit })
      if (!out || out.ok === false || !Array.isArray(out.messages)) return []
      return out.messages
        .filter((m) => m && m.role === 'user' && typeof m.text === 'string' && m.text.trim())
        .reverse() // newest first, so the cap keeps the freshest requests
        .slice(0, MAX_SOURCES)
        .map((m) => ({ id: 'user-' + m.id, text: m.text, userAuthored: true }))
    } catch { return [] }
  }
}


/**
 * Default sourcesOf: only question items read the thread (other types never use sources, so skip the cost).
 * @param {(opts: { sessionId: string, limit: number }) => any} threadOf
 * @param {{ limit?: number }} [opts]
 */
export function sourcesForItem(threadOf, opts) {
  const fromThread = userSourcesFromThread(threadOf, opts)
  return async (item) => (item?.type === 'question' ? fromThread(item) : [])
}