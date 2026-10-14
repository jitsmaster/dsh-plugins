import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { FILES } from '../mobile.js'

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
  for (const [name, entry] of Object.entries(FILES)) assert.ok(existsSync(entry.file), name + ' -> ' + entry.file)
})

test('/m redirects to /m/ and /m/ serves the page', async () => {
  const redirect = await fetch(base + '/m', { redirect: 'manual' })
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.get('location'), 'm/')
  const page = await fetch(base + '/m/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /^text\/html/)
  const html = await page.text()
  assert.match(html, /manifest\.webmanifest/)
  assert.match(html, /viewport/)
})

test('scripts, styles, manifest, icons and the overlay bundle are served with the right types', async () => {
  const types = { 'app.js': /javascript/, 'api.js': /javascript/, 'core.js': /javascript/, 'views.js': /javascript/, 'style.css': /text\/css/, 'manifest.webmanifest': /manifest\+json/, 'icon-192.png': /image\/png/, 'icon-512.png': /image\/png/, 'vendor/preact-htm.js': /javascript/, 'overlay.js': /javascript/, 'settings.js': /javascript/, 'hold.js': /javascript/, 'push-client.js': /javascript/, 'sw.js': /javascript/ }
  for (const [name, type] of Object.entries(types)) {
    const res = await fetch(base + '/m/' + name)
    assert.equal(res.status, 200, name)
    assert.match(res.headers.get('content-type'), type, name)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    await res.arrayBuffer()
  }
})

test('the service worker may control the whole /m/ scope', async () => {
  const res = await fetch(base + '/m/sw.js')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('service-worker-allowed'), './')
  await res.text()
})

test('only listed files are served: traversal and unknown names are 404', async () => {
  for (const path of ['/m/../server.js', '/m/%2e%2e/server.js', '/m/store.js', '/m/vendor/', '/m/vendor/other.js', '/m/__proto__', '/m/constructor']) {
    const res = await fetch(base + path)
    assert.equal(res.status, 404, path)
    await res.text()
  }
})

test('non-GET on /m/ is 405; HEAD works', async () => {
  const post = await fetch(base + '/m/', { method: 'POST' })
  assert.equal(post.status, 405)
  await post.text()
  const head = await fetch(base + '/m/', { method: 'HEAD' })
  assert.equal(head.status, 200)
})

const MOBILE_DIR = new URL('../lib/mobile/', import.meta.url)

test('every file in lib/mobile is served, and every served file is in lib/mobile (or is the overlay bundle)', () => {
  const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), prefix + e.name + '/') : [prefix + e.name]))
  const onDisk = walk(fileURLToPath(MOBILE_DIR)).filter((n) => !/LICENSE/.test(n)).sort() // licence texts ship in the package but are not served
  const served = Object.keys(FILES).filter((n) => n !== '' && n !== 'overlay.js').sort()
  assert.deepEqual(served, onDisk)
})

test('every relative import of a served script is itself served', () => {
  for (const [name, entry] of Object.entries(FILES)) {
    if (!/\.js$/.test(entry.file) || name === 'overlay.js' || name.startsWith('vendor/')) continue
    const src = readFileSync(entry.file, 'utf8')
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = join(dirname(name), m[1]).replaceAll('\\', '/')
      assert.ok(Object.hasOwn(FILES, target), name + ' imports ' + m[1] + ' which is not in FILES')
    }
  }
})

test('the page, the manifest and the service worker only reference served files', () => {
  const page = readFileSync(FILES['index.html'].file, 'utf8')
  for (const m of page.matchAll(/(?:href|src)="\.\/([^"]+)"/g)) assert.ok(Object.hasOwn(FILES, m[1]), 'index.html references ' + m[1])
  const manifest = JSON.parse(readFileSync(FILES['manifest.webmanifest'].file, 'utf8'))
  assert.equal(manifest.start_url, './')
  assert.equal(manifest.scope, './')
  assert.equal(manifest.display, 'standalone')
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'))
  for (const icon of manifest.icons) assert.ok(Object.hasOwn(FILES, icon.src), 'manifest icon ' + icon.src)
  const sw = readFileSync(FILES['sw.js'].file, 'utf8')
  for (const m of sw.matchAll(/'\.\/([a-z0-9-]+\.png)'/g)) assert.ok(Object.hasOwn(FILES, m[1]), 'sw.js references ' + m[1])
})
