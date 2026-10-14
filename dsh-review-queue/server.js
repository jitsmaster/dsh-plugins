/**
 * HTTP API for the browser half, mounted under /review-queue on the Host web server (which owns the Host / Origin /
 * cookie fence, see index.js). createRouter returns a plain (req, res) handler so tests can run it on a bare http
 * server. Reads are a long-poll on the snapshot id; actions are small JSON POSTs.
 */
export const PREFIX = '/review-queue'
const MAX_BODY = 64 * 1024
const MAX_WAIT_MS = 25_000

const send = (res, code, body) => {
  if (res.destroyed) return
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return { status: 415 }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) return { status: 413 }
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { status: 400 }
  } catch { return { status: 400 } }
}

// Logical outcomes: malformed input is a 400, a request that cannot apply now (gone, already answered) is a 409.
const BAD_INPUT = new Set(['bad-answer', 'bad-decision', 'empty', 'too-long'])
const outcome = (res, result) => {
  if (result?.ok) return send(res, 200, { ok: true })
  send(res, BAD_INPUT.has(result?.error) ? 400 : 409, { ok: false, error: result?.error ?? 'failed' })
}

/** @param {{ queue: ReturnType<import('./service.js').createReviewQueue>, dev?: { ask: (body: object) => Promise<object> } }} deps */
export function createRouter({ queue, dev }) {
  const actions = {
    '/v1/answer': (b) => queue.answer(String(b.id), b.answers),
    '/v1/late-answer': (b) => queue.lateAnswer(String(b.id), b.answers),
    '/v1/approve': (b) => queue.approve(String(b.id)),
    '/v1/deny': (b) => queue.deny(String(b.id)),
    '/v1/reviewed': (b) => queue.markReviewed(String(b.id)),
    '/v1/reply': (b) => queue.reply(String(b.id), b.text),
    '/v1/read': (b) => queue.read(String(b.id)),
    '/v1/stop': () => queue.stop(),
    '/v1/focus': (b) => (queue.setFocus(b.id === null || b.id === undefined ? undefined : String(b.id)) ? { ok: true } : { ok: false, error: 'not-open' }),
  }
  if (dev) actions['/v1/dev/ask'] = (b) => dev.ask(b)

  async function snapshot(req, res, url) {
    // The client sends "<snapshotId>|<focusId>|<readingId>"; missing parts mean "none".
    const raw = url.searchParams.get('since') ?? undefined
    const since = raw === undefined ? undefined : raw.split('|').concat(['', '']).slice(0, 3).join('|')
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), MAX_WAIT_MS)
    const current = () => queue.snapshot()
    const stamp = (s) => s.snapshotId + '|' + (s.focusId ?? '') + '|' + (s.reading ?? '')
    const unchanged = () => {
      if (since === undefined) return undefined
      const s = current()
      return stamp(s) === since ? s : undefined
    }
    const first = unchanged()
    if (!first) return send(res, 200, current())
    if (wait === 0) return send(res, 200, { unchanged: true, snapshotId: first.snapshotId })
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); off(); req.off('close', done); resolve() }
      const timer = setTimeout(done, wait)
      const off = queue.onChange(done)
      req.once('close', done)
    })
    const now = unchanged()
    send(res, 200, now ? { unchanged: true, snapshotId: now.snapshotId } : current())
  }

  return async function serve(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://local')
      if (url.pathname === '/v1/snapshot') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' })
        return await snapshot(req, res, url)
      }
      const action = actions[url.pathname]
      if (!action) return send(res, 404, { error: 'not-found' })
      if (req.method !== 'POST') return send(res, 405, { error: 'method' })
      const body = await readJson(req)
      if (!body.value) return send(res, body.status, { error: 'bad-request' })
      return outcome(res, await action(body.value))
    } catch (error) {
      send(res, 500, { error: 'internal' })
    }
  }
}
