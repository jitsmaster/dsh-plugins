import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// iPhone support wiring (source-text checks in the style of mobile-static / mobile-view-guard: the repo has no DOM harness for the Preact views).
// The behaviour itself is tested in mobile-platform / mobile-view-guard / mobile-dictation / mobile-push-client / mobile-icons.
const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'mobile')
const read = (name) => readFileSync(join(MOBILE, name), 'utf8')
const page = read('index.html')
const views = read('views.js')
const settings = read('settings.js')

/** Every <tag ...> of the page as an attribute object, whatever the attribute order or quoting. */
function tags(html, name) {
  return [...html.matchAll(new RegExp('<' + name + '\\b([^>]*)>', 'gi'))].map((m) => Object.fromEntries([...m[1].matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)].map((a) => [a[1], a[2]])))
}
const meta = (name) => tags(page, 'meta').filter((t) => t.name === name)

// ---- index.html: the iOS Home Screen app ---------------------------------------------------------------------------------------------------

test('index.html makes the Home Screen app standalone: apple-mobile-web-app-capable = yes', () => {
  const found = meta('apple-mobile-web-app-capable')
  assert.equal(found.length, 1)
  assert.equal(found[0].content, 'yes')
})

test('index.html names the Home Screen app "Coding Boss Review Queue"', () => {
  const found = meta('apple-mobile-web-app-title')
  assert.equal(found.length, 1)
  assert.equal(found[0].content, 'Coding Boss Review Queue')
})

test('index.html sets the iOS status bar style to black', () => {
  const found = meta('apple-mobile-web-app-status-bar-style')
  assert.equal(found.length, 1)
  assert.equal(found[0].content, 'black')
})

test('index.html has one apple-touch-icon: 180x180, ./icon-180.png (the 192 one is replaced)', () => {
  const icons = tags(page, 'link').filter((t) => t.rel === 'apple-touch-icon')
  assert.equal(icons.length, 1)
  assert.equal(icons[0].sizes, '180x180')
  assert.equal(icons[0].href, './icon-180.png')
  assert.ok(!icons.some((t) => /icon-192/.test(t.href)), 'no apple-touch-icon points at the 192 icon')
})

test('index.html keeps the manifest, the viewport (with viewport-fit=cover) and the 192 favicon', () => {
  assert.ok(tags(page, 'link').some((t) => t.rel === 'manifest' && t.href === './manifest.webmanifest'))
  assert.ok(meta('viewport').some((t) => /viewport-fit=cover/.test(t.content)))
  assert.ok(tags(page, 'link').some((t) => t.rel === 'icon' && t.href === './icon-192.png'))
})

// ---- settings.js: say why push cannot work on iOS --------------------------------------------------------------------------------------------

test('settings.js imports platformInfo, pushHint and isStandalone from ./platform.js', () => {
  assert.match(settings, /import\s*\{[^}]*\bplatformInfo\b[^}]*\}\s*from\s*['"]\.\/platform\.js['"]/)
  assert.match(settings, /import\s*\{[^}]*\bpushHint\b[^}]*\}\s*from\s*['"]\.\/platform\.js['"]/)
  assert.match(settings, /import\s*\{[^}]*\bisStandalone\b[^}]*\}\s*from\s*['"]\.\/platform\.js['"]/)
})

test('settings.js feeds platformInfo from navigator.userAgent, navigator.maxTouchPoints, isStandalone(window) and the push support check', () => {
  assert.match(settings, /platformInfo\(\s*\{[^}]*userAgent:\s*navigator\.userAgent/)
  assert.match(settings, /platformInfo\(\s*\{[^}]*maxTouchPoints:\s*navigator\.maxTouchPoints/)
  assert.match(settings, /platformInfo\(\s*\{[^}]*standalone:\s*isStandalone\(\s*window\s*\)/)
  assert.match(settings, /platformInfo\(\s*\{[^}]*hasPush:\s*supported\(\)/)
})

test('settings.js computes const hint = pushHint(...) and shows ${hint} in the Notifications section', () => {
  assert.match(settings, /const\s+hint\s*=\s*pushHint\(/)
  const section = settings.slice(settings.indexOf('<h3>Notifications</h3>'), settings.indexOf('<h3>This phone</h3>'))
  assert.ok(section.length > 0, 'found the Notifications section')
  assert.match(section, /\$\{hint\}/, 'the hint is rendered inside the Notifications section')
})

test('settings.js still shows the generic status text (notificationStatus) for everything but the iOS hint cases', () => {
  assert.match(settings, /notificationStatus\(/)
  assert.match(settings, /\$\{status\.text\}/)
})

test('settings.js passes maxTouchPoints to buildSubscribePayload so an iPad in desktop mode is named "iPad"', () => {
  assert.match(settings, /buildSubscribePayload\(\s*\{[^}]*maxTouchPoints:\s*navigator\.maxTouchPoints/)
})

// ---- views.js: the one-time install banner and the Mic's iOS flag --------------------------------------------------------------------------

test('views.js imports platformInfo, installHint and isStandalone from ./platform.js', () => {
  assert.match(views, /import\s*\{[^}]*\bplatformInfo\b[^}]*\}\s*from\s*['"]\.\/platform\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\binstallHint\b[^}]*\}\s*from\s*['"]\.\/platform\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\bisStandalone\b[^}]*\}\s*from\s*['"]\.\/platform\.js['"]/)
})

test('views.js feeds platformInfo from navigator.userAgent, navigator.maxTouchPoints and isStandalone(window)', () => {
  assert.match(views, /platformInfo\(\s*\{[^}]*userAgent:\s*navigator\.userAgent/)
  assert.match(views, /platformInfo\(\s*\{[^}]*maxTouchPoints:\s*navigator\.maxTouchPoints/)
  assert.match(views, /platformInfo\(\s*\{[^}]*standalone:\s*isStandalone\(\s*window\s*\)/)
})

test('views.js renders a "banner install-hint" element with the installHint(...) text when it is non-null', () => {
  assert.match(views, /installHint\(/)
  assert.match(views, /class=\\?"banner install-hint\\?"|class=\$\{['"`]banner install-hint['"`]\}/)
})

test('the install banner is dismissible and the dismissal is remembered in localStorage under rq-m.install-hint-dismissed', () => {
  assert.match(views, /rq-m\.install-hint-dismissed/)
  assert.match(views, /localStorage\.getItem\(/, 'reads the flag')
  assert.match(views, /localStorage\.setItem\(/, 'writes the flag on dismiss')
  const banner = views.slice(views.indexOf('banner install-hint'))
  assert.match(banner.slice(0, 700), /<button[^>]*onClick/, 'a button next to the text dismisses the banner')
})

test('the Mic component passes the iOS flag to createDictation: { ios: platformInfo(...).ios }', () => {
  assert.match(views, /createDictation\(\s*\{[^}]*\bios\b/)
  assert.match(views, /platformInfo\([\s\S]*?\)\.ios\b/)
})

test('views.js still shows the view-guard banner and the install banner as separate elements', () => {
  assert.match(views, /banner view-guard/)
  assert.match(views, /banner install-hint/)
})

test('the install banner puts its Dismiss button on its own line (block button below the text, not inline)', () => {
  const css = read('style.css')
  const rule = /\.install-hint\s+\.btn\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, '.install-hint .btn rule exists')
  assert.match(rule[1], /display\s*:\s*block/)
  assert.match(rule[1], /margin(-top)?\s*:/)
})

test('the "+ New todo" button has clear space below it so it never touches the filter chips or the cards', () => {
  assert.match(views, /<div class="row todo-link"><a class="btn pri" href="#\/new">\+ New todo<\/a><\/div>/)
  const rule = /\.todo-link\s*\{([^}]*)\}/.exec(read('style.css'))
  assert.ok(rule, '.todo-link rule exists')
  const m = /margin-bottom\s*:\s*(\d+)px/.exec(rule[1])
  assert.ok(m && Number(m[1]) >= 16, 'margin-bottom is at least 16px')
})

test('the Read aloud button is not drawn on iOS (Android speaks with the device TTS, iOS has no button)', () => {
  const body = views.slice(views.indexOf('function ReadAloud('), views.indexOf('function Mic('))
  assert.match(body, /platformInfo\([^)]*\)\.ios\s*\|\|\s*typeof speechSynthesis === 'undefined'/)
  assert.match(body, /return null/)
  assert.ok(body.indexOf('platformInfo(') < body.indexOf('useEffect('), 'decided before any effect is registered')
})
