import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDevices, chooseDevice, launchMode, parsePackageInfo, notificationsFor, hasAddressBarHint } from '../android/tools/adb-parse.mjs'

test('parseDevices reads serial and state and ignores the header and daemon chatter', () => {
  const text = '* daemon not running; starting now at tcp:5037\r\n* daemon started successfully\r\nList of devices attached\r\nemulator-5554\tdevice\r\nR5CW30PD58H\tunauthorized\r\n\r\n'
  assert.deepEqual(parseDevices(text), [{ serial: 'emulator-5554', state: 'device' }, { serial: 'R5CW30PD58H', state: 'unauthorized' }])
  assert.deepEqual(parseDevices('List of devices attached\n\n'), [])
})

test('chooseDevice: the named serial, else the single online device; otherwise an explanatory error', () => {
  const two = [{ serial: 'emulator-5554', state: 'device' }, { serial: 'R5CW30PD58H', state: 'device' }]
  assert.equal(chooseDevice(two, 'R5CW30PD58H'), 'R5CW30PD58H')
  assert.equal(chooseDevice([{ serial: 'a', state: 'device' }, { serial: 'b', state: 'offline' }]), 'a')
  assert.throws(() => chooseDevice(two), /several/i)
  assert.throws(() => chooseDevice([]), /no device/i)
  assert.throws(() => chooseDevice([{ serial: 'a', state: 'unauthorized' }]), /unauthorized/i)
  assert.throws(() => chooseDevice(two, 'nope'), /nope/)
})

test('launchMode: the library line "Launching Trusted Web Activity." means TWA was requested', () => {
  const log = '10-15 16:00:00.000 D/TWALauncherActivity( 1): Using url from Manifest: https://h.ts.net/review-queue/m/\n10-15 16:00:00.100 D/TwaLauncher( 1): Launching Trusted Web Activity.'
  assert.deepEqual(launchMode(log), { mode: 'TRUSTED_WEB_ACTIVITY', url: 'https://h.ts.net/review-queue/m/' })
})

test('launchMode: a launch without the TWA line is a Custom Tab; no launch line at all is UNKNOWN', () => {
  assert.deepEqual(launchMode('D/TWALauncherActivity( 1): Using url from Manifest: http://127.0.0.1:47615/review-queue/m/'), { mode: 'CUSTOM_TAB', url: 'http://127.0.0.1:47615/review-queue/m/' })
  assert.deepEqual(launchMode(''), { mode: 'UNKNOWN', url: undefined })
  assert.deepEqual(launchMode(undefined), { mode: 'UNKNOWN', url: undefined })
})

test('launchMode: the last launch in the log wins', () => {
  const log = 'D/TWALauncherActivity: Using url from Manifest: https://a/\nD/TwaLauncher: Launching Trusted Web Activity.\nD/TWALauncherActivity: Using url from Manifest: http://b/'
  assert.deepEqual(launchMode(log), { mode: 'CUSTOM_TAB', url: 'http://b/' })
})

test('parsePackageInfo reads version, install time and installer from dumpsys package; undefined when not installed', () => {
  const dump = ['Packages:', '  Package [com.dsh.reviewqueue] (abc):', '    versionCode=1 minSdk=26 targetSdk=35', '    versionName=1.0.0', '    firstInstallTime=2026-10-15 16:00:00', '    installerPackageName=null'].join('\n')
  assert.deepEqual(parsePackageInfo(dump, 'com.dsh.reviewqueue'), { packageName: 'com.dsh.reviewqueue', versionCode: 1, versionName: '1.0.0', minSdk: 26, targetSdk: 35, firstInstallTime: '2026-10-15 16:00:00' })
  assert.equal(parsePackageInfo('Unable to find package: com.dsh.reviewqueue', 'com.dsh.reviewqueue'), undefined)
  assert.equal(parsePackageInfo('', 'com.dsh.reviewqueue'), undefined)
})

test('notificationsFor lists the notification records owned by the package', () => {
  const dump = ['  Notification List:', '    NotificationRecord(0x1 pkg=com.dsh.reviewqueue user=UserHandle{0} id=1 tag=rq-q importance=3 key=0|com.dsh.reviewqueue|1|rq-q|10001: Notification(channel=c)', '    NotificationRecord(0x2 pkg=com.android.chrome user=UserHandle{0} id=2 tag=x importance=3 key=0|com.android.chrome|2|x|10002: Notification(channel=c)'].join('\n')
  const out = notificationsFor(dump, 'com.dsh.reviewqueue')
  assert.equal(out.length, 1)
  assert.equal(out[0].tag, 'rq-q')
  assert.deepEqual(notificationsFor('', 'com.dsh.reviewqueue'), [])
})

test('hasAddressBarHint is a heuristic over the UI dump: a url bar node means an address bar is visible', () => {
  assert.equal(hasAddressBarHint('<node resource-id="com.android.chrome:id/url_bar" text="h.ts.net" />'), true)
  assert.equal(hasAddressBarHint('<node resource-id="com.android.chrome:id/toolbar" /><node resource-id="com.android.chrome:id/custom_tabs_toolbar" />'), true)
  assert.equal(hasAddressBarHint('<node resource-id="android:id/content" />'), false)
  assert.equal(hasAddressBarHint(undefined), false)
})
