import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Wiring of the performance follow-up on the phone (docs/mobile.md "Chat thread", "Cost on the phone"): source-text checks in the style of
// mobile-thread-wiring (the repo has no DOM harness for the Preact views); the logic they call is tested in mobile-thread-perf and mobile-api-perf.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOBILE = join(ROOT, 'lib', 'mobile')
const views = readFileSync(join(MOBILE, 'views.js'), 'utf8')
const css = readFileSync(join(MOBILE, 'style.css'), 'utf8')

function body(src, name) {
  const start = src.search(new RegExp('(?:^|\\n)(?:export )?(?:async )?function ' + name + '\\b'))
  assert.notEqual(start, -1, 'defines function ' + name)
  const rest = src.slice(start + 1)
  const next = rest.search(/\n(?:export )?(?:async )?function \w+|\n\/\/ ---- /)
  return next === -1 ? rest : rest.slice(0, next)
}

test('the new test files are in the package.json test script', () => {
  const listed = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.test.replace(/^node --test\s+/, '').split(/\s+/)
  for (const f of ['thread-incremental', 'thread-window', 'thread-after', 'mobile-thread-perf', 'mobile-api-perf', 'mobile-perf-wiring']) assert.ok(listed.includes('test/' + f + '.test.mjs'), f + ' is listed')
})

// ---- the bubbles --------------------------------------------------------------------------------------------------------------------------

test('a bubble is drawn again only when its message object or the minute changed: a component with shouldComponentUpdate on bubbleChanged', () => {
  assert.match(views, /import\s*\{[^}]*\bComponent\b[^}]*\}\s*from\s*['"]\.\/vendor\/preact-htm\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\bbubbleChanged\b[^}]*\}\s*from\s*['"]\.\/thread\.js['"]/)
  assert.match(views, /extends Component/)
  assert.match(views, /shouldComponentUpdate\([^)]*\)\s*\{[^}]*changed\(/)
  assert.match(views, /onlyWhen\(bubbleChanged,\s*Bubble\)/)
})

test('the thread draws its messages through the memoised bubble, with the minute', () => {
  const t = body(views, 'ThreadView')
  assert.match(t, /<\$\{MemoBubble\}\s+key=\$\{m\.id\}\s+m=\$\{m\}\s+minute=\$\{/)
  assert.doesNotMatch(t, /<\$\{Bubble\}/)
})

test('the bubble still has the plain user text and the Md of the assistant, so the memo keeps what the screen shows', () => {
  const b = body(views, 'Bubble')
  assert.match(b, /<\$\{Md\}/)
  assert.match(b, /class="utext">\$\{m\.text\}</)
})

test('a bubble is skipped by the browser while it is off screen: content-visibility auto with a 80px intrinsic size', () => {
  const rule = /(?:^|\n|\})\s*\.bubble\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, '.bubble rule')
  assert.match(rule[1], /content-visibility:\s*auto/)
  assert.match(rule[1], /contain-intrinsic-size:\s*auto 80px/)
})

// ---- the composer --------------------------------------------------------------------------------------------------------------------------

test('views.js imports the draft buffer and saveNow', () => {
  assert.match(views, /import\s*\{[^}]*\bcreateDraftBuffer\b[^}]*\}\s*from\s*['"]\.\/thread\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\bsaveNow\b[^}]*\}\s*from\s*['"]\.\/api\.js['"]/)
})

test('typing goes to a local draft: the textarea shows it, and the global state gets it through the buffer', () => {
  const c = body(views, 'Composer')
  assert.match(c, /createDraftBuffer\(\{[^}]*read:[^}]*state\.replies\[id\][^}]*write:[^}]*replies:\s*\{\s*\.\.\.state\.replies/)
  assert.match(c, /useState\(/, 'a local state for the shown draft')
  assert.doesNotMatch(c, /value=\$\{st\.replies/)
  assert.match(c, /onInput=\$\{\(e\)\s*=>\s*setDraft\(e\.target\.value\)\}/)
  assert.doesNotMatch(c, /const setDraft = \(text\) => set\(/, 'typing is not a store update any more')
})

test('the dictation fills the same local draft', () => {
  const c = body(views, 'Composer')
  assert.match(c, /<\$\{Mic\}[^>]*text=\$\{draft\}[^>]*onText=\$\{setDraft\}/)
})

test('the draft is flushed on blur, on pagehide and when the page is hidden (then saved at once), on unmount, and before Send', () => {
  const c = body(views, 'Composer')
  assert.match(c, /onBlur=\$\{[^}]*flush/)
  assert.match(c, /addEventListener\('pagehide'/)
  assert.match(c, /addEventListener\('visibilitychange'/)
  assert.match(c, /removeEventListener\('pagehide'/)
  assert.match(c, /saveNow\(\)/)
  assert.match(c, /\.dispose\(\)/, 'leaving the screen flushes')
  const send = c.slice(c.indexOf('const send'))
  assert.ok(send.indexOf('.flush()') > -1 && send.indexOf('.flush()') < send.indexOf('postFollowUp('), 'flush, then post')
})

test('a change from outside (the post cleared the draft) is taken into the local draft', () => {
  const c = body(views, 'Composer')
  assert.match(c, /\.adopt\(/)
  assert.match(c, /st\.replies\[/)
})

test('the composer is keyed by the item, so a draft buffer never serves another item', () => {
  const v = body(views, 'ItemView')
  assert.match(v, /<\$\{Composer\}\s+key=\$\{item\.id\}/)
})
