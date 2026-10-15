/**
 * The phone side of the hub's own API (/hub/v1/*): POST pair (public), POST pairing-codes, GET devices, PATCH devices/<id>, POST
 * devices/<id>/revoke (desktop only) and GET session (device or desktop). Every state-changing call checks the Origin and needs JSON.
 * Nothing here ever shows a token, a token hash, a pairing code (except in the answer that creates it), a push endpoint or a key.
 */
import { readJson, send } from '../server.js'
import { clientIp } from './roles.js'

const DEVICES = '/hub/v1/devices'
const NOT_TIGHT = 'permissions could not be tightened'

/** 429 with Retry-After in whole seconds (at least 1). */
export function sendLimited(res, retryAfterMs) {
  if (res.destroyed) return
  res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(Math.max(1, Math.ceil((retryAfterMs ?? 1000) / 1000))) })
  res.end(JSON.stringify({ error: 'rate-limited' }))
}

/** @param {{ hub: any, originOk: (req: any) => boolean, authorize: (req: any, res: any) => any }} deps */
export function createDeviceRoutes({ hub, originOk, authorize }) {
  const pushOf = (deviceId) => {
    const sub = hub.push.list({ deviceId })[0]
    return sub ? { state: 'on', types: sub.types, quiet: sub.quiet, lastSuccessAt: sub.lastSuccessAt, lastError: sub.lastError } : { state: 'off' }
  }
  const deviceView = (d) => ({ ...d, push: pushOf(d.id) })

  /** The caller must be the desktop; answers 403 otherwise. */
  const desktopOnly = (req, res) => {
    const who = authorize(req, res)
    if (!who) return false
    if (who.role !== 'desktop') { send(res, 403, { error: 'forbidden' }); return false }
    return true
  }
  /** Method, Origin and JSON body of a state-changing call: the parsed body, or undefined after the refusal was sent. */
  async function writeBody(req, res) {
    if (!originOk(req)) return void send(res, 403, { error: 'bad-origin' })
    const body = await readJson(req)
    if (!body.value) return void send(res, body.status, { error: 'bad-request' })
    return body.value
  }

  async function pair(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method' })
    if (!originOk(req)) return send(res, 403, { error: 'bad-origin' })
    if (!hub.roles.loginAllowed(req)) return send(res, 403, { error: 'login-not-allowed' })
    const body = await readJson(req)
    if (!body.value) return send(res, body.status, { error: 'bad-request' })
    const login = typeof req.headers['tailscale-user-login'] === 'string' ? req.headers['tailscale-user-login'] : undefined
    const r = await hub.pairing.pair({ code: body.value.code, name: body.value.name, ip: clientIp(req), login })
    if (r.ok) return send(res, 200, { deviceId: r.deviceId, token: r.token, name: r.name })
    return r.status === 429 ? sendLimited(res, r.retryAfterMs) : send(res, r.status, { error: r.error })
  }

  function createCode(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method' })
    if (!desktopOnly(req, res)) return undefined
    return writeBody(req, res).then((body) => {
      if (!body) return
      const { code, expiresAt } = hub.pairing.createCode()
      const url = hub.config.publicOrigin ? hub.config.publicOrigin + '/review-queue/m/#/pair' : null
      send(res, 200, { ok: true, code, expiresAt, url, link: url ? url + '/' + code : null })
    })
  }

  function session(req, res) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method' })
    const who = authorize(req, res)
    if (!who) return
    const device = who.deviceId ? hub.devices.get(who.deviceId) : undefined
    send(res, 200, { ok: true, role: who.role, ...(device ? { deviceId: device.id, name: device.name } : {}), serverNow: hub.now() })
  }

  function list(req, res) {
    if (!desktopOnly(req, res)) return
    const failed = hub.hardener.status().tightened ? [] : [NOT_TIGHT]
    send(res, 200, { ok: true, devices: hub.devices.list().map(deviceView), legacy: hub.push.list({ deviceId: null }), warnings: failed, publicUrl: hub.config.publicOrigin ?? null })
  }

  async function one(req, res, id, action) {
    if (!desktopOnly(req, res)) return
    const body = await writeBody(req, res)
    if (!body) return
    if (action === 'revoke') {
      // an old subscription of a phone that was never paired is removed here as well (a lost old phone)
      if (!hub.devices.get(id) && hub.push.find({ id })?.deviceId === null) return send(res, 200, { ok: true, removed: hub.push.remove({ id }) })
      const r = hub.devices.revoke(id)
      return r.ok ? send(res, 200, { ok: true, device: deviceView(r.device) }) : send(res, 404, { error: r.error })
    }
    const r = hub.devices.rename(id, body.name)
    return r.ok ? send(res, 200, { ok: true, device: deviceView(r.device) }) : send(res, r.error === 'bad-name' ? 400 : 404, { error: r.error })
  }

  /** @returns {Promise<boolean>} whether the path was one of these routes */
  return async function handle(req, res, path) {
    if (path === '/hub/v1/pair') { await pair(req, res); return true }
    if (path === '/hub/v1/pairing-codes') { await createCode(req, res); return true }
    if (path === '/hub/v1/session') { session(req, res); return true }
    if (path === DEVICES) { req.method === 'GET' ? list(req, res) : send(res, 405, { error: 'method' }); return true }
    const m = /^\/hub\/v1\/devices\/([A-Za-z0-9_-]{1,64})(?:\/(revoke))?$/.exec(path)
    if (!m) return false
    const expected = m[2] ? 'POST' : 'PATCH'
    if (req.method !== expected) send(res, 405, { error: 'method' })
    else await one(req, res, m[1], m[2])
    return true
  }
}
