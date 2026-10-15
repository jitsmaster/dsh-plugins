/**
 * /hub/v1/agent/*: what the agents (the plugin of every DSH app) call: register (with a sync), ops, sync, commands (long poll),
 * result, presence, bye. Authenticated by the agent secret alone (a request that came through a proxy is refused), and by the
 * protocol header: an agent older than this hub gets 426 upgrade-required. Counts and codes only in the log.
 */
import { MAX_WAIT_MS, readJson, send } from '../server.js'
import { secretMatches } from './secret.js'

const PREFIX = '/hub/v1/agent/'
const MAX_AGENT_BODY = 8 * 1024 * 1024
const MAX_OPS = 500
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'tailscale-user-login']
const ITEM_ID = /^[A-Za-z0-9]{4}-[0-9a-f]{12}$/

/** @param {{ hub: any, instances: any, commands: any, store: any, secret: string, log?: (line: string) => void }} deps */
export function createAgentApi({ hub, instances, commands, store, secret, log = () => {} }) {
  let stopping = false

  const authorized = (req) => {
    const header = String(req.headers.authorization ?? '')
    return !PROXY_HEADERS.some((h) => req.headers[h] !== undefined) && header.startsWith('Bearer ') && secretMatches(secret, header.slice(7))
  }
  const protocolOk = (req) => {
    const p = Number(req.headers['x-rq-protocol'])
    return Number.isInteger(p) && p >= hub.protocol - 1
  }
  const unknown = (res) => send(res, 409, { ok: false, error: 'unknown-instance' })

  /** One op of the instance; an add must carry an id of the form <instance short>-<12 hex>. */
  function applyOne(inst, op) {
    if (op.op === 'add' && !(typeof op.item?.id === 'string' && ITEM_ID.test(op.item.id) && op.item.id.startsWith(instances.short(inst.id) + '-'))) return { ok: false, error: 'bad-id' }
    return store.applyOp(op, { owner: inst.id })
  }
  function applyOps(inst, ops) {
    const results = []
    let conflict = false
    for (const op of ops) {
      const n = op?.n
      if (!Number.isInteger(n)) { results.push({ n, ok: false, error: 'bad-op' }); continue }
      if (n <= inst.lastOp) { results.push({ n, ok: true, duplicate: true }); continue }
      if (n !== inst.lastOp + 1) return { resync: true, ack: inst.lastOp, results }
      const r = applyOne(inst, op)
      inst.lastOp = n
      conflict ||= r.error === 'id-conflict'
      results.push({ n, ok: r.ok === true, ...(r.error ? { error: r.error } : {}) })
    }
    return { ack: inst.lastOp, results, conflict }
  }

  const registerBody = (b, protocol) => ({ key: b.instanceKey, id: b.instanceId, label: b.label, pid: b.pid, pluginVersion: b.pluginVersion, protocol, sync: b.sync })
  const routes = {
    register(req, res, body) {
      const r = instances.register(registerBody(body, Number(req.headers['x-rq-protocol'])))
      if (!r.ok) return send(res, r.error === 'superseded' ? 409 : 400, r)
      log('agent registered (' + body.instanceId + '): ' + r.adopted + ' adopted, ' + r.revived + ' revived, ' + r.ended + ' ended')
      return send(res, 200, { ...r, hubId: hub.hubId, protocol: hub.protocol })
    },
    ops(req, res, body) {
      const inst = instances.touch(body.instanceId)
      if (!inst) return unknown(res)
      if (!Array.isArray(body.ops) || body.ops.length > MAX_OPS) return send(res, 400, { error: 'bad-request' })
      const r = applyOps(inst, body.ops)
      if (r.resync) return send(res, 409, { ok: false, error: 'resync-needed', ack: r.ack, results: r.results })
      if (r.conflict) return send(res, 409, { ok: false, error: 'id-conflict', ack: r.ack, results: r.results })
      return send(res, 200, { ok: true, ack: r.ack, results: r.results })
    },
    sync(req, res, body) {
      const r = instances.sync(body.instanceId, body.sync)
      return r.ok ? send(res, 200, r) : unknown(res)
    },
    result(req, res, body) {
      if (!instances.touch(body.instanceId)) return unknown(res)
      const ok = body.result && typeof body.result === 'object' && typeof body.result.ok === 'boolean'
      if (!ok) return send(res, 400, { ok: false, error: 'bad-result' })
      return send(res, 200, { ok: true, accepted: commands.complete(body.instanceId, String(body.cid), body.result) })
    },
    presence(req, res, body) {
      return instances.presence(body.instanceId, { desktopActive: body.desktopActive === true }) ? send(res, 200, { ok: true }) : unknown(res)
    },
    bye(req, res, body) {
      const r = instances.bye(body.instanceId)
      return r.ok ? send(res, 200, r) : unknown(res)
    },
  }

  async function poll(req, res, url) {
    const id = url.searchParams.get('instanceId') ?? ''
    if (!instances.pollOpen(id)) return unknown(res)
    const after = Number(url.searchParams.get('after') ?? 0)
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), MAX_WAIT_MS)
    const abort = new AbortController()
    res.once('close', () => abort.abort())
    const list = await commands.poll(id, after, wait, abort.signal)
    instances.pollClose(id)
    if (stopping) return send(res, 503, { error: 'shutting-down' })
    return send(res, 200, { commands: list })
  }

  /** POST /hub/v1/shutdown {reason?}: the agent secret asks the hub to end itself (an upgrade); answered before it goes down. */
  async function shutdown(req, res, { originOk, onShutdown }) {
    if (!authorized(req)) return send(res, 401, { error: 'auth-required' })
    if (req.method !== 'POST') return send(res, 405, { error: 'method' })
    if (!originOk(req)) return send(res, 403, { error: 'bad-origin' })
    const body = await readJson(req)
    if (!body.value) return send(res, body.status, { error: 'bad-request' })
    const reason = body.value.reason ?? 'requested'
    if (typeof reason !== 'string' || !/^[a-z-]{1,32}$/.test(reason)) return send(res, 400, { error: 'bad-request' })
    if (body.value.hubId !== undefined && body.value.hubId !== hub.hubId) return send(res, 409, { ok: false, error: 'wrong-hub' })
    res.once('finish', () => { log('shutdown requested (' + reason + ')'); onShutdown?.(reason) })
    return send(res, 200, { ok: true })
  }

  return {
    shutdown,
    /** @param {{ originOk: (req: any) => boolean }} opts */
    async handle(req, res, url, path, { originOk }) {
      if (!authorized(req)) return send(res, 401, { error: 'auth-required' })
      if (!protocolOk(req)) return send(res, 426, { error: 'upgrade-required', protocol: hub.protocol })
      const name = path.slice(PREFIX.length)
      if (name === 'commands') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' })
        return poll(req, res, url)
      }
      if (!Object.hasOwn(routes, name)) return send(res, 404, { error: 'not-found' })
      if (req.method !== 'POST') return send(res, 405, { error: 'method' })
      if (!originOk(req)) return send(res, 403, { error: 'bad-origin' })
      const body = await readJson(req, MAX_AGENT_BODY)
      if (!body.value) return send(res, body.status, { error: 'bad-request' })
      return routes[name](req, res, body.value)
    },
    /** Shutdown: every waiting command is answered and every long poll woken. */
    stop() { stopping = true; commands.failAll() },
  }
}
