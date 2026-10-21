/**
 * The sessions a Follow-up todo can be sent to ("+ New todo" in Follow-up mode: the text is a message for an EXISTING session, found from
 * the user's plain words). listFollowUpSessions reads this app's session controller the way the session counter does (sessions.js: top level,
 * not blank, not archived) and gives the candidates newest first, each with its title, workspace and, for the newest few, a one-line snippet
 * of its last message. It never throws: any failure gives [] (or the list without titles, workspaces or snippets) and one log line.
 *
 * @typedef {{ sessionId: string, title: string, workspaceId?: string, workspaceTitle?: string, updatedAt?: number, running?: boolean, snippet?: string, owner?: string }} Candidate
 */
import { readdir as listDirectory } from 'node:fs/promises'
import { openSessionItems } from './sessions.js'
import { listWorkspaces } from './todo.js'
import { within } from './summary.js'
import { createThreadCache } from './thread.js'
import { FOLLOW_UP_LIMIT, SESSIONS_APP_BUDGET_MS, codeOf, isSessionIdWords, refNumbersOf, suggestSessionByRef } from './follow-up-shared.js'

export { FOLLOW_UP_LIMIT } // the one session limit (follow-up-shared.js), still exported from here
/** The snippets (the last chat message of a session) decode whole session logs: only the newest few sessions get one. */
export const SNIPPET_LIMIT = 8
export const SNIPPET_CHARS = 120
export const SNIPPET_TIMEOUT_MS = 3000
const LIST_TIMEOUT_MS = 10_000
const LIST_GRACE_MS = 1000 // a list call that ignores its signal is given up this long after the signal's time (when the overall deadline allows)
const TITLES_TIMEOUT_MS = 3000
const UNTITLED = 'Untitled session'
const THREAD_CONCURRENCY = 4
/** The thread cache of the snippet reads (apart from the one the phone's chat uses, which they must not push entries out of): one entry per session they ask about. */
const SNIPPET_CACHE_ENTRIES = SNIPPET_LIMIT

/** Never throws: undefined when fn does; what failed is reported (the error's code or name only: its message can carry a path) when a log is given. */
const safe = (fn, log, what) => { try { return fn() } catch (error) { log?.('follow-up: ' + what + ' failed: ' + codeOf(error)); return undefined } }
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const errorText = (error) => oneLine(error?.message ?? error).slice(0, 120)

/**
 * @param {{ controller?: { list?: Function }, registry?: any, titlesOf?: (ids: string[]) => Promise<Map<string, string>>, snippetsOf?: (ids: string[], signal?: AbortSignal, log?: (line: string) => void) => Promise<Map<string, string>>, archived?: Iterable<string>, query?: string, limit?: number, snippetLimit?: number, log?: (line: string) => void, totalMs?: number, listTimeoutMs?: number, snippetTimeoutMs?: number }} [deps]
 *   totalMs: the one deadline of the whole answer (session list, titles and snippets share it; SESSIONS_APP_BUDGET_MS by default, below the hub's 6 s for the command). A list that has not
 *   answered by then gives []; titles or snippets that are late are left out and the candidates are returned without them.
 *   query: the words the user typed. When they hold a ticket / PR number (refNumbersOf) the titles are read first, and the snippets only when no title decides (the deterministic match
 *   of suggestSessionByRef needs none): reading a snippet decodes a session log. snippetsOf is given an AbortSignal that is aborted when the answer is given or the reader is given up on, and the log (the reader's own, if it was built with one, is used first).
 * @returns {Promise<Candidate[]>}
 */
export async function listFollowUpSessions({ controller, registry, titlesOf, snippetsOf, archived, query, limit = FOLLOW_UP_LIMIT, snippetLimit = SNIPPET_LIMIT, log = () => {}, totalMs = SESSIONS_APP_BUDGET_MS, listTimeoutMs = LIST_TIMEOUT_MS, snippetTimeoutMs = SNIPPET_TIMEOUT_MS } = {}) {
  try {
    if (typeof controller?.list !== 'function') return []
    const deadline = Date.now() + totalMs
    const left = (cap) => Math.max(0, Math.min(cap, deadline - Date.now()))
    const listMs = left(listTimeoutMs)
    const signal = AbortSignal.timeout(listMs)
    const listed = await within(Promise.resolve().then(() => controller.list({}, signal)), Math.min(listMs + LIST_GRACE_MS, left(Infinity)))
    const skip = new Set([...(safe(() => registry?.archivedSessionIds, log, 'archived sessions') ?? []), ...(archived ?? [])].map(String))
    const kept = openSessionItems(listed, skip)
    if (!kept) return []
    const open = kept
      .filter((i) => i.sessionId)
      .map((i, index) => ({ i, index }))
      .sort((a, b) => (Number.isFinite(b.i.updatedAt) ? b.i.updatedAt : -Infinity) - (Number.isFinite(a.i.updatedAt) ? a.i.updatedAt : -Infinity) || a.index - b.index)
      .slice(0, Math.max(0, limit))
      .map((x) => x.i)
    const ids = open.map((i) => i.sessionId)
    const asked = ids.slice(0, Math.max(0, snippetLimit))

    // The titles and the snippets are independent: asked together, each cut off at its own limit or at what is left of the one deadline.
    const optional = async (read, forIds, capMs, what) => {
      if (typeof read !== 'function' || !forIds.length) return new Map()
      const stop = new AbortController() // the reader is told when its answer is no longer wanted (given, or given up on): it must not go on reading
      try { const got = await within(Promise.resolve().then(() => read(forIds, stop.signal, log)), left(capMs)); return got instanceof Map ? got : new Map() } catch (error) { log('follow-up: ' + what + ' failed: ' + codeOf(error)); return new Map() } finally { stop.abort() }
    }
    let titles, snippets
    if (refNumbersOf(query).size || isSessionIdWords(query)) {
      // A number of the words may decide on the titles alone: then no log is read for a snippet.
      titles = await optional(titlesOf, ids, TITLES_TIMEOUT_MS, 'titles')
      const named = open.map((i) => ({ sessionId: i.sessionId, title: oneLine(titles.get(i.sessionId)) }))
      snippets = suggestSessionByRef(query, named) ? new Map() : await optional(snippetsOf, asked, snippetTimeoutMs, 'snippets')
    } else [titles, snippets] = await Promise.all([optional(titlesOf, ids, TITLES_TIMEOUT_MS, 'titles'), optional(snippetsOf, asked, snippetTimeoutMs, 'snippets')])
    const workspaces = listWorkspaces(() => registry) ?? []
    const workspaceOf = (id) => workspaces.find((w) => w.sessionIds.includes(id))

    return open.map((i) => {
      const title = oneLine(titles.get(i.sessionId))
      const ws = workspaceOf(i.sessionId)
      const snippet = asked.includes(i.sessionId) && typeof snippets.get(i.sessionId) === 'string' ? oneLine(snippets.get(i.sessionId)).slice(0, SNIPPET_CHARS) : ''
      return {
        sessionId: i.sessionId,
        title: title || UNTITLED,
        ...(ws ? { workspaceId: ws.id, workspaceTitle: ws.title } : {}),
        ...(Number.isFinite(i.updatedAt) ? { updatedAt: i.updatedAt } : {}),
        running: i.running === true,
        ...(snippet ? { snippet } : {}),
      }
    })
  } catch (error) {
    log('follow-up: session list failed: ' + codeOf(error))
    return []
  }
}

/**
 * The optional snippet reader built on the thread reader (thread.js readThread through index.js threadOf): the newest chat message of each
 * session (limit 1), a few reads at a time. A session that cannot be read is left out. undefined without a thread reader.
 * Cost: every read may decode a whole session log, so (1) the reads use a thread cache of their own (they must not push the phone chat's logs out of the shared one), (2) one listing of
 * the sessions folder serves all the reads of a pass (findSessionLog lists it for every session), (3) the reader stops before each next session once its signal is aborted (the answer
 * has been given, or the time is up). A pass that could not read some sessions logs ONE line (how many, the first error's code); cache, readdir and log can be given.
 * @param {((opts: { sessionId: string, limit: number, cache?: object, fs?: object }) => Promise<any>) | undefined} threadOf
 * @param {{ cache?: object, readdir?: (path: string, opts?: object) => Promise<any>, log?: (line: string) => void }} [deps]
 */
export function snippetsFromThread(threadOf, { cache = createThreadCache({ max: SNIPPET_CACHE_ENTRIES }), readdir = listDirectory, log: ownLog } = {}) {
  if (typeof threadOf !== 'function') return undefined
  return async (ids, signal, passLog) => {
    const log = ownLog ?? passLog
    const out = new Map()
    const failed = []
    const queue = [...ids]
    const listings = new Map() // one listing per folder for this pass
    const fs = { readdir: (path, opts) => { if (!listings.has(path)) listings.set(path, Promise.resolve().then(() => readdir(path, opts))); return listings.get(path) } }
    const worker = async () => {
      while (!signal?.aborted) {
        const id = queue.shift()
        if (id === undefined) return
        try {
          const read = await threadOf({ sessionId: id, limit: 1, cache, fs })
          const text = read?.ok ? read.messages?.at(-1)?.text : undefined
          if (typeof text === 'string' && text.trim()) out.set(id, text)
        } catch (error) { failed.push(codeOf(error)) } // a snippet is a bonus: only the loss is reported, once, below
      }
    }
    await Promise.all(Array.from({ length: Math.min(THREAD_CONCURRENCY, queue.length) }, worker))
    if (failed.length) log?.('follow-up: snippets: ' + failed.length + ' of ' + ids.length + ' session(s) could not be read (' + failed[0] + ')')
    // Keep the order of the ids.
    return new Map(ids.filter((id) => out.has(id)).map((id) => [id, out.get(id)]))
  }
}
