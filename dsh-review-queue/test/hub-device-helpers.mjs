// A hub with the phone side wired for tests: hub.config.json written, a fake clock, no real delays, no real icacls, a recording push sender,
// plus helpers to pair a phone and to call the hub as the desktop, as a phone through tailscale serve, or as a stranger.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHub } from '../hub/hub.js'
import { fakeClock, postJson, raw, tmpDir } from './hub-helpers.mjs'

export const SECRET = 'S'.repeat(43)
export const HOST = 'rq.example.ts.net'
export const LOGIN = 'me@example.com'
export const P = '/review-queue'
/** What tailscale serve adds to a request from a tailnet peer. */
export const serveHeaders = (extra = {}) => ({ host: HOST, 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': LOGIN, ...extra })
export const noAcl = { harden: () => ({ ok: true }), status: () => ({ tightened: true, failed: [] }) }

export async function startPhoneHub(t, { config = {}, dir = tmpDir(t), ...over } = {}) {
  writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ publicUrl: 'https://' + HOST, ...config }))
  const clock = over.clock ?? fakeClock()
  const logs = []
  const pushes = []
  const sleeps = []
  const hub = createHub({
    stateDir: dir, port: 0, tickMs: 0, secret: SECRET, now: clock.now, log: (l) => logs.push(l), hardener: noAcl, sleep: async (ms) => { sleeps.push(ms) },
    sendPush: async (subscription, payload, opts) => { pushes.push({ subscription, payload, opts }); return { ok: true, status: 201, gone: false } }, ...over,
  })
  await hub.start()
  t.after(() => hub.stop())
  const port = hub.port
  const call = (method, path, body, headers = {}) => (body === undefined && method === 'GET' ? raw({ port, path, headers }) : method === 'POST' ? postJson(port, path, body ?? {}, headers)
    : raw({ port, method, path, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }))
  const desktop = (method, path, body) => call(method, path, body)
  const stranger = (method, path, body, extra) => call(method, path, body, serveHeaders(extra))
  const phone = (token) => (method, path, body, extra) => call(method, path, body, serveHeaders({ authorization: 'Bearer ' + token, ...extra }))
  /** Pairs a phone the way the user does: the desktop asks for a code, the phone sends it through the public name. */
  const pairPhone = async (name = 'Pixel', extra = {}) => {
    const { json: code } = await desktop('POST', '/hub/v1/pairing-codes', {})
    const res = await call('POST', '/hub/v1/pair', { code: code.code, name }, serveHeaders(extra))
    return { ...res.json, res, call: phone(res.json.token) }
  }
  return { hub, dir, port, clock, logs, pushes, sleeps, desktop, stranger, phone, pairPhone, call }
}
