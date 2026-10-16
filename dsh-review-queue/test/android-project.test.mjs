/**
 * Guards the layout of dsh-review-queue/android (hub.md 11.1): what the manifest must and must not declare, what stays out of git
 * and out of the installed plugin, and that the PowerShell helpers parse. The Gradle build itself is exercised by android/build.ps1.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseProperties } from '../android/tools/project-props.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const android = join(root, 'android')
const read = (...p) => readFileSync(join(android, ...p), 'utf8')
const manifest = () => read('app/src/main/AndroidManifest.xml')

test('the project files listed in hub.md 11.1 exist', () => {
  for (const f of [
    'settings.gradle.kts', 'build.gradle.kts', 'gradle.properties', 'gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar',
    'gradle/wrapper/gradle-wrapper.properties', 'app/build.gradle.kts', 'app/src/main/AndroidManifest.xml',
    'app/src/main/res/values/strings.xml', 'app/src/main/res/values/bools.xml', 'app/src/main/res/values/colors.xml',
    'app/src/main/res/drawable-nodpi/ic_launcher_art.png', 'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
    'app/src/main/res/drawable/ic_notification.xml',
    'build.ps1', 'install.ps1', 'fingerprint.ps1', 'adb-check.ps1', 'make-release-key.ps1', 'README.md', 'keystore.properties.example', '.gitignore',
  ]) assert.ok(existsSync(join(android, f)), f)
})

test('versions: Gradle 8.13 wrapper, AGP 8.13.x, androidbrowserhelper 2.7.4, SDK 36, minSdk 26', () => {
  assert.match(read('gradle/wrapper/gradle-wrapper.properties'), /gradle-8\.13-bin\.zip/)
  assert.match(read('build.gradle.kts'), /com\.android\.application"\) version "8\.13\.\d+"/)
  const app = read('app/build.gradle.kts')
  assert.match(app, /com\.google\.androidbrowserhelper:androidbrowserhelper:2\.7\.4/)
  assert.match(app, /compileSdk = 36/)
  assert.match(app, /targetSdk = 36/)
  assert.match(app, /minSdk = 26/)
})

test('the application id comes from gradle.properties and is a valid package name', () => {
  const props = parseProperties(read('gradle.properties'))
  assert.match(props['rq.applicationId'], /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  assert.match(read('app/build.gradle.kts'), /rq\.applicationId/)
})

test('manifest: LauncherActivity with the start URL, the pinned Chrome and the app-to-site statements', () => {
  const m = manifest()
  assert.match(m, /com\.google\.androidbrowserhelper\.trusted\.LauncherActivity/)
  assert.match(m, /android\.support\.customtabs\.trusted\.DEFAULT_URL"\s+android:value="@string\/default_url"/)
  assert.match(m, /android\.support\.customtabs\.trusted\.LAUNCHING_BROWSER"\s+android:value="com\.android\.chrome"/)
  assert.match(m, /name="asset_statements"\s+android:resource="@string\/asset_statements"/)
  assert.match(m, /android\.intent\.action\.MAIN/)
  assert.match(m, /android\.intent\.category\.LAUNCHER/)
})

test('manifest: delegation service sits behind a boolean resource that defaults to off', () => {
  const m = manifest()
  assert.match(m, /com\.google\.androidbrowserhelper\.trusted\.DelegationService/)
  assert.match(m, /android:enabled="@bool\/enable_notification_delegation"/)
  assert.match(m, /TRUSTED_WEB_ACTIVITY_SERVICE/)
  assert.match(read('app/src/main/res/values/bools.xml'), /<bool name="enable_notification_delegation">false<\/bool>/)
})

test('manifest: POST_NOTIFICATIONS yes; no autoVerify, no INTERNET permission, no cleartext allowance', () => {
  const m = manifest()
  assert.match(m, /android\.permission\.POST_NOTIFICATIONS/)
  assert.doesNotMatch(m, /autoVerify/)
  assert.doesNotMatch(m, /android\.permission\.INTERNET/)
  assert.doesNotMatch(m, /usesCleartextTraffic="true"/)
})

test('the release variant never carries the local (loopback) URL: only the localDebug build type does', () => {
  const app = read('app/build.gradle.kts')
  assert.match(app, /create\("localDebug"\)/)
  assert.match(app, /applicationIdSuffix = "\.local"/)
  assert.doesNotMatch(app, /127\.0\.0\.1/)
  assert.doesNotMatch(manifest(), /127\.0\.0\.1/)
  assert.doesNotMatch(read('app/src/main/res/values/strings.xml'), /127\.0\.0\.1/)
})

test('android/.gitignore keeps build output, local paths and every key file out of git', () => {
  const lines = read('.gitignore').split(/\r?\n/).map((l) => l.trim())
  for (const want of ['build/', '.gradle/', 'local.properties', 'keystore.properties', '*.jks', '*.keystore']) assert.ok(lines.includes(want), want)
  assert.ok(lines.some((l) => l.includes('twa.xml')), 'generated resources')
})

test('keystore.properties.example names the four keys and holds no real value', () => {
  const props = parseProperties(read('keystore.properties.example'))
  assert.deepEqual(Object.keys(props).sort(), ['keyAlias', 'keyPassword', 'storeFile', 'storePassword'])
  assert.match(props.storePassword, /CHANGE|change|<.*>/)
})

test('package.json "files" does not ship android/ in the installed plugin, and the test script runs the android tests', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.ok(!pkg.files.some((f) => f === 'android' || f.startsWith('android/')))
  for (const t of ['android-twa-url', 'android-twa-resources', 'android-fingerprints', 'android-adb-parse', 'android-project']) {
    assert.ok(pkg.scripts.test.includes('test/' + t + '.test.mjs'), t)
  }
})

test('the launcher art is a byte copy of the PWA icon (lib/mobile/icon-512.png)', () => {
  const a = readFileSync(join(android, 'app/src/main/res/drawable-nodpi/ic_launcher_art.png'))
  const b = readFileSync(join(root, 'lib/mobile/icon-512.png'))
  assert.ok(a.equals(b))
})

test('every PowerShell helper parses without errors', (t) => {
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) return t.skip('pwsh not available')
  for (const f of ['build.ps1', 'install.ps1', 'fingerprint.ps1', 'adb-check.ps1', 'make-release-key.ps1']) {
    const path = join(android, f).replaceAll("'", "''")
    const cmd = "$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('" + path + "',[ref]$t,[ref]$e);$e|%{$_.Message};exit $e.Count"
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' })
    assert.equal(r.status, 0, f + ': ' + r.stdout)
  }
})

test('no PowerShell helper or Gradle file prints or embeds a password value', () => {
  for (const f of ['build.ps1', 'install.ps1', 'fingerprint.ps1', 'adb-check.ps1', 'make-release-key.ps1', 'app/build.gradle.kts']) {
    const text = read(f)
    assert.doesNotMatch(text, /Write-(Host|Output)[^\n]*\$(store|key)Password/i, f)
    assert.doesNotMatch(text, /(storePassword|keyPassword)\s*=\s*"[^"$]+"/, f)
  }
})
