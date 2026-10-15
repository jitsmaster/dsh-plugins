import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildAssetLinks } from '../hub/assetlinks.js'
import { loadHubConfig } from '../hub/config.js'
import { tmpDir } from './hub-helpers.mjs'

const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89'
const FP2 = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00'
const android = (over = {}) => ({ packageName: 'com.example.rq', sha256CertFingerprints: [FP], ...over })

test('not configured: an empty statements list (still valid JSON for Chrome)', () => {
  assert.deepEqual(buildAssetLinks(undefined), [])
  assert.deepEqual(buildAssetLinks({}), [])
  assert.deepEqual(buildAssetLinks(android({ sha256CertFingerprints: [] })), [])
  assert.deepEqual(buildAssetLinks(android({ packageName: '' })), [])
  assert.deepEqual(buildAssetLinks({ sha256CertFingerprints: [FP] }), [])
})

test('configured: one handle_all_urls statement with the package and every fingerprint', () => {
  assert.deepEqual(buildAssetLinks(android({ sha256CertFingerprints: [FP, FP2] })), [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'com.example.rq', sha256_cert_fingerprints: [FP, FP2] },
  }])
})

test('fingerprints are normalised to upper case with colons; invalid and duplicate ones are dropped', () => {
  const lower = FP.toLowerCase()
  const bare = FP2.replaceAll(':', '')
  const out = buildAssetLinks(android({ sha256CertFingerprints: [lower, FP, bare, 'nonsense', 'AB:CD', 42, null] }))
  assert.deepEqual(out[0].target.sha256_cert_fingerprints, [FP, FP2])
  assert.deepEqual(buildAssetLinks(android({ sha256CertFingerprints: ['nonsense'] })), [])
})

test('an invalid package name gives no statement', () => {
  for (const packageName of ['rq', 'com..x', 'com.example.rq"}]', '1com.x', 'com.example rq', 42]) {
    assert.deepEqual(buildAssetLinks(android({ packageName })), [], String(packageName))
  }
})

test('the result is strict JSON (no trailing commas, round-trips)', () => {
  const links = buildAssetLinks(android())
  assert.deepEqual(JSON.parse(JSON.stringify(links)), links)
})

// ---- hub.config.json -----------------------------------------------------------------------------------------------------------

test('no config file gives the defaults', (t) => {
  const c = loadHubConfig(tmpDir(t))
  assert.deepEqual(c.allowedTailnetLogins, [])
  assert.equal(c.publicUrl, undefined)
  assert.equal(c.hubPort, undefined)
  assert.deepEqual(c.android, { packageName: undefined, sha256CertFingerprints: [] })
})

test('a valid config is read and normalised; publicUrl gives host and origin', (t) => {
  const dir = tmpDir(t)
  writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ hubPort: 47999, publicUrl: 'https://rq.example.ts.net/', allowedTailnetLogins: ['me@example.com', 7], staleGraceMs: 5000, android: android(), pushSubject: 'mailto:me@example.com', secret: 'ignored' }))
  const c = loadHubConfig(dir)
  assert.equal(c.hubPort, 47999)
  assert.equal(c.publicHost, 'rq.example.ts.net')
  assert.equal(c.publicOrigin, 'https://rq.example.ts.net')
  assert.deepEqual(c.allowedTailnetLogins, ['me@example.com'])
  assert.equal(c.staleGraceMs, 5000)
  assert.deepEqual(c.android, android())
  assert.equal(c.pushSubject, 'mailto:me@example.com')
  assert.equal('secret' in c, false)
})

test('a publicUrl with a port keeps it in the host; a bad one, a bad port or broken JSON is ignored without throwing', (t) => {
  const dir = tmpDir(t)
  writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ publicUrl: 'https://rq.example.ts.net:8443' }))
  assert.equal(loadHubConfig(dir).publicHost, 'rq.example.ts.net:8443')
  writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ publicUrl: 'not a url', hubPort: 'x' }))
  const c = loadHubConfig(dir)
  assert.equal(c.publicHost, undefined)
  assert.equal(c.hubPort, undefined)
  writeFileSync(join(dir, 'hub.config.json'), '{broken')
  assert.equal(loadHubConfig(dir).publicHost, undefined)
  const logs = []
  loadHubConfig(dir, { log: (l) => logs.push(l) })
  assert.ok(logs.length > 0, 'a broken config is logged')
})

test('only http(s) public URLs are accepted', (t) => {
  const dir = tmpDir(t)
  writeFileSync(join(dir, 'hub.config.json'), JSON.stringify({ publicUrl: 'ftp://rq.example.ts.net' }))
  assert.equal(loadHubConfig(dir).publicHost, undefined)
})
