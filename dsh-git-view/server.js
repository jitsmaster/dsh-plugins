/**
 * Loopback HTTP API consumed by lib/client.js.
 *
 * Security model (the API exposes source code, so it is deliberately narrow):
 *  - binds 127.0.0.1 only;
 *  - every request must carry the DSH web page's Origin and a loopback Host (blocks other web pages and
 *    DNS rebinding);
 *  - the browser names a *session*, never a path. Directories come from SessionRegistry.resolve();
 *  - file paths are repo-relative, validated, and only ever passed to git after `--`;
 *  - strictly read-only: no route changes the repository, and the browser cannot choose the branch or worktree.
 */
import { createServer } from 'node:http'
import {
  gitSaturated, readBranchCompare, readCommit, readDiff, readHistory, readSide, readStatus, withGitSignal,
} from './git.js'

export const GIT_VIEW_PORT = 3082
const STATUS_TTL_MS = 700

/** Collapse concurrent identical reads and keep the answer for a moment: the UI polls, several tabs may too. */
export function memo(fn) {
  const cache = new Map()
  const call = (key, ...args) => {
    const hit = cache.get(key)
    // `at` stays undefined while the load is pending (concurrent callers share it however slow git is) and is
    // stamped on success, so the answer is reused for one TTL after it arrived.
    if (hit && (hit.at === undefined || Date.now() - hit.at < STATUS_TTL_MS)) return hit.promise
    // A synchronous throw from `fn` becomes a rejection like any other failure.
    const promise = (async () => fn(...args))()
    const entry = { at: undefined, promise }
    cache.set(key, entry)
    const evict = () => { if (cache.get(key) === entry) cache.delete(key) }
    // then(a, b) with both handlers: no derived promise is left to reject unhandled (finally() would leave one
    // that crashes the host). A failure is evicted at once so the next poll retries; a success lingers for the TTL.
    promise.then(() => { entry.at = Date.now(); setTimeout(evict, STATUS_TTL_MS + 50).unref?.() }, evict)
    return promise
  }
  return call
}

const json = (res, code, body) => {
  if (res.destroyed) return // the client went away; nothing to answer
  const data = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(data)
}

/**
 * @param {{ registry: ReturnType<import('./sessions.js').createSessionRegistry>, logger: { warn: Function }, signal?: AbortSignal,
 *   port?: number, webUrl?: string }} opts
 */
export function startServer({ registry, logger, signal, port = GIT_VIEW_PORT, webUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080' }) {
  const web = new URL(webUrl)
  const allowedOrigins = new Set([...['127.0.0.1', 'localhost'].map(h => `${web.protocol}//${h}:${web.port}`), web.origin])
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

  // Memoised reads are shared between requests, so they must never be bound to one client's abort signal.
  const shared = (fn) => (...a) => withGitSignal(undefined, () => fn(...a))
  const statusOf = memo(shared((root) => readStatus(root)))
  const compareOf = memo(shared((root, branch) => readBranchCompare(root, branch)))

  // Every route resolves the session (rev-parse, and a worktree list for snapshots): share that across the
  // burst of requests one UI refresh makes. Separate entries because only the snapshot needs the list.
  const resolveOf = memo(shared((id, opts) => registry.resolve(id, opts)))
  const resolveCached = (id, cwdHint, worktrees) => resolveOf(`${worktrees ? 'w' : 'l'}\0${id}\0${cwdHint ?? ''}`, id, { cwdHint, worktrees })

  /** Branch compare for a status; the one memoised read both the snapshot and the base-derived routes use. */
  const compareFor = (target, status) =>
    compareOf(`c:${target.root}:${status.branch.name ?? ''}`, target.root, status.branch.name)

  /** The base ref diffs are taken against: always the server's own compare, never a client-supplied ref. */
  async function serverBase(target) {
    const status = await statusOf(`s:${target.root}`, target.root)
    if (!status.ok || status.branch.unborn) return undefined
    const cmp = await compareFor(target, status)
    return cmp.ok ? cmp.baseRef : undefined
  }

  /** Everything the Source Control tab shows, in one round trip. */
  async function snapshot(target) {
    const status = await statusOf(`s:${target.root}`, target.root)
    const view = {
      ok: status.ok,
      sessionCwd: target.cwd,
      repoRoot: target.cwdRoot,
      source: target.source,
      recorded: target.recorded,
      worktrees: target.worktrees.map(w => ({ ...w, current: w.path === target.root, sessionCwd: w.path === target.cwdRoot })),
      status,
    }
    if (status.ok && !status.branch.unborn) {
      view.compare = await compareFor(target, status)
    }
    return view
  }

  async function handle(req, res, url) {
    const q = url.searchParams
    // DoS guard: the git process queue is full, so shed load instead of piling up more work.
    if (gitSaturated()) { res.setHeader('Retry-After', '1'); return json(res, 429, { ok: false, error: 'busy: too many concurrent git requests' }) }
    // View-only: the tree shown is decided by the session alone (recorded worktree, else its folder).
    const target = await resolveCached(q.get('session'), q.get('cwd') ?? undefined, url.pathname === '/v1/snapshot')
    if (!target.ok) return json(res, 200, { ok: false, error: target.error, sessionCwd: target.cwd })
    const root = target.root

    switch (url.pathname) {
      case '/v1/snapshot':
        return json(res, 200, await snapshot(target))

      case '/v1/commit':
        return json(res, 200, await readCommit(root, q.get('sha') ?? ''))

      case '/v1/diff': {
        const context = q.has('context') ? Number(q.get('context')) : undefined
        const scope = q.get('scope') ?? ''
        const out = await readDiff(root, {
          // `base` from the query string is deliberately ignored: the compare base is the server's.
          scope, path: q.get('path') ?? undefined, origPath: q.get('origPath') ?? undefined, base: scope === 'branch' ? await serverBase(target) : undefined, sha: q.get('sha') ?? undefined, context,
          ignoreWs: q.get('ws') === '1',
        })
        // Busy is a load-shedding signal for the client to retry, not a content error.
        if (out.busy || (!out.ok && gitSaturated())) { res.setHeader('Retry-After', '1'); return json(res, 429, { ok: false, error: 'busy: too many concurrent git requests' }) }
        return json(res, 200, out)
      }

      case '/v1/history':
        return json(res, 200, await readHistory(root, Number(q.get('limit') ?? 50)))

      case '/v1/blob': {
        const scope = q.get('scope') ?? ''
        const out = await readSide(root, {
          scope, path: q.get('path') ?? '', side: q.get('side') === 'old' ? 'old' : 'new', base: scope === 'branch' ? await serverBase(target) : undefined, sha: q.get('sha') ?? undefined,
        })
        if (!out.ok) return json(res, 200, out)
        if (out.missing) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end() }
        res.writeHead(200, { 'Content-Type': out.mime, 'Cache-Control': 'no-store', 'Content-Length': out.data.length, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" })
        return res.end(out.data)
      }

      default:
        return json(res, 404, { ok: false, error: 'not found' })
    }
  }

  const server = createServer((req, res) => {
    const origin = req.headers.origin
    if (!origin || !allowedOrigins.has(origin) || !allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) {
      res.statusCode = 403
      return res.end()
    }
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }
    // Read-only API: anything that could be read as a mutation is refused before routing.
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD, OPTIONS'); res.statusCode = 405; return res.end() }
    let url
    try { url = new URL(req.url ?? '/', `http://${req.headers.host}`) } catch { res.statusCode = 400; return res.end() }
    // Abort git work (queued jobs are skipped, running children killed) when the client disconnects early.
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    withGitSignal(abort.signal, () => handle(req, res, url)).catch((error) => {
      logger.warn(`git-view: ${url.pathname} failed: ${String(error?.stack ?? error)}`)
      if (!res.headersSent) json(res, 500, { ok: false, error: String(error?.message ?? error) })
      else res.end()
    })
  })
  server.on('error', error => logger.warn(`git-view: server failed on 127.0.0.1:${port}: ${String(error)}`))
  server.listen(port, '127.0.0.1')
  signal?.addEventListener('abort', () => { server.close(); server.closeAllConnections?.() }, { once: true })
  return { server, close: () => server.close(), allowedOrigins }
}
