import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILES } from '../mobile.js'

// Wiring of swipe-right-to-review on the phone's Waiting rows (docs/mobile.md "Swipe to review"): source-text checks in the style of
// mobile-thread-wiring (no DOM harness for the Preact views). The pure rules are in mobile-swipe.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOBILE = join(ROOT, 'lib', 'mobile')
const read = (name) => readFileSync(join(MOBILE, name), 'utf8')
const views = read('views.js')
const api = read('api.js')
const css = read('style.css')

function body(src, name) {
  const start = src.search(new RegExp('(?:^|\\n)(?:export )?(?:async )?function ' + name + '\\b'))
  assert.notEqual(start, -1, 'defines function ' + name)
  const rest = src.slice(start + 1)
  const next = rest.search(/\n(?:export )?(?:async )?function \w+|\n\/\/ ---- /)
  return next === -1 ? rest : rest.slice(0, next)
}

test('swipe.js is served by the phone router as JavaScript', () => {
  assert.ok(Object.hasOwn(FILES, 'swipe.js'))
  assert.match(FILES['swipe.js'].type, /javascript/)
  assert.ok(FILES['swipe.js'].file.endsWith('swipe.js'))
})

test('the new test files are in the test script list', () => {
  const listed = JSON.parse(readFileSync(join(ROOT, 'scripts/test-files.json'), 'utf8'))
  for (const f of ['test/mobile-swipe.test.mjs', 'test/mobile-swipe-api.test.mjs', 'test/mobile-swipe-row.test.mjs', 'test/mobile-swipe-wiring.test.mjs', 'test/swipe-reopen.test.mjs']) assert.ok(listed.includes(f), f + ' is listed')
})

test('views.js uses the pure swipe module and the api functions of the swipe', () => {
  assert.match(views, /import\s*\{[^}]*\bisSwipeable\b[^}]*\}\s*from\s*['"]\.\/swipe\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\bswipeIntent\b[^}]*\}\s*from\s*['"]\.\/swipe\.js['"]/)
  assert.match(views, /import\s*\{[^}]*\bswipeCommitted\b[^}]*\}\s*from\s*['"]\.\/swipe\.js['"]/)
  for (const fn of ['swipeReview', 'undoSwipe', 'dismissUndo']) assert.match(views, new RegExp('import\\s*\\{[^}]*\\b' + fn + '\\b[^}]*\\}\\s*from\\s*[\'"]\\./api\\.js[\'"]'), fn)
})

test('the Waiting row listens for touch only on a swipeable item, and the touch handlers are passive-safe (no preventDefault needed: touch-action pan-y)', () => {
  const r = body(views, 'ItemRow')
  assert.match(r, /isSwipeable\(item\)/)
  assert.match(r, /onTouchStart=/)
  assert.match(r, /onTouchMove=/)
  assert.match(r, /onTouchEnd=/)
  assert.match(r, /onTouchCancel=/)
  assert.match(css, /\.swipe-row[^{]*\{[^}]*touch-action:\s*pan-y/)
})

test('a commit calls swipeReview with the item; the row only reviews on touch end, never on move', () => {
  const r = body(views, 'ItemRow')
  const end = r.slice(r.indexOf('onTouchEnd'))
  assert.match(end, /swipeCommitted\(/)
  assert.match(end, /swipeReview\(/)
  assert.doesNotMatch(r.slice(r.indexOf('onTouchMove'), r.indexOf('onTouchEnd')), /swipeReview\(/)
})

test('a swipe that moved the row does not also open the item (the click after a swipe is swallowed)', () => {
  const r = body(views, 'ItemRow')
  assert.match(r, /onClick=/)
  assert.match(r, /preventDefault\(\)/)
})

test('the row follows the finger with a transform and shows a Reviewed hint behind it', () => {
  const r = body(views, 'ItemRow')
  assert.match(r, /translateX\(/)
  assert.match(r, /swipe-hint/)
  assert.match(css, /\.swipe-hint\s*\{/)
})

test('swipeReview posts /v1/reviewed through act and remembers an undo; undoSwipe posts /v1/reopen', () => {
  assert.match(api, /export async function swipeReview\(/)
  assert.match(body(api, 'swipeReview'), /act\('\/v1\/reviewed'/)
  assert.match(body(api, 'swipeReview'), /showUndo\(/)
  assert.match(api, /export async function undoSwipe\(/)
  assert.match(body(api, 'undoSwipe'), /act\('\/v1\/reopen'/)
  assert.match(api, /export function dismissUndo\(/)
})

test('swipeReview refuses anything that is not a swipeable open item (the server refuses it too)', () => {
  assert.match(body(api, 'swipeReview'), /isSwipeable\(/)
})

test('the undo toast is shown above the bottom nav with an Undo button and expires by itself', () => {
  assert.match(views, /export function UndoToast\(/)
  const t = body(views, 'UndoToast')
  assert.match(t, /Undo/)
  assert.match(t, /undoSwipe\(/)
  assert.match(t, /role="status"/)
  assert.match(css, /\.undo-toast\s*\{[^}]*position:\s*fixed/)
  assert.match(body(views, 'App'), /<\$\{UndoToast\}/)
})

test('a failed Undo brings the toast back with the error instead of vanishing silently (the item is resolved, so no screen shows its error)', () => {
  const u = body(api, 'undoSwipe')
  assert.match(u, /if \(!ok && !state\.undo\)/)
  assert.match(u, /Could not undo/)
  assert.match(u, /showUndo\(/)
})

test('the toast is armed in one place with a timer of UNDO_MS, and swipeReview guards on isSwipeable before it posts', () => {
  assert.match(body(api, 'showUndo'), /setTimeout\([^]*UNDO_MS\)/)
  const s = body(api, 'swipeReview')
  assert.ok(s.indexOf('!isSwipeable(item)') !== -1 && s.indexOf('!isSwipeable(item)') < s.indexOf("act('/v1/reviewed'"))
})

test('the touch handlers never call preventDefault on a move (scrolling stays native through touch-action), and the click flag is cleared after the lift', () => {
  const r = body(views, 'ItemRow')
  const move = r.slice(r.indexOf('const onTouchMove'), r.indexOf('const onTouchEnd'))
  assert.doesNotMatch(move, /preventDefault/)
  assert.match(r.slice(r.indexOf('const onTouchEnd'), r.indexOf('const onTouchCancel')), /setTimeout\(\(\) => \{ swipedId = null \}/)
})

test('a committed swipe leaves the row in place on success (the snapshot removes it) and springs it back only when the review failed', () => {
  const r = body(views, 'ItemRow')
  const end = r.slice(r.indexOf('const onTouchEnd'), r.indexOf('const onTouchCancel'))
  assert.doesNotMatch(end, /\.finally\(/)
  assert.match(end, /swipeReview\(item\)[^]*\.then\(\(ok\) => \{ if \(!ok\) \{ committedRow = null; resetSwipeRow\(row\)/)
})

test('Undo puts a committed row that is still on screen back to rest (the snapshot may not have removed it yet)', () => {
  const r = body(views, 'ItemRow')
  assert.match(r, /committedRow = \{ id: item\.id, row \}/)
  const t = body(views, 'UndoToast')
  assert.match(t, /committedRow/)
  assert.match(t, /resetSwipeRow\(committedRow\.row\)[^]*undoSwipe\(\)/)
})

test('the toast is not part of the shared store re-render: UndoToast listens on its own channel, and api.js never puts undo through set()', () => {
  assert.match(views, /export function useUndo\(/)
  const t = body(views, 'UndoToast')
  assert.match(t, /useUndo\(\)/)
  assert.doesNotMatch(t, /useStore\(\)/)
  assert.doesNotMatch(api, /set\(\{ undo/)
  assert.match(api, /export const subscribeUndo\b/)
})

test('the row element kept for Undo is released when the toast goes or the review failed', () => {
  const t = body(views, 'UndoToast')
  assert.match(t, /useEffect\([^]*committedRow = null/)
  assert.match(t, /useRef\(/) // only the row of the toast that went is released, not the row of a newer swipe still in flight
  assert.match(t, /committedRow\.id === last\.current/)
  const end = body(views, 'ItemRow')
  assert.match(end, /if \(!ok\) \{ committedRow = null; resetSwipeRow\(row\) \}/)
})

test('a drag looks its row elements up once, not on every move', () => {
  const r = body(views, 'ItemRow')
  const move = r.slice(r.indexOf('const onTouchMove'), r.indexOf('const onTouchEnd'))
  assert.equal((move.match(/querySelector\(/g) || []).length, 2)
  assert.match(move, /tr\.link/)
})

test('the click flag outlives a late post-touch click (350 ms), and the toast sits above the New todo button', () => {
  const r = body(views, 'ItemRow')
  assert.match(r, /setTimeout\(\(\) => \{ swipedId = null \}, 350\)/)
  const toast = css.match(/\.undo-toast\s*\{[^}]*\}/)[0]
  assert.match(toast, /bottom:\s*calc\(var\(--nav\) \+ env\(safe-area-inset-bottom\) \+ 76px\)/)
})

test('focus ring of the row link is not clipped by the swipe row', () => {
  assert.match(css, /\.swipe-row > \.rowitem:focus-visible\s*\{[^}]*outline-offset:\s*-/)
})

test('state keeps one undo at a time, in memory only', () => {
  assert.match(api, /undo:\s*null/)
})
