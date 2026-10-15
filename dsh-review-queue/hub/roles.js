/**
 * Who is calling (docs/hub.md 9.2). public needs nothing (handled by the router); device = Authorization: Bearer rqd_... that names an
 * active paired phone; desktop = a request from this PC itself: a direct loopback call (as in H1), which includes an instance proxy
 * that sends the agent secret and X-RQ-Role: desktop. A request that came through tailscale serve (X-Forwarded-For, Forwarded,
 * Tailscale-User-Login), for the public host name, or from a peer that is not loopback may NEVER be the desktop, whatever it sends: the
 * only role it can get is the device role, from a token. Tailscale-User-Login is trusted only when the peer is loopback (that is where
 * tailscale serve connects from); with allowedTailnetLogins configured it must be on the list for a device or a pairing request.
 */
import { LOOPBACK_ADDRESSES } from './protocol.js'

/** Set by tailscale serve and other proxies: such a request is not the desktop even though it arrives from loopback. */
export const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'tailscale-user-login']
const BEARER = /^Bearer\s+(\S+)$/i

export const isLoopback = (address) => LOOPBACK_ADDRESSES.has(address)
const header = (req, name) => (typeof req.headers[name] === 'string' ? req.headers[name] : undefined)

/** The address to rate limit: the last X-Forwarded-For entry (added by the proxy we trust, a client can only prepend) for a loopback peer, else the peer. */
export function clientIp(req) {
  const peer = req.socket?.remoteAddress
  if (!isLoopback(peer)) return peer
  const last = (header(req, 'x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean).at(-1)
  return last ?? peer
}

/** @param {{ devices: ReturnType<import('./devices.js').createDevices>, port: () => number, config: () => { allowedTailnetLogins: string[], publicHost?: string } }} deps */
export function createRoles({ devices, port, config }) {
  const loginOf = (req) => (isLoopback(req.socket?.remoteAddress) ? header(req, 'tailscale-user-login') : undefined)
  const loginAllowed = (req) => {
    const allowed = config().allowedTailnetLogins
    if (!allowed.length) return true
    const login = loginOf(req)?.toLowerCase()
    return login !== undefined && allowed.some((a) => a.toLowerCase() === login)
  }
  /** A direct request to this hub's own loopback address and name: nothing sat between the caller and the hub. */
  const direct = (req) => {
    const host = String(header(req, 'host') ?? '').toLowerCase()
    return isLoopback(req.socket?.remoteAddress) && !PROXY_HEADERS.some((h) => req.headers[h] !== undefined) && (host === '127.0.0.1:' + port() || host === 'localhost:' + port())
  }

  return {
    loginAllowed,
    /** @returns {{ role: 'desktop' } | { role: 'device', deviceId: string, login: string | undefined } | { error: 'auth-required' | 'login-not-allowed' } | {}} */
    identify(req) {
      const token = BEARER.exec(header(req, 'authorization') ?? '')?.[1]
      if (token?.startsWith('rqd_')) {
        const auth = devices.authenticate(token)
        if (!auth.ok) return { error: 'auth-required' }
        if (!loginAllowed(req)) return { error: 'login-not-allowed' }
        return { role: 'device', deviceId: auth.device.id, login: loginOf(req) }
      }
      return direct(req) ? { role: 'desktop' } : {}
    },
  }
}
