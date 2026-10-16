import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveTwaUrl, startUrlFromConfig, localDebugUrl, MOBILE_PATH } from '../android/tools/twa-url.mjs'

const URL = 'https://awang-lpt2.taile1279d.ts.net/review-queue/m/'

test('the phone page path is the one the hub serves', () => {
  assert.equal(MOBILE_PATH, '/review-queue/m/')
})

test('an https start URL gives origin, host, path prefix and the URL itself', () => {
  assert.deepEqual(deriveTwaUrl(URL), {
    startUrl: URL,
    origin: 'https://awang-lpt2.taile1279d.ts.net',
    scheme: 'https',
    host: 'awang-lpt2.taile1279d.ts.net',
    port: '',
    pathPrefix: '/review-queue/m/',
  })
})

test('query and fragment are dropped, the host is lower-cased, the default port disappears', () => {
  const out = deriveTwaUrl('HTTPS://Awang-LPT2.taile1279d.ts.net:443/review-queue/m/?x=1#frag')
  assert.equal(out.startUrl, URL)
  assert.equal(out.origin, 'https://awang-lpt2.taile1279d.ts.net')
  assert.equal(out.port, '')
})

test('a non-default port stays in the origin and is reported on its own', () => {
  const out = deriveTwaUrl('https://h.ts.net:8443/review-queue/m/')
  assert.equal(out.origin, 'https://h.ts.net:8443')
  assert.equal(out.host, 'h.ts.net')
  assert.equal(out.port, '8443')
})

test('an empty path becomes "/"', () => {
  const out = deriveTwaUrl('https://h.ts.net')
  assert.equal(out.pathPrefix, '/')
  assert.equal(out.startUrl, 'https://h.ts.net/')
})

test('http is refused unless the caller opts in (local debug variant only)', () => {
  assert.throws(() => deriveTwaUrl('http://127.0.0.1:47615/review-queue/m/'), /https/)
  const out = deriveTwaUrl('http://127.0.0.1:47615/review-queue/m/', { allowHttp: true })
  assert.equal(out.scheme, 'http')
  assert.equal(out.origin, 'http://127.0.0.1:47615')
  assert.equal(out.port, '47615')
})

test('garbage, other schemes and embedded credentials are refused', () => {
  for (const bad of ['', 'not a url', 'ftp://h.ts.net/', 'https://user:pw@h.ts.net/', undefined, 42]) {
    assert.throws(() => deriveTwaUrl(bad), undefined, String(bad))
  }
})

test('the start URL comes from an explicit value, else from the hub publicUrl plus the phone path', () => {
  assert.equal(startUrlFromConfig({ publicUrl: 'https://h.ts.net' }), 'https://h.ts.net/review-queue/m/')
  assert.equal(startUrlFromConfig({ publicUrl: 'https://h.ts.net/ignored/path?x' }), 'https://h.ts.net/review-queue/m/')
  assert.equal(startUrlFromConfig({ publicUrl: 'https://h.ts.net' }, 'https://other.ts.net/review-queue/m/'), 'https://other.ts.net/review-queue/m/')
  assert.throws(() => startUrlFromConfig({}), /publicUrl/)
  assert.throws(() => startUrlFromConfig(undefined), /publicUrl/)
  assert.throws(() => startUrlFromConfig({ publicUrl: 'http://h.ts.net' }), /https/)
})

test('the local debug URL points at the hub on loopback (port from config, else 47615)', () => {
  assert.equal(localDebugUrl({}), 'http://127.0.0.1:47615/review-queue/m/')
  assert.equal(localDebugUrl({ hubPort: 50001 }), 'http://127.0.0.1:50001/review-queue/m/')
  assert.equal(localDebugUrl({ hubPort: 'x' }), 'http://127.0.0.1:47615/review-queue/m/')
  assert.equal(localDebugUrl(undefined), 'http://127.0.0.1:47615/review-queue/m/')
})
