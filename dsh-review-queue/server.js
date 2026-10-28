/**
 * HTTP API for the browser half, mounted under /review-queue on the Host web server (which owns the Host / Origin /
 * cookie fence, see index.js). createRouter returns a plain (req, res) handler so tests can run it on a bare http
 * server. Reads are a long-poll on the snapshot id; actions are small JSON POSTs.
 */
import { serveMobile } from './mobile.js'
import { serveTipWindow } from './tip-window.js'
import { sessionsKey, archKeyOf } from './sessions.js'
import { MAX_IMAGE_BYTES } from './todo-images.js'

export const PREFIX = '/review-queue'
const MAX_BODY = 64 * 1024
export const MAX_WAIT_MS = 25_000

export const send = (res, code, body) => {
  if (res.destroyed) return
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

export async function readJson(req, max = MAX_BODY) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return { status: 415 }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) return { status: 413 }
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { status: 400 }
  } catch { return { status: 400 } }
}

/** One raw image body (POST /v1/todo-image): { value: Buffer } | { status } (415 not an image type, 413 over the cap). */
async function readImage(req, max = MAX_IMAGE_BYTES) {
  if (!/^image\/[a-z0-9.+-]+\s*$/i.test(req.headers['content-type'] ?? '')) return { status: 415 }
  if (Number(req.headers['content-length']) > max) return { status: 413 }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) return { status: 413 }
    chunks.push(chunk)
  }
  return { value: Buffer.concat(chunks) }
}

// Logical outcomes: malformed input is a 400, a request that cannot apply now (gone, already answered) is a 409.
const BAD_INPUT = new Set(['bad-images', 'bad-effort', 'too-many-images', 'unknown-image', 'bad-image', 'too-large', 'bad-answer', 'bad-decision', 'empty', 'too-long', 'bad-command', 'needs-confirm', 'needs-hold', 'unknown-workspace', 'no-workspace', 'empty-query', 'unknown-session'])
// 'no-session' is a 409 for a reply or an archive (this app's controller does not know the session) but a 400 for a follow-up confirm with no session to send to.
export const CONFIRM_BAD_INPUT = new Set(['no-session'])
// The hub's answer when the owning app did not report back in time: a gateway timeout, not a refusal.
const GATEWAY = new Set(['owner-timeout', 'unknown-outcome'])
export const outcome = (res, result, alsoBad) => {
  if (result?.ok) return send(res, 200, { ...result })
  send(res, GATEWAY.has(result?.error) ? 504 : BAD_INPUT.has(result?.error) || alsoBad?.has(result?.error) ? 400 : 409, { ok: false, error: result?.error ?? 'failed', ...(typeof result?.warning === 'string' ? { warning: result.warning.slice(0, 200) } : {}) })
}

/**
 * The long-poll token. The four old parts are "<snapshotId>|<focusId>|<readingId>|<uiSeq>" (missing parts mean "none", ui seq 0; a token from before the
 * ui part existed matches only while no ui command has been given, else it gets a full snapshot). A client that knows the session numbers and the tip
 * adds two more: "...|<working>/<open>|<tipId>", and a newer one a seventh, the archKey (which open items may be archived with one click). Only the parts the client sent are compared (stampMatches), so an older page never gets a full
 * snapshot for a part it cannot know about, while a newer one wakes when the numbers or the tip change. None of them touches the snapshotId.
 */
export const parseSince = (raw) => {
  if (raw === undefined) return undefined
  const parts = raw.split('|')
  const head = [0, 1, 2, 3].map((i) => (i === 3 && !parts[i] ? '0' : parts[i] ?? ''))
  return head.concat(parts.slice(4, 7)).join('|')
}
export const stampOf = (s) => s.snapshotId + '|' + (s.focusId ?? '') + '|' + (s.reading ?? '') + '|' + (s.ui?.seq ?? 0)
export { archKeyOf }
export const fullStampOf = (s) => stampOf(s) + '|' + sessionsKey(s.sessions) + '|' + (s.tip?.id ?? '') + '|' + (s.archKey ?? '')
/** True when the snapshot is what the client (a parseSince token) has already seen, judged on the parts the client sent. */
export const stampMatches = (s, since) => {
  const want = fullStampOf(s).split('|')
  // A snapshot without a key (the hub's own, which does not know the flags) is not held to the 7th part.
  return since.split('|').every((p, i) => (i === 6 && s.archKey === undefined) || p === want[i])
}

const workspaceOf = (b) => (b.workspaceId === undefined || b.workspaceId === null || b.workspaceId === '' ? undefined : String(b.workspaceId))
const sessionOf = (b) => (b.sessionId === undefined || b.sessionId === null || b.sessionId === '' ? undefined : String(b.sessionId))

/** @param {{ queue: ReturnType<import('./service.js').createReviewQueue>, dev?: { ask: (body: object) => Promise<object> }, pushRoutes?: ReturnType<import('./push-routes.js').createPushRoutes> }} deps */
export function createRouter({ queue, dev, pushRoutes }) {
  const actions = {
    '/v1/answer': (b) => queue.answer(String(b.id), b.answers),
    '/v1/late-answer': (b) => queue.lateAnswer(String(b.id), b.answers),
    '/v1/approve': (b) => queue.approve(String(b.id), { via: b.via, confirmed: b.confirmed === true, held: b.held === true }),
    '/v1/deny': (b) => queue.deny(String(b.id)),
    '/v1/reviewed': (b) => queue.markReviewed(String(b.id)),
    '/v1/archive': (b) => queue.archive(String(b.id)),
    '/v1/archive-session': (b) => queue.archiveSession(String(b.id)),
    '/v1/reply': (b) => queue.reply(String(b.id), b.text, { images: b.images }),
    '/v1/thread': (b) => queue.thread(String(b.id), { before: b.before, limit: b.limit, after: b.after }),
    '/v1/post': (b) => queue.post(String(b.id), b.text, { key: b.key }),
    '/v1/read': (b) => queue.read(String(b.id)),
    '/v1/read-tip': (b) => queue.readTip(String(b.id)),
    '/v1/tip-next': (b) => queue.nextTip({ topic: typeof b.topic === 'string' ? b.topic : undefined }),
    '/v1/tip-current': () => queue.currentTip(),
    '/v1/tip-peek': () => queue.peekTip(),
    '/v1/tip-deeper': (b) => queue.tipDeeper(String(b.id)),
    '/v1/tip-todo': (b) => queue.tipTodo(String(b.id), workspaceOf(b)),
    '/v1/stop': () => queue.stop(),
    '/v1/ui': (b) => queue.uiCommand(b.cmd),
    '/v1/reopen': (b) => queue.reopen(String(b.id)),
    '/v1/approve-similar': (b) => queue.approveSimilar(String(b.id), { via: b.via, confirmed: b.confirmed === true }),
    '/v1/paused-resume': (b) => queue.resumePaused(String(b.id)),
    '/v1/paused-dismiss': (b) => queue.dismissPaused(String(b.id)),
    '/v1/paused-scan': () => queue.scanPaused(),
    '/v1/hold': (b) => queue.holdItem(String(b.id), { reason: b.reason }),
    '/v1/hold-release': (b) => queue.releaseHold(String(b.id)),
    '/v1/hold-continue': (b) => queue.continueHold(String(b.id)),
    '/v1/running-sessions': () => queue.runningSessions(),
    '/v1/todo': (b) => queue.addTodo(b.text, { workspaceId: workspaceOf(b), sparc: b.sparc === true, effort: b.effort, followUp: b.followUp, images: b.images }), // never body.sessions: the candidates are this app's own (the hub gives the union)
    '/v1/todo-tune': (b) => queue.tuneTodo(b.text),
    '/v1/todo-confirm': (b) => queue.confirmTodo(String(b.id), { workspaceId: workspaceOf(b), sessionId: sessionOf(b) }),
    '/v1/todo-cancel': (b) => queue.cancelTodo(String(b.id)),
    '/v1/focus': (b) => (queue.setFocus(b.id === null || b.id === undefined ? undefined : String(b.id)) ? { ok: true } : { ok: false, error: 'not-open' }),
  }
  if (dev) actions['/v1/dev/ask'] = (b) => dev.ask(b)

  async function snapshot(req, res, url) {
    const since = parseSince(url.searchParams.get('since') ?? undefined)
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), MAX_WAIT_MS)
    // The tip is only for an open overlay (tip=1): any other poll (overlay closed, the phone) neither gets one nor starts a model call. The phone and an
    // open overlay look at the session numbers.
    const tip = url.searchParams.get('tip') === '1'
    const watch = tip || url.searchParams.get('client') === 'phone'
    const current = () => queue.snapshot({ tip, watch })
    const unchanged = () => {
      if (since === undefined) return undefined
      const s = current()
      return stampMatches(s, since) ? s : undefined
    }
    const first = unchanged()
    if (!first) return send(res, 200, current())
    if (wait === 0) return send(res, 200, { unchanged: true, snapshotId: first.snapshotId })
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); off(); offNumbers?.(); req.off('close', done); resolve() }
      const timer = setTimeout(done, wait)
      const off = queue.onChange(done)
      const offNumbers = queue.onSessionsChange?.(done) // this app's numbers are what this poll serves
      req.once('close', done)
    })
    const now = unchanged()
    send(res, 200, now ? { unchanged: true, snapshotId: now.snapshotId } : current())
  }

  return async function serve(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://local')
      if (await serveMobile(req, res, url.pathname)) return
      if (await serveTipWindow(req, res, url.pathname)) return
      if (url.pathname === '/v1/snapshot') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' })
        return await snapshot(req, res, url)
      }
      if (url.pathname === '/v1/workspaces') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' })
        return send(res, 200, { workspaces: queue.workspaces() })
      }
      if (url.pathname === '/v1/model-efforts') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' })
        return send(res, 200, await queue.modelEfforts())
      }
      if (url.pathname === '/v1/follow-up-sessions') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' })
        return send(res, 200, { sessions: await queue.followUpSessions({ snippets: false }) })
      }
      if (url.pathname === '/v1/todo-image') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method' })
        const image = await readImage(req)
        if (!image.value) return send(res, image.status, image.status === 413 ? { ok: false, error: 'too-large' } : { error: 'bad-request' })
        return outcome(res, queue.saveTodoImage(image.value))
      }
      if (pushRoutes && url.pathname.startsWith('/v1/push/')) return await pushRoutes(req, res, url.pathname, { readJson, send })
      const action = actions[url.pathname]
      // An unknown route is not a missing item (that is a 409 'not-found' from the service): a client newer than this server
      // must be able to tell "I do not know this action" from "that item is gone".
      if (!action) return send(res, 404, { error: 'unknown-action' })
      if (req.method !== 'POST') return send(res, 405, { error: 'method' })
      const body = await readJson(req)
      if (!body.value) return send(res, body.status, { error: 'bad-request' })
      return outcome(res, await action(body.value), url.pathname === '/v1/todo-confirm' ? CONFIRM_BAD_INPUT : undefined)
    } catch (error) {
      send(res, 500, { error: 'internal' })
    }
  }
}
