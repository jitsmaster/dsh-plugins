/**
 * The /v1/push/* routes of the phone's notification set-up, mounted by server.js behind the Host's own admission check. Thin: the
 * rules live in push.js (devices) and webpush.js (delivery). Answers are JSON; errors are { ok: false, error }. Nothing here ever
 * returns an endpoint or a key.
 */

const TEST_PAYLOAD = { title: 'Task list', body: 'Test notification', tag: 'test', url: '#/' }
const TEST_TTL_SEC = 300
// Validation failures from push.js are the phone's mistake (400); a full device list is a conflict.
const STATUS = { 'unknown-device': 404, 'too-many-devices': 409 }

/**
 * @param {{ push: ReturnType<import('./push.js').createPushStore>, publicKey: string }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string, io: { readJson: Function, send: Function }) => Promise<void>}
 */
export function createPushRoutes({ push, publicKey }) {
  const reject = (r) => [STATUS[r.error] ?? 400, { ok: false, error: r.error, ...(r.detail ? { detail: r.detail } : {}) }]

  // method + route -> handler(body) returning [status, json]; reads have no body.
  const routes = {
    'GET /v1/push/key': () => [200, { key: publicKey }],
    'GET /v1/push/devices': () => [200, { devices: push.list() }],
    'POST /v1/push/subscribe': (b) => {
      const r = push.upsert(b)
      return r.ok ? [200, { ok: true, device: r.device }] : reject(r)
    },
    'POST /v1/push/unsubscribe': (b) => {
      if (typeof b.id !== 'string' && typeof b.endpoint !== 'string') return [400, { ok: false, error: 'bad-request' }]
      return [200, { ok: true, removed: push.remove({ id: b.id, endpoint: b.endpoint }) }]
    },
    'POST /v1/push/settings': (b) => {
      if (typeof b.endpoint !== 'string') return [400, { ok: false, error: 'bad-request' }]
      const r = push.update(b.endpoint, { name: b.name, types: b.types, quiet: b.quiet })
      return r.ok ? [200, { ok: true, device: r.device }] : reject(r)
    },
    'POST /v1/push/test': async (b) => {
      if (typeof b.endpoint !== 'string') return [400, { ok: false, error: 'bad-request' }]
      const device = push.find({ endpoint: b.endpoint })
      if (!device) return [404, { ok: false, error: 'unknown-device' }]
      const r = await push.send(device.id, TEST_PAYLOAD, { ttl: TEST_TTL_SEC, urgency: 'normal', topic: 'test' })
      if (r.ok) return [200, { ok: true }]
      return r.gone ? [410, { ok: false, error: 'subscription-gone' }] : [502, { ok: false, error: 'push-failed', status: r.status }]
    },
  }
  const paths = new Set(Object.keys(routes).map((k) => k.split(' ')[1]))

  return async function servePush(req, res, pathname, { readJson, send }) {
    if (!paths.has(pathname)) return send(res, 404, { error: 'unknown-action' })
    const handler = routes[req.method + ' ' + pathname]
    if (!handler) return send(res, 405, { error: 'method' })
    let body = {}
    if (req.method === 'POST') {
      const parsed = await readJson(req)
      if (!parsed.value) return send(res, parsed.status, { error: 'bad-request' })
      body = parsed.value
    }
    const [status, json] = await handler(body)
    send(res, status, json)
  }
}
