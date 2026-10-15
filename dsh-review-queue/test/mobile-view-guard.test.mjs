import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILES } from '../mobile.js'

// Mobile-view guard: the phone PWA/TWA must always render in mobile view. Chrome's "Desktop site" setting makes the phone report a desktop
// user agent and a ~980 CSS px layout viewport, which breaks the layout. viewIssue() is pure; views.js shows the result as a banner.
// The module is imported per test (not at the top) so each case fails on its own while lib/mobile/view-guard.js does not exist yet.
const load = async () => (await import('../lib/mobile/view-guard.js')).viewIssue

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36'
const DESKTOP_SITE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const ANDROID_TABLET_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36' // Android without "Mobile"
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

test('a normal phone (mobile user agent, ~384 px viewport, touch) gets no warning', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: PHONE_UA, innerWidth: 384, maxTouchPoints: 5 }), null)
})

test('the reduced Chrome mobile user agent (Android 10; K ... Mobile Safari) is accepted', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36', innerWidth: 412, maxTouchPoints: 5 }), null)
})

test('a touch device sending the desktop-site user agent is flagged desktop-ua', async () => {
  const viewIssue = await load()
  const issue = viewIssue({ userAgent: DESKTOP_SITE_UA, innerWidth: 384, maxTouchPoints: 5 })
  assert.equal(issue?.kind, 'desktop-ua')
})

test('a touch device with a Windows desktop user agent is flagged desktop-ua', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: WINDOWS_UA, innerWidth: 384, maxTouchPoints: 1 })?.kind, 'desktop-ua')
})

test('Android without "Mobile" in the user agent counts as a desktop user agent', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: ANDROID_TABLET_UA, innerWidth: 384, maxTouchPoints: 5 })?.kind, 'desktop-ua')
})

test('"Mobile" without "Android" does not count as a mobile user agent', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Mobile Safari/537.36', innerWidth: 384, maxTouchPoints: 5 })?.kind, 'desktop-ua')
})

test('a touch device with a mobile user agent but a 980 px layout viewport is flagged wide-viewport', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: PHONE_UA, innerWidth: 980, maxTouchPoints: 5 })?.kind, 'wide-viewport')
})

test('the wide-viewport threshold is 900 px: 900 is flagged, 899 is not', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: PHONE_UA, innerWidth: 900, maxTouchPoints: 5 })?.kind, 'wide-viewport')
  assert.equal(viewIssue({ userAgent: PHONE_UA, innerWidth: 899, maxTouchPoints: 5 }), null)
})

test('desktop-ua wins when both the user agent and the viewport are wrong (Chrome "Desktop site": desktop UA, 980 px)', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: DESKTOP_SITE_UA, innerWidth: 980, maxTouchPoints: 5 })?.kind, 'desktop-ua')
})

test('a real desktop browser (no touch points) gets no warning, whatever its user agent or width', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: DESKTOP_SITE_UA, innerWidth: 1920, maxTouchPoints: 0 }), null)
  assert.equal(viewIssue({ userAgent: WINDOWS_UA, innerWidth: 1280, maxTouchPoints: 0 }), null)
  assert.equal(viewIssue({ userAgent: PHONE_UA, innerWidth: 980, maxTouchPoints: 0 }), null)
})

test('missing or invalid maxTouchPoints counts as not a touch device', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: DESKTOP_SITE_UA, innerWidth: 980 }), null)
  assert.equal(viewIssue({ userAgent: DESKTOP_SITE_UA, innerWidth: 980, maxTouchPoints: 'many' }), null)
  assert.equal(viewIssue({ userAgent: DESKTOP_SITE_UA, innerWidth: 980, maxTouchPoints: -1 }), null)
})

test('a missing or non-string user agent never throws; with no user agent to judge, only the width rule can fire', async () => {
  const viewIssue = await load()
  assert.doesNotThrow(() => viewIssue({ innerWidth: 384, maxTouchPoints: 5 }))
  assert.equal(viewIssue({ innerWidth: 384, maxTouchPoints: 5 }), null)
  assert.equal(viewIssue({ userAgent: 42, innerWidth: 384, maxTouchPoints: 5 }), null)
  assert.equal(viewIssue({ userAgent: null, innerWidth: 384, maxTouchPoints: 5 }), null)
  assert.equal(viewIssue({ innerWidth: 980, maxTouchPoints: 5 })?.kind, 'wide-viewport')
})

test('a non-number innerWidth never throws and cannot trigger wide-viewport', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: PHONE_UA, innerWidth: undefined, maxTouchPoints: 5 }), null)
  assert.equal(viewIssue({ userAgent: PHONE_UA, innerWidth: '980', maxTouchPoints: 5 }), null)
  assert.equal(viewIssue({ userAgent: PHONE_UA, innerWidth: NaN, maxTouchPoints: 5 }), null)
  assert.equal(viewIssue({ userAgent: DESKTOP_SITE_UA, innerWidth: undefined, maxTouchPoints: 5 })?.kind, 'desktop-ua')
})

test('calling with nothing or an empty object never throws and returns null', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({}), null)
  assert.equal(viewIssue(), null)
})

test('the message is a short plain sentence that names Chrome menu > Desktop site', async () => {
  const viewIssue = await load()
  for (const input of [{ userAgent: DESKTOP_SITE_UA, innerWidth: 980, maxTouchPoints: 5 }, { userAgent: PHONE_UA, innerWidth: 980, maxTouchPoints: 5 }]) {
    const issue = viewIssue(input)
    assert.equal(typeof issue.message, 'string')
    assert.match(issue.message, /Desktop site/)
    assert.match(issue.message, /Chrome/)
    assert.ok(issue.message.length > 0 && issue.message.length <= 160, 'length ' + issue.message.length)
    assert.ok(!/[\r\n]/.test(issue.message), 'single line')
  }
})

// ---- iPhone / iPod / iPad (iOS support) ----------------------------------------------------------------------------------------------
// Safari has no Android-style "Mobile" token in a way the guard can rely on: an iPhone/iPod UA counts as a mobile UA by itself.
// iPad (and iPadOS in desktop mode, which sends a Macintosh UA with touch points) is a tablet: tablet widths are legitimate, so no warning at all.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPOD_UA = 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1'
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPADOS_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const IPHONE_CHROME_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1'

test('an iPhone (Safari UA, 390 px viewport, touch) gets no warning', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: IPHONE_UA, innerWidth: 390, maxTouchPoints: 5 }), null)
})

test('an iPod and Chrome on iPhone (CriOS) also count as a mobile user agent', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: IPOD_UA, innerWidth: 320, maxTouchPoints: 5 }), null)
  assert.equal(viewIssue({ userAgent: IPHONE_CHROME_UA, innerWidth: 390, maxTouchPoints: 5 }), null)
})

test('an iPhone UA is never flagged desktop-ua (it is a mobile UA, with or without the "Mobile" token)', async () => {
  const viewIssue = await load()
  const noMobileToken = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/604.1'
  assert.equal(viewIssue({ userAgent: noMobileToken, innerWidth: 390, maxTouchPoints: 5 }), null)
})

test('wide-viewport still applies to iPhone and iPod: 900 is flagged, 899 is not', async () => {
  const viewIssue = await load()
  for (const userAgent of [IPHONE_UA, IPOD_UA]) {
    assert.equal(viewIssue({ userAgent, innerWidth: 980, maxTouchPoints: 5 })?.kind, 'wide-viewport')
    assert.equal(viewIssue({ userAgent, innerWidth: 900, maxTouchPoints: 5 })?.kind, 'wide-viewport')
    assert.equal(viewIssue({ userAgent, innerWidth: 899, maxTouchPoints: 5 }), null)
  }
})

test('an iPhone without touch points is not judged (same rule as every other device)', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: IPHONE_UA, innerWidth: 980, maxTouchPoints: 0 }), null)
})

test('the iPhone wide-viewport message names Safari: tap the aA button, then Request Mobile Website; it does not mention Chrome', async () => {
  const viewIssue = await load()
  for (const userAgent of [IPHONE_UA, IPOD_UA]) {
    const issue = viewIssue({ userAgent, innerWidth: 980, maxTouchPoints: 5 })
    assert.equal(typeof issue.message, 'string')
    assert.match(issue.message, /Safari/)
    assert.match(issue.message, /aA/)
    assert.match(issue.message, /Request Mobile Website/)
    assert.ok(!/Chrome/.test(issue.message), 'no Chrome wording on an iPhone')
    assert.ok(issue.message.length > 0 && issue.message.length <= 160, 'length ' + issue.message.length)
    assert.ok(!/[\r\n]/.test(issue.message), 'single line')
  }
})

test('the Android messages are unchanged: desktop-ua and wide-viewport still tell the user to untick Desktop site in Chrome', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: DESKTOP_SITE_UA, innerWidth: 980, maxTouchPoints: 5 }).message, 'Chrome is showing the desktop site. Untick Chrome menu > Desktop site to get the phone layout.')
  assert.equal(viewIssue({ userAgent: PHONE_UA, innerWidth: 980, maxTouchPoints: 5 }).message, 'This page is laid out too wide for a phone. Untick Chrome menu > Desktop site in Chrome.')
})

test('an iPad gets no warning, whatever its width (tablet widths are legitimate)', async () => {
  const viewIssue = await load()
  for (const innerWidth of [768, 820, 1024, 1366]) assert.equal(viewIssue({ userAgent: IPAD_UA, innerWidth, maxTouchPoints: 5 }), null, 'width ' + innerWidth)
})

test('iPadOS in desktop mode (Macintosh UA with more than one touch point) gets no warning at all, narrow or wide', async () => {
  const viewIssue = await load()
  for (const innerWidth of [320, 768, 980, 1180]) assert.equal(viewIssue({ userAgent: IPADOS_DESKTOP_UA, innerWidth, maxTouchPoints: 5 }), null, 'width ' + innerWidth)
  assert.equal(viewIssue({ userAgent: IPADOS_DESKTOP_UA, innerWidth: 980, maxTouchPoints: 2 }), null)
})

test('"Mobile" with neither Android nor iPhone/iPod still counts as a desktop user agent on a touch device', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Mobile Safari/537.36', innerWidth: 384, maxTouchPoints: 5 })?.kind, 'desktop-ua')
})

test('a real Mac (Macintosh UA, no touch points) gets no warning', async () => {
  const viewIssue = await load()
  assert.equal(viewIssue({ userAgent: IPADOS_DESKTOP_UA, innerWidth: 1440, maxTouchPoints: 0 }), null)
})

// Banner wiring: source-text checks in the style of mobile-static / mobile-style (the repo has no DOM harness for the Preact views).
const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'mobile')
const views = readFileSync(join(MOBILE, 'views.js'), 'utf8')
const css = readFileSync(join(MOBILE, 'style.css'), 'utf8')

test('view-guard.js is served by the phone router as JavaScript', () => {
  assert.ok(Object.hasOwn(FILES, 'view-guard.js'), 'FILES lists view-guard.js')
  assert.match(FILES['view-guard.js'].type, /javascript/)
})

test('views.js imports viewIssue from ./view-guard.js', () => {
  assert.match(views, /import\s*\{[^}]*\bviewIssue\b[^}]*\}\s*from\s*['"]\.\/view-guard\.js['"]/)
})

test('views.js renders a "banner view-guard" element when viewIssue returns an issue, showing its message', () => {
  assert.match(views, /class=\\?"banner view-guard\\?"|class=\$\{['"`]banner view-guard['"`]\}/)
  assert.match(views, /\.message\b/, 'the banner shows issue.message')
})

test('views.js feeds viewIssue from navigator.userAgent, window.innerWidth and navigator.maxTouchPoints', () => {
  assert.match(views, /viewIssue\(\s*\{[^}]*userAgent:\s*navigator\.userAgent/)
  assert.match(views, /viewIssue\(\s*\{[^}]*innerWidth:\s*window\.innerWidth/)
  assert.match(views, /viewIssue\(\s*\{[^}]*maxTouchPoints:\s*navigator\.maxTouchPoints/)
})

test('views.js re-evaluates the guard on window resize and removes the listener on cleanup', () => {
  assert.match(views, /window\.addEventListener\(\s*['"]resize['"]/)
  assert.match(views, /window\.removeEventListener\(\s*['"]resize['"]/)
})

test('the banner reuses the existing .banner style (no separate colours needed)', () => {
  assert.match(css, /(^|\n)\.banner\s*\{/)
})
