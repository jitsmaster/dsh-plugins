/**
 * The tip pop-out: a small standalone page, served under /review-queue/tip-window/ by the same router as the API (so it sits behind the Host's own
 * Host / Origin / cookie fence). Only the files named in TIP_WINDOW_FILES are ever served (no path is built from the URL). The page script talks to
 * the same /v1 routes as the overlay (tip-current, tip-next, tip-deeper, read-tip, stop).
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TIP_WINDOW_PREFIX = '/tip-window'
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'tip-window')
/** URL name (under /tip-window/) -> file and content type. */
export const TIP_WINDOW_FILES = {
  '': { file: join(DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  'index.html': { file: join(DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  'app.js': { file: join(DIR, 'app.js'), type: 'text/javascript; charset=utf-8' },
  'style.css': { file: join(DIR, 'style.css'), type: 'text/css; charset=utf-8' },
}

const plain = (res, code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text) }

/** Serves one GET/HEAD for a path under /tip-window. Returns true when it answered (also with a 404/405), false when the path is not under it. */
export async function serveTipWindow(req, res, pathname) {
  if (pathname !== TIP_WINDOW_PREFIX && !pathname.startsWith(TIP_WINDOW_PREFIX + '/')) return false
  if (pathname === TIP_WINDOW_PREFIX) { // relative URLs in the page need the trailing slash
    res.writeHead(308, { Location: TIP_WINDOW_PREFIX.slice(1) + '/', 'Cache-Control': 'no-store' })
    res.end()
    return true
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true }
  const name = pathname.slice(TIP_WINDOW_PREFIX.length + 1)
  const entry = Object.prototype.hasOwnProperty.call(TIP_WINDOW_FILES, name) ? TIP_WINDOW_FILES[name] : undefined
  if (!entry) { plain(res, 404, 'not found'); return true }
  let body
  try { body = await readFile(entry.file) } catch { plain(res, 404, 'not found'); return true }
  res.writeHead(200, { 'Content-Type': entry.type, 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}
