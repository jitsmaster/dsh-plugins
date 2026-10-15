import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FILES } from '../mobile.js'

// lib/mobile/platform.js (pure): what kind of device the phone page runs on, and what to tell an iPhone user about push.
//   platformInfo({ userAgent, maxTouchPoints, standalone, hasPush }) -> { ios, iosVersion, standalone, canPush }
//     ios          iPhone / iPod / iPad in the UA, or a Macintosh UA with maxTouchPoints > 1 (iPadOS "desktop website" mode)
//     iosVersion   major.minor from "CPU (iPhone )?OS 17_5" -> 17.5; null when the UA does not say (iPadOS-Mac UA) or the device is not iOS
//     standalone   the caller's boolean: the app was opened from the Home Screen (navigator.standalone === true or display-mode: standalone)
//     canPush      hasPush === true and, on iOS, the app runs from the Home Screen (Web Push on iOS exists only for the installed app)
//   pushHint(info)    -> null | string   (non-iOS: null; iOS in a Safari tab: how to install; iOS installed but older than 16.4: needs 16.4)
//   installHint(info) -> null | string   (the Home Screen text for iOS that is not installed, else null)
//   isStandalone(win) -> boolean         (reads navigator.standalone / matchMedia('(display-mode: standalone)'); never throws)
// The module is imported per test (not at the top) so each case fails on its own while lib/mobile/platform.js does not exist yet.
const load = async () => import('../lib/mobile/platform.js')

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPHONE_OLD_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1'
const IPHONE_164_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1'
const IPOD_UA = 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1'
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36'
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

// ---- served ----------------------------------------------------------------------------------------------------------------------------

test('platform.js is served by the phone router as JavaScript', () => {
  assert.ok(Object.hasOwn(FILES, 'platform.js'), 'FILES lists platform.js')
  assert.match(FILES['platform.js'].type, /javascript/)
})

// ---- platformInfo: ios -----------------------------------------------------------------------------------------------------------------

test('platformInfo: an iPhone, an iPod and an iPad are iOS', async () => {
  const { platformInfo } = await load()
  for (const userAgent of [IPHONE_UA, IPOD_UA, IPAD_UA, IPHONE_CHROME_UA]) assert.equal(platformInfo({ userAgent, maxTouchPoints: 5 }).ios, true, userAgent)
})

test('platformInfo: iPadOS in desktop mode (Macintosh UA with maxTouchPoints > 1) is iOS; a real Mac (0 or 1 touch point) is not', async () => {
  const { platformInfo } = await load()
  assert.equal(platformInfo({ userAgent: MAC_UA, maxTouchPoints: 5 }).ios, true)
  assert.equal(platformInfo({ userAgent: MAC_UA, maxTouchPoints: 2 }).ios, true)
  assert.equal(platformInfo({ userAgent: MAC_UA, maxTouchPoints: 1 }).ios, false)
  assert.equal(platformInfo({ userAgent: MAC_UA, maxTouchPoints: 0 }).ios, false)
  assert.equal(platformInfo({ userAgent: MAC_UA }).ios, false, 'missing maxTouchPoints')
  assert.equal(platformInfo({ userAgent: MAC_UA, maxTouchPoints: 'many' }).ios, false, 'non-number maxTouchPoints')
})

test('platformInfo: Android and Windows are not iOS', async () => {
  const { platformInfo } = await load()
  assert.equal(platformInfo({ userAgent: ANDROID_UA, maxTouchPoints: 5 }).ios, false)
  assert.equal(platformInfo({ userAgent: WINDOWS_UA, maxTouchPoints: 10 }).ios, false)
})

// ---- platformInfo: iosVersion ----------------------------------------------------------------------------------------------------------

test('platformInfo: iosVersion is major.minor from the OS token (iPhone: "CPU iPhone OS 17_5", iPad: "CPU OS 17_5")', async () => {
  const { platformInfo } = await load()
  assert.equal(platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5 }).iosVersion, 17.5)
  assert.equal(platformInfo({ userAgent: IPHONE_164_UA, maxTouchPoints: 5 }).iosVersion, 16.4)
  assert.equal(platformInfo({ userAgent: IPOD_UA, maxTouchPoints: 5 }).iosVersion, 15.8)
  assert.equal(platformInfo({ userAgent: IPAD_UA, maxTouchPoints: 5 }).iosVersion, 17.5)
})

test('platformInfo: a patch level is dropped (16_3_1 -> 16.3) and a bare major ("OS 17_0") is 17', async () => {
  const { platformInfo } = await load()
  assert.equal(platformInfo({ userAgent: IPHONE_OLD_UA, maxTouchPoints: 5 }).iosVersion, 16.3)
  assert.equal(platformInfo({ userAgent: IPHONE_UA.replace('17_5', '17_0'), maxTouchPoints: 5 }).iosVersion, 17)
})

test('platformInfo: iosVersion is null for iPadOS desktop mode (the UA hides it) and for devices that are not iOS', async () => {
  const { platformInfo } = await load()
  assert.equal(platformInfo({ userAgent: MAC_UA, maxTouchPoints: 5 }).iosVersion, null)
  assert.equal(platformInfo({ userAgent: ANDROID_UA, maxTouchPoints: 5 }).iosVersion, null)
  assert.equal(platformInfo({ userAgent: MAC_UA, maxTouchPoints: 0 }).iosVersion, null)
})

test('platformInfo: an iOS UA without a parseable OS token has iosVersion null (still iOS)', async () => {
  const { platformInfo } = await load()
  const info = platformInfo({ userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 })
  assert.equal(info.ios, true)
  assert.equal(info.iosVersion, null)
})

// ---- platformInfo: standalone, canPush -------------------------------------------------------------------------------------------------

test('platformInfo: standalone is the boolean the caller computed; anything else is false', async () => {
  const { platformInfo } = await load()
  assert.equal(platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: true }).standalone, true)
  assert.equal(platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: false }).standalone, false)
  assert.equal(platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5 }).standalone, false)
  assert.equal(platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: 'yes' }).standalone, false)
})

test('platformInfo: canPush needs the push API (hasPush) and, on iOS, the Home Screen app', async () => {
  const { platformInfo } = await load()
  assert.equal(platformInfo({ userAgent: ANDROID_UA, maxTouchPoints: 5, standalone: false, hasPush: true }).canPush, true, 'Android works in a browser tab too')
  assert.equal(platformInfo({ userAgent: ANDROID_UA, maxTouchPoints: 5, standalone: false, hasPush: false }).canPush, false)
  assert.equal(platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: true, hasPush: true }).canPush, true)
  assert.equal(platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: true, hasPush: false }).canPush, false)
  assert.equal(platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: false, hasPush: true }).canPush, false, 'iOS: not from a Safari tab')
  assert.equal(platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5 }).canPush, false)
})

test('platformInfo returns exactly { ios, iosVersion, standalone, canPush } with the right types', async () => {
  const { platformInfo } = await load()
  const info = platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: true, hasPush: true })
  assert.deepEqual(Object.keys(info).sort(), ['canPush', 'ios', 'iosVersion', 'standalone'])
  assert.equal(typeof info.ios, 'boolean')
  assert.equal(typeof info.standalone, 'boolean')
  assert.equal(typeof info.canPush, 'boolean')
})

test('platformInfo never throws on missing or odd input and then says: not iOS, not standalone, no push', async () => {
  const { platformInfo } = await load()
  const none = { ios: false, iosVersion: null, standalone: false, canPush: false }
  assert.deepEqual(platformInfo(), none)
  assert.deepEqual(platformInfo({}), none)
  assert.deepEqual(platformInfo({ userAgent: 42, maxTouchPoints: null, standalone: null, hasPush: null }), none)
  assert.deepEqual(platformInfo({ userAgent: null }), none)
})

// ---- pushHint / installHint ------------------------------------------------------------------------------------------------------------

const info = (over = {}) => ({ ios: true, iosVersion: 17.5, standalone: false, canPush: false, ...over })

test('pushHint is null when the device is not iOS', async () => {
  const { pushHint } = await load()
  assert.equal(pushHint(info({ ios: false, iosVersion: null })), null)
  assert.equal(pushHint(info({ ios: false, iosVersion: null, canPush: true, standalone: true })), null)
})

test('pushHint on iOS in a Safari tab says: tap Share > Add to Home Screen, open the app from the Home Screen, then turn notifications on', async () => {
  const { pushHint } = await load()
  const text = pushHint(info({ standalone: false }))
  assert.equal(typeof text, 'string')
  assert.match(text, /Share/)
  assert.match(text, /Add to Home Screen/)
  assert.match(text, /open the app from the Home Screen/i)
  assert.match(text, /turn notifications on/i)
  assert.ok(!/[\r\n]/.test(text), 'single line')
})

test('pushHint on iOS in a Safari tab gives the Home Screen text whatever the iOS version (also an unknown one)', async () => {
  const { pushHint } = await load()
  for (const iosVersion of [null, 15.8, 16.4, 17.5]) assert.match(pushHint(info({ standalone: false, iosVersion })), /Add to Home Screen/, String(iosVersion))
})

test('pushHint on an installed iOS app older than 16.4 says "Notifications need iOS 16.4 or later"', async () => {
  const { pushHint } = await load()
  for (const iosVersion of [16.3, 15.8, 14]) assert.match(pushHint(info({ standalone: true, iosVersion })), /^Notifications need iOS 16\.4 or later/, String(iosVersion))
})

test('pushHint on an installed iOS app is null from 16.4 on, and when the version is unknown (iPadOS desktop mode)', async () => {
  const { pushHint } = await load()
  assert.equal(pushHint(info({ standalone: true, iosVersion: 16.4 })), null)
  assert.equal(pushHint(info({ standalone: true, iosVersion: 17.5 })), null)
  assert.equal(pushHint(info({ standalone: true, iosVersion: null })), null)
})

test('pushHint never throws on missing input and returns null', async () => {
  const { pushHint } = await load()
  assert.equal(pushHint(), null)
  assert.equal(pushHint(null), null)
  assert.equal(pushHint({}), null)
})

test('installHint is the Home Screen text for iOS that is not installed, and null otherwise', async () => {
  const { installHint, pushHint } = await load()
  const text = installHint(info({ standalone: false }))
  assert.equal(text, pushHint(info({ standalone: false })), 'the same text as the push hint')
  assert.match(text, /Add to Home Screen/)
  assert.equal(installHint(info({ standalone: true })), null, 'installed')
  assert.equal(installHint(info({ standalone: true, iosVersion: 15 })), null, 'installed, even when too old: that is the push hint, not the install hint')
  assert.equal(installHint(info({ ios: false, iosVersion: null })), null, 'not iOS')
  assert.equal(installHint(), null)
  assert.equal(installHint({}), null)
})

test('platformInfo feeds the hints end to end: iPhone Safari tab -> install hint; the same iPhone from the Home Screen -> none', async () => {
  const { platformInfo, pushHint, installHint } = await load()
  const tab = platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: false, hasPush: false })
  assert.match(installHint(tab), /Add to Home Screen/)
  assert.match(pushHint(tab), /Add to Home Screen/)
  const app = platformInfo({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: true, hasPush: true })
  assert.equal(installHint(app), null)
  assert.equal(pushHint(app), null)
  const old = platformInfo({ userAgent: IPHONE_OLD_UA, maxTouchPoints: 5, standalone: true, hasPush: false })
  assert.match(pushHint(old), /16\.4/)
  assert.equal(installHint(old), null)
  const android = platformInfo({ userAgent: ANDROID_UA, maxTouchPoints: 5, standalone: false, hasPush: true })
  assert.equal(pushHint(android), null)
  assert.equal(installHint(android), null)
})

// ---- isStandalone ----------------------------------------------------------------------------------------------------------------------

const asked = []
const media = (matches) => (query) => { asked.push(query); return { matches } }

test('isStandalone is true when navigator.standalone is true (Safari Home Screen app)', async () => {
  const { isStandalone } = await load()
  assert.equal(isStandalone({ navigator: { standalone: true } }), true)
  assert.equal(isStandalone({ navigator: { standalone: true }, matchMedia: media(false) }), true)
})

test('isStandalone is true when display-mode: standalone matches (installed Chrome / TWA), and asks exactly that query', async () => {
  const { isStandalone } = await load()
  asked.length = 0
  assert.equal(isStandalone({ navigator: {}, matchMedia: media(true) }), true)
  assert.deepEqual(asked, ['(display-mode: standalone)'])
})

test('isStandalone is false in a browser tab', async () => {
  const { isStandalone } = await load()
  assert.equal(isStandalone({ navigator: { standalone: false }, matchMedia: media(false) }), false)
  assert.equal(isStandalone({ navigator: {}, matchMedia: media(false) }), false)
  assert.equal(isStandalone({ navigator: {} }), false, 'no matchMedia')
})

test('isStandalone only trusts navigator.standalone === true (a truthy string is not enough)', async () => {
  const { isStandalone } = await load()
  assert.equal(isStandalone({ navigator: { standalone: 'true' }, matchMedia: media(false) }), false)
  assert.equal(isStandalone({ navigator: { standalone: 1 } }), false)
})

test('isStandalone never throws: no window, no navigator, a throwing matchMedia or navigator getter, a null media list', async () => {
  const { isStandalone } = await load()
  assert.equal(isStandalone(undefined), false)
  assert.equal(isStandalone(null), false)
  assert.equal(isStandalone({}), false)
  assert.equal(isStandalone({ navigator: {}, matchMedia: () => { throw new Error('boom') } }), false)
  assert.equal(isStandalone({ navigator: {}, matchMedia: () => null }), false)
  assert.equal(isStandalone({ navigator: {}, matchMedia: 'nope' }), false)
  const hostile = { get navigator() { throw new Error('boom') }, matchMedia: media(true) }
  assert.doesNotThrow(() => isStandalone(hostile))
  assert.equal(isStandalone({ navigator: { get standalone() { throw new Error('boom') } }, matchMedia: media(true) }), true, 'a throwing navigator.standalone falls through to display-mode')
})
