/**
 * The /v1/push/* routes of the phone's notification set-up, mounted by server.js behind the Host's own admission check. Thin: the
 * rules live in push.js (devices) and webpush.js (delivery). Answers are JSON; errors are { ok: false, error }. Nothing here ever
 * returns an endpoint or a key. In the hub the caller is known: a paired phone (who.deviceId) subscribes as itself, sees and changes
 * only its own subscription (anything else is "unknown device"); without a deviceId (the desktop, the standalone server) every record is in reach.
 */

const TEST_PAYLOAD = { title: 'Coding Boss Review Queue', body: 'Test notification', tag: 'test', url: '#/' }
const TEST_TTL_SEC = 300
// Validation failures from push.js are the phone's mistake (400); a full device list is a conflict.
const STATUS = { 'unknown-device': 404, 'too-many-devices': 409 }

/**
 * @param {{ push: ReturnType<import('./push.js').createPushStore>, publicKey: string | (() => string) }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, io: { readJson: Function, send: Function }, who?: { deviceId?: string }) => Promise<void>}
 */
export function createPushRoutes({ push, publicKey }) {
  const reject = (r) => [STATUS[r.error] ?? 400, { ok: false, error: r.error, ...(r.detail ? { detail: r.detail } : {}) }]

  /** The record the caller may touch: any for the desktop, its own for a paired phone. */
  const reachable = (target, who) => {
    const record = push.find(target)
    return record && (!who.deviceId || record.deviceId === who.deviceId) ? record : undefined
  }

  // method + route -> handler(body, who) returning [status, json]; reads have no body.
  const routes = {
    'GET /v1/push/key': () => [200, { key: typeof publicKey === 'function' ? publicKey() : publicKey }],
    'GET /v1/push/devices': (b, who) => [200, { devices: push.list(who.deviceId ? { deviceId: who.deviceId } : undefined) }],
    'POST /v1/push/subscribe': (b, who) => {
      const { deviceId: _ignored, ...input } = b // who the phone is comes from its token, never from the body
      const r = push.upsert({ ...input, ...(who.deviceId ? { deviceId: who.deviceId } : {}) })
      return r.ok ? [200, { ok: true, device: r.device }] : reject(r)
    },
    'POST /v1/push/unsubscribe': (b, who) => {
      if (typeof b.id !== 'string' && typeof b.endpoint !== 'string') return [400, { ok: false, error: 'bad-request' }]
      const record = reachable({ id: b.id, endpoint: b.endpoint }, who)
      return [200, { ok: true, removed: record ? push.remove({ id: record.id }) : false }]
    },
    'POST /v1/push/settings': (b, who) => {
      if (typeof b.endpoint !== 'string') return [400, { ok: false, error: 'bad-request' }]
      if (!reachable({ endpoint: b.endpoint }, who)) return [404, { ok: false, error: 'unknown-device' }]
      const r = push.update(b.endpoint, { name: b.name, types: b.types, quiet: b.quiet })
      return r.ok ? [200, { ok: true, device: r.device }] : reject(r)
    },
    'POST /v1/push/test': async (b, who) => {
      if (typeof b.endpoint !== 'string') return [400, { ok: false, error: 'bad-request' }]
      const device = reachable({ endpoint: b.endpoint }, who)
      if (!device) return [404, { ok: false, error: 'unknown-device' }]
      const r = await push.send(device.id, TEST_PAYLOAD, { ttl: TEST_TTL_SEC, urgency: 'normal', topic: 'test' })
      if (r.ok) return [200, { ok: true }]
      return r.gone ? [410, { ok: false, error: 'subscription-gone' }] : [502, { ok: false, error: 'push-failed', status: r.status }]
    },
  }
  const paths = new Set(Object.keys(routes).map((k) => k.split(' ')[1]))

  return async function servePush(req, res, pathname, { readJson, send }, who = {}) {
    if (!paths.has(pathname)) return send(res, 404, { error: 'unknown-action' })
    const handler = routes[req.method + ' ' + pathname]
    if (!handler) return send(res, 405, { error: 'method' })
    let body = {}
    if (req.method === 'POST') {
      const parsed = await readJson(req)
      if (!parsed.value) return send(res, parsed.status, { error: 'bad-request' })
      body = parsed.value
    }
    const [status, json] = await handler(body, who)
    send(res, status, json)
  }
}
