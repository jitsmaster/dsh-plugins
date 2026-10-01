/**
 * Authenticated HTTPS reverse proxy that forwards ONLY to the local DSH web server.
 * Nothing else on the machine is reachable: the target is fixed in config, the request
 * path is never used to pick a host, and every request needs a valid session cookie.
 */
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createTls } from 'node:https'
import { connect } from 'node:net'
import { createSessions, createThrottle, verifyCredentials } from './auth.js'

const PREFIX = '/__dsh-remote'
const COOKIE = '__Host-dshra'

const page = (body, status = 200) => ({ status, body: `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>DSH remote</title><style>body{font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}form{display:grid;gap:12px;width:min(320px,90vw)}input,button{padding:10px;font:inherit;border-radius:6px;border:1px solid #444;background:#222;color:#eee}button{background:#2d6cdf;border:0;cursor:pointer}p{color:#f88;margin:0}</style>${body}` })

function loginForm(next, error, totp) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return page(`<form method=post action="${PREFIX}/login"><h3>DSH remote access</h3>${error ? `<p>${esc(error)}</p>` : ''}<input type=hidden name=next value="${esc(next)}"><input type=password name=password placeholder=Password autofocus autocomplete=current-password required>${totp ? '<input name=code placeholder="6-digit code" inputmode=numeric autocomplete=one-time-code required>' : ''}<button>Sign in</button></form>`)
}

function send(res, { status, body }, extra = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra,
  })
  res.end(body)
}

const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2))
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith(PREFIX) ? n : '/')

function readForm(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', reject)
  })
}

/**
 * @param {object} o
 * @param {{cert:any,key:any}} o.tls
 * @param {() => object|undefined} o.getAuth - current auth record (re-read so a new password applies live)
 */
export function startProxy({ tls, getAuth, getLaunchToken, port, listenHost, targetHost, targetPort, sessionHours, log }) {
  const sessions = createSessions(sessionHours)
  const throttle = createThrottle()
  const targetOrigin = `http://${targetHost}:${targetPort}`
  const authed = (req) => sessions.valid(parseCookies(req.headers.cookie)[COOKIE])
  const ipOf = (req) => req.socket.remoteAddress ?? 'unknown'

  async function handleOwn(req, res, url) {
    if (url.pathname === `${PREFIX}/logout`) {
      sessions.destroy(parseCookies(req.headers.cookie)[COOKIE])
      return send(res, page('<form><p>Signed out.</p></form>'), { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict` })
    }
    const rec = getAuth()
    if (url.pathname !== `${PREFIX}/login`) return send(res, page('Not found', 404))
    if (req.method === 'GET') return send(res, loginForm(safeNext(url.searchParams.get('next')), '', rec?.totpSecret))
    if (req.method !== 'POST') return send(res, page('Method not allowed', 405))
    const ip = ipOf(req)
    // Origin must be this very host (login CSRF defence on top of SameSite).
    const origin = req.headers.origin
    if (origin && new URL(origin).host !== req.headers.host) return send(res, page('Forbidden', 403))
    const waitMs = throttle.wait(ip)
    if (waitMs > 0) return send(res, page(`<p>Too many attempts. Try again in ${Math.ceil(waitMs / 1000)}s.</p>`, 429), { 'retry-after': String(Math.ceil(waitMs / 1000)) })
    let form
    try { form = await readForm(req) } catch { return send(res, page('Bad request', 400)) }
    const ok = rec !== undefined && verifyCredentials(rec, form.get('password'), form.get('code'))
    if (!ok) {
      throttle.fail(ip); log(`login failed from ${ip}`)
      await new Promise((r) => setTimeout(r, 750))
      return send(res, loginForm(safeNext(form.get('next')), 'Invalid credentials.', rec?.totpSecret), {})
    }
    throttle.ok(ip); log(`login ok from ${ip}`)
    const id = sessions.create()
    res.writeHead(303, {
      location: safeNext(form.get('next')),
      'set-cookie': `${COOKIE}=${id}; Path=/; Max-Age=${sessionHours * 3600}; Secure; HttpOnly; SameSite=Strict`,
      'cache-control': 'no-store',
    })
    res.end()
  }

  /** Headers for the upstream call: Host/Origin rewritten to loopback so DSH's own Host fence accepts it; our cookie never leaks upstream. */
  function upstreamHeaders(req) {
    const h = { ...req.headers, host: `${targetHost}:${targetPort}` }
    if (h.origin) h.origin = targetOrigin
    if (h.referer) { try { h.referer = targetOrigin + new URL(h.referer).pathname } catch { delete h.referer } }
    const rest = Object.entries(parseCookies(h.cookie)).filter(([k]) => k !== COOKIE)
    if (rest.length) h.cookie = rest.map(([k, v]) => `${k}=${v}`).join('; '); else delete h.cookie
    delete h['x-forwarded-for']; delete h['x-forwarded-host']; delete h['x-forwarded-proto']
    return h
  }

  const server = createTls({ ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 16 * 1024 }, async (req, res) => {
    let url
    try { url = new URL(req.url, 'https://x') } catch { return send(res, page('Bad request', 400)) }
    if (url.pathname.startsWith(PREFIX)) {
      try { return await handleOwn(req, res, url) } catch { return send(res, page('Error', 500)) }
    }
    if (!authed(req)) {
      const nav = (req.headers.accept ?? '').includes('text/html') && req.method === 'GET'
      if (nav) { res.writeHead(303, { location: `${PREFIX}/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'cache-control': 'no-store' }); return res.end() }
      res.writeHead(401, { 'cache-control': 'no-store' }); return res.end()
    }
    // DSH has its own launch-token auth. After our login, the proxy supplies the token on the
    // index request so the user never sees or types it; DSH then mints its own cookie.
    let path = req.url
    if (req.method === 'GET' && url.pathname === '/' && !url.searchParams.has('token')) {
      const tok = getLaunchToken?.()
      if (tok) { url.searchParams.set('token', tok); path = url.pathname + url.search }
    }
    const up = httpRequest({ host: targetHost, port: targetPort, method: req.method, path, headers: upstreamHeaders(req) }, (ur) => {
      const h = { ...ur.headers, 'x-content-type-options': 'nosniff' }
      if (h['set-cookie']) h['set-cookie'] = [].concat(h['set-cookie']).map((c) => (/;\s*secure/i.test(c) ? c : `${c}; Secure`))
      if (typeof h.location === 'string') h.location = h.location.replace(targetOrigin, '')
      res.writeHead(ur.statusCode ?? 502, h)
      ur.pipe(res)
    })
    up.on('error', () => { if (!res.headersSent) { res.writeHead(502); } res.end() })
    res.on('close', () => up.destroy())
    req.pipe(up)
  })
  server.requestTimeout = 0 // SSE / long uploads are legitimate; headers timeout still applies
  server.headersTimeout = 20_000

  // WebSocket / upgrade passthrough, authenticated.
  server.on('upgrade', (req, socket, head) => {
    if (!authed(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    const up = connect(targetPort, targetHost, () => {
      const h = upstreamHeaders(req)
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (const [k, v] of Object.entries(h)) for (const x of [].concat(v)) raw += `${k}: ${x}\r\n`
      up.write(`${raw}\r\n`); if (head?.length) up.write(head)
      socket.pipe(up).pipe(socket)
    })
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy()); socket.on('close', () => up.destroy())
  })
  server.on('tlsClientError', () => {})
  const sweep = setInterval(() => sessions.sweep(), 600e3); sweep.unref()
  server.listen(port, listenHost, () => log(`proxy listening on https://${listenHost}:${port} -> ${targetOrigin}`))
  server.on('error', (e) => log(`proxy error: ${e.message}`))
  return () => { clearInterval(sweep); server.close(); server.closeAllConnections?.() }
}
