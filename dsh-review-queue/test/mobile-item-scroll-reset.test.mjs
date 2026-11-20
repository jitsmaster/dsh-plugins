import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Phone PWA: opening a card shows it from the top. The page scrolls (no inner scroll container), so the offset of the list the user
// came from carried over into the card. Source-text wiring check in the style of mobile-swipe-wiring (no DOM harness for the views).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const views = readFileSync(join(ROOT, 'lib', 'mobile', 'views.js'), 'utf8')

function body(src, name) {
  const start = src.search(new RegExp('(?:^|\\n)(?:export )?(?:async )?function ' + name + '\\b'))
  assert.notEqual(start, -1, 'defines function ' + name)
  const rest = src.slice(start + 1)
  const next = rest.search(/\n(?:export )?(?:async )?function \w+|\n\/\/ ---- /)
  return next === -1 ? rest : rest.slice(0, next)
}

test('resetScroll scrolls the window to the top and never throws', () => {
  const fn = body(views, 'resetScroll')
  assert.match(fn, /scrollTo\(\s*0\s*,\s*0\s*\)/)
  assert.match(fn, /try\s*\{/)
})

test('ItemView resets the scroll before paint whenever the opened card changes', () => {
  const v = body(views, 'ItemView')
  assert.match(v, /useLayoutEffect\(\s*\(\)\s*=>\s*\{?\s*resetScroll\(\)[^)]*\)?\s*\}?\s*,\s*\[\s*id\s*\]\s*\)/)
  // hooks run before the early return for a missing item
  assert.ok(v.indexOf('resetScroll()') < v.indexOf('if (!item)'), 'the effect is declared before the early return')
})
