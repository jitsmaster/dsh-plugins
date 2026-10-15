// Helpers of the proxy tests: a fake hub (an HTTP server that records what the proxy sends and answers as told) and a proxy in front of a REAL
// local review queue (real store, real service, real server.js router) served on a real HTTP port.
import { createServer } from 'node:http'
import { createProxy } from '../agent/proxy.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { createStore } from '../store.js'

export const SECRET = 'P'.repeat(43)
export const OWN = 'aaaa1111'
export const JSON_H = { 'content-type': 'application/json' }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** respond(rec, res) returns [status, body], or undefined for 200 { ok: true }, or a promise of either; rec.aborted turns true when the proxy hangs up. */
export async function startFakeHub(t) {
  const hub = { requests: [], respond: undefined, aborted: [] }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    const rec = { method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined, aborted: false }
    hub.requests.push(rec)
    res.on('close', () => { if (!res.writableFinished) { rec.aborted = true; hub.aborted.push(rec) } })
    const answer = (await hub.respond?.(rec)) ?? [200, { ok: true }]
    if (res.destroyed) return
    res.writeHead(answer[0], { 'content-type': typeof answer[1] === 'string' ? 'text/plain' : 'application/json' })
    res.end(typeof answer[1] === 'string' ? answer[1] : JSON.stringify(answer[1]))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  hub.port = server.address().port
  hub.url = 'http://127.0.0.1:' + hub.port
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  return hub
}

export const hubItem = (n, over = {}) => ({ id: 'bbbb-' + String(n).padStart(12, '0'), owner: 'bbbb2222', type: 'completed', status: 'open', position: n, createdAt: 100 + n, seq: n, sessionId: 's' + n, summary: 'Did ' + n, payload: { reply: 'r' }, ownerLabel: 'DSH :2', ownerState: 'online', spoken: { headline: 'hub item ' + n }, ...over })
export const hubSnap = (id = 'E:5', open = [hubItem(1)], over = {}) => ({ snapshotId: id, serverNow: 1, open, resolved: [], ...over })
export const tokenOf = (s) => s.snapshotId + '|' + (s.focusId ?? '') + '|' + (s.reading ?? '') + '|' + (s.ui?.seq ?? 0)

/** A proxy in front of a real local queue; opts.hubUrl overrides the hub address, the rest goes to createProxy. */
export async function startProxy(t, { mode = 'hub', reason, hub, hubUrl, ...over } = {}) {
  const store = createStore()
  const calls = []
  const capture = {
    answerQuestion: (id, answers) => { calls.push(['answer', id]); return answers?.length ? { ok: true } : { ok: false, error: 'bad-answer' } },
    decidePermission: (id, d) => { calls.push([d, id]); return { ok: true } },
    lateAnswerQuestion: async () => ({ ok: true }),
  }
  const speaker = { speak: () => ({ ok: true }), stop() {} }
  const queue = over.queue ?? createReviewQueue({ store, capture, controllerOf: () => ({ prompt: async () => ({}) }), speaker })
  const serve = createRouter({ queue })
  const reports = []
  const proxy = createProxy({ queue, serve, hubUrl: () => hubUrl ?? hub?.url, secret: () => SECRET, instanceId: () => OWN, onHubUnreachable: (r) => reports.push(r), ...over })
  if (mode !== 'starting') proxy.setMode(mode, reason)
  const server = createServer((req, res) => proxy.handle(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const base = 'http://127.0.0.1:' + server.address().port
  const api = {
    proxy, store, queue, calls, reports, base,
    get: async (path) => { const r = await fetch(base + path); return { status: r.status, json: await r.json() } },
    post: async (path, body, headers = JSON_H) => { const r = await fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }); return { status: r.status, json: await r.json() } },
    snap: async () => (await api.get('/v1/snapshot')).json,
    own: (over2 = {}) => store.add({ type: 'completed', sessionId: 'own', sessionTitle: 'Own', summary: 'Own work.', payload: { reply: 'r' }, ...over2 }),
  }
  return api
}
