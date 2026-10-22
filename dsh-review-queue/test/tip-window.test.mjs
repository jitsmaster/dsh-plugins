import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { TIP_WINDOW_FILES } from '../tip-window.js'

// The tip pop-out: a small standalone page under /tip-window/ (same router, so it sits behind the Host's own fence) that shows the tip and lets the reader
// ask for another one, type a topic, go deeper and read it aloud, through the same /v1 routes as the overlay.
let server, base
before(async () => {
  const queue = createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}), speaker: undefined })
  const serve = createRouter({ queue, dev: undefined })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))

test('every served file exists on disk', () => {
  for (const [name, entry] of Object.entries(TIP_WINDOW_FILES)) assert.ok(existsSync(entry.file), name)
})

test('/tip-window redirects to /tip-window/ and that serves an HTML page that loads app.js by a relative URL', async () => {
  const redirect = await fetch(base + '/tip-window', { redirect: 'manual' })
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.get('location'), 'tip-window/')
  const page = await fetch(base + '/tip-window/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  const html = await page.text()
  assert.match(html, /src="app\.js"/)
  assert.ok(!/<script>[^<]/.test(html), 'no inline script')
})

test('app.js and style.css are served; anything else under /tip-window is 404; only GET and HEAD', async () => {
  assert.equal((await fetch(base + '/tip-window/app.js')).status, 200)
  assert.match((await fetch(base + '/tip-window/style.css')).headers.get('content-type'), /text\/css/)
  assert.equal((await fetch(base + '/tip-window/..%2Fserver.js')).status, 404)
  assert.equal((await fetch(base + '/tip-window/nope.js')).status, 404)
  assert.equal((await fetch(base + '/tip-window/', { method: 'POST' })).status, 405)
})

test('the page script only uses the routes that exist, relative to /review-queue, and never writes text with innerHTML', () => {
  const js = readFileSync(TIP_WINDOW_FILES['app.js'].file, 'utf8')
  for (const route of ['tip-current', 'tip-next', 'tip-deeper', 'read-tip', 'stop']) assert.ok(js.includes("'" + route + "'"), route)
  assert.ok(js.includes("'../v1'"), 'relative to /review-queue/tip-window/')
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js))
})

test('the page refreshes by itself: it polls tip-peek (not tip-current, which would start a model call), only while visible and idle, and re-renders on a new id or new longer text', () => {
  const js = readFileSync(TIP_WINDOW_FILES['app.js'].file, 'utf8')
  assert.ok(js.includes("'tip-peek'"))
  assert.match(js, /setInterval\(/)
  assert.match(js, /document\.hidden/)
  assert.match(js, /busy/)
  assert.match(js, /sameTip\(/)
})
