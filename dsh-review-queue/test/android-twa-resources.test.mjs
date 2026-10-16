import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { androidString, buildAssetStatements, buildTwaResourcesXml } from '../android/tools/twa-resources.mjs'
import { generateResources } from '../android/tools/gen-resources.mjs'

const URL = 'https://awang-lpt2.taile1279d.ts.net/review-queue/m/'

/** Undo androidString for the test: what aapt2 does when it reads the value. */
function unescape(v) {
  return v.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c)).replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}
const field = (xml, name) => {
  const m = new RegExp('<string name="' + name + '"[^>]*>(.*?)</string>', 's').exec(xml)
  return m ? unescape(m[1]) : undefined
}

test('androidString escapes what aapt2 and XML would otherwise misread', () => {
  assert.equal(androidString('a"b'), 'a\\"b')
  assert.equal(androidString("it's"), "it\\'s")
  assert.equal(androidString('a & b < c > d'), 'a &amp; b &lt; c &gt; d')
  assert.equal(androidString('@string/x'), '\\@string/x')
  assert.equal(androidString('?attr/x'), '\\?attr/x')
  assert.equal(androidString('line\nbreak'), 'line\\nbreak')
  assert.equal(androidString('plain'), 'plain')
})

test('asset statements: one web target for the origin with handle_all_urls', () => {
  assert.deepEqual(JSON.parse(buildAssetStatements('https://h.ts.net')), [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'web', site: 'https://h.ts.net' },
  }])
})

test('asset statements: an http origin gets none (the file format is https only)', () => {
  assert.equal(buildAssetStatements('http://127.0.0.1:47615'), '[]')
})

test('the generated resources hold the start URL, host, path prefix and the statements', () => {
  const xml = buildTwaResourcesXml(URL)
  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>/)
  assert.match(xml, /generated/i)
  assert.equal(field(xml, 'default_url'), URL)
  assert.equal(field(xml, 'twa_host'), 'awang-lpt2.taile1279d.ts.net')
  assert.equal(field(xml, 'twa_path_prefix'), '/review-queue/m/')
  assert.deepEqual(JSON.parse(field(xml, 'asset_statements')), JSON.parse(buildAssetStatements('https://awang-lpt2.taile1279d.ts.net')))
})

test('generateResources writes the main and the local debug resources and syncs the launcher art', () => {
  const root = mkdtempSync(join(tmpdir(), 'rq-android-'))
  const icon = join(root, 'icon-512.png')
  writeFileSync(icon, Buffer.from([1, 2, 3, 4]))
  const out = generateResources({ androidDir: root, hubConfig: { publicUrl: 'https://h.ts.net', hubPort: 50001 }, iconSource: icon })
  const main = readFileSync(join(root, 'app/src/main/res/values/twa.xml'), 'utf8')
  const local = readFileSync(join(root, 'app/src/localDebug/res/values/twa.xml'), 'utf8')
  assert.equal(field(main, 'default_url'), 'https://h.ts.net/review-queue/m/')
  assert.equal(field(local, 'default_url'), 'http://127.0.0.1:50001/review-queue/m/')
  assert.equal(field(local, 'asset_statements'), '[]')
  assert.deepEqual([...readFileSync(join(root, 'app/src/main/res/drawable-nodpi/ic_launcher_art.png'))], [1, 2, 3, 4])
  assert.equal(out.startUrl, 'https://h.ts.net/review-queue/m/')
  assert.ok(existsSync(join(root, 'app/src/main/res/values/twa.xml')))
})

test('generateResources refuses a config without a usable publicUrl and writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'rq-android-'))
  mkdirSync(join(root, 'app'), { recursive: true })
  assert.throws(() => generateResources({ androidDir: root, hubConfig: {}, iconSource: join(root, 'none.png') }), /publicUrl/)
  assert.equal(existsSync(join(root, 'app/src/main/res/values/twa.xml')), false)
})
