/**
 * The phone web app (PWA): static files served under /review-queue/m/ by the same router as the API, so it sits behind the
 * Host's own Host / Origin / cookie fence (index.js). Only the files named in FILES are ever served (no path is built from the URL).
 * `overlay.js` is the desktop overlay bundle itself: the phone page loads it with a stub React to reuse its pure card helpers
 * (see lib/mobile/core.js), so the card logic exists once.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MOBILE_PREFIX = '/m'
const LIB = join(dirname(fileURLToPath(import.meta.url)), 'lib')
const M = join(LIB, 'mobile')

const JS = 'text/javascript; charset=utf-8'
/** URL name (under /m/) -> file and content type. */
export const FILES = {
  '': { file: join(M, 'index.html'), type: 'text/html; charset=utf-8' },
  'index.html': { file: join(M, 'index.html'), type: 'text/html; charset=utf-8' },
  'app.js': { file: join(M, 'app.js'), type: JS },
  'api.js': { file: join(M, 'api.js'), type: JS },
  'core.js': { file: join(M, 'core.js'), type: JS },
  'views.js': { file: join(M, 'views.js'), type: JS },
  'hold.js': { file: join(M, 'hold.js'), type: JS },
  'settings.js': { file: join(M, 'settings.js'), type: JS },
  'push-client.js': { file: join(M, 'push-client.js'), type: JS },
  'style.css': { file: join(M, 'style.css'), type: 'text/css; charset=utf-8' },
  'sw.js': { file: join(M, 'sw.js'), type: JS, extra: { 'Service-Worker-Allowed': './' } },
  'manifest.webmanifest': { file: join(M, 'manifest.webmanifest'), type: 'application/manifest+json; charset=utf-8' },
  'icon-192.png': { file: join(M, 'icon-192.png'), type: 'image/png' },
  'icon-512.png': { file: join(M, 'icon-512.png'), type: 'image/png' },
  'vendor/preact-htm.js': { file: join(M, 'vendor', 'preact-htm.js'), type: JS },
  'overlay.js': { file: join(LIB, 'client.js'), type: JS },
}

/**
 * Serves one GET/HEAD for a path under /m. Returns true when it answered (also with a 404/405), false when the path is not under /m.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 */
export async function serveMobile(req, res, pathname) {
  if (pathname !== MOBILE_PREFIX && !pathname.startsWith(MOBILE_PREFIX + '/')) return false
  if (pathname === MOBILE_PREFIX) { // relative URLs in the page need the trailing slash
    res.writeHead(308, { Location: MOBILE_PREFIX.slice(1) + '/', 'Cache-Control': 'no-store' })
    res.end()
    return true
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true }
  const name = pathname.slice(MOBILE_PREFIX.length + 1)
  const entry = Object.prototype.hasOwnProperty.call(FILES, name) ? FILES[name] : undefined
  if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return true }
  let body
  try { body = await readFile(entry.file) } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return true }
  res.writeHead(200, { 'Content-Type': entry.type, 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...(entry.extra ?? {}) })
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}
