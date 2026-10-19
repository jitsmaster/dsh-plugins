import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TYPING_CLASS, hidesTabBar, isTextField, watchTyping } from '../lib/mobile/view-guard.js'

// While a text field outside the composer has the focus, the bottom tab bar is hidden (body class "typing"): Android's resizes-content viewport
// (index.html) shrinks the page to what the keyboard leaves, and a 56 px bar would eat a good part of it. The composer keeps the bar: it never
// hides it, and never hides itself. The decision is pure (view-guard.js); app.js wires the focus events to it; style.css hides the bar.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOBILE = join(ROOT, 'lib', 'mobile')
const css = readFileSync(join(MOBILE, 'style.css'), 'utf8')
const app = readFileSync(join(MOBILE, 'app.js'), 'utf8')

/** An element-like object: closest(selector) answers for the composer only. */
const el = (tagName, { type, inComposer = false } = {}) => ({ tagName, type, closest: (sel) => (sel === '.composer' && inComposer ? {} : null) })

// ---- isTextField ----------------------------------------------------------------------------------------------------------------------

test('a textarea and the text-like inputs are text fields', () => {
  assert.equal(isTextField(el('TEXTAREA')), true)
  for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number', undefined, '']) assert.equal(isTextField(el('INPUT', { type })), true, String(type))
})

test('checkboxes, radios, buttons, files and the rest are not text fields: no keyboard opens for them', () => {
  for (const type of ['checkbox', 'radio', 'button', 'submit', 'file', 'range', 'color', 'reset', 'image']) assert.equal(isTextField(el('INPUT', { type })), false, type)
  for (const tag of ['BUTTON', 'SELECT', 'A', 'DIV', 'BODY']) assert.equal(isTextField(el(tag)), false, tag)
})

test('nothing, or something that is not an element, is not a text field', () => {
  for (const v of [null, undefined, {}, 'input', 7]) assert.equal(isTextField(v), false, String(v))
})

// ---- hidesTabBar ----------------------------------------------------------------------------------------------------------------------

test('a text field outside the composer hides the tab bar', () => {
  assert.equal(hidesTabBar(el('INPUT', { type: 'search' })), true, 'the filter search box')
  assert.equal(hidesTabBar(el('TEXTAREA')), true, 'the new todo box')
  assert.equal(hidesTabBar(el('INPUT', { type: 'text' })), true, 'the Other answer box')
})

test('the composer is not hidden by it: its own text field leaves the tab bar alone', () => {
  assert.equal(hidesTabBar(el('TEXTAREA', { inComposer: true })), false)
  assert.equal(hidesTabBar(el('INPUT', { type: 'text', inComposer: true })), false)
})

test('a focused button or select, and no focus at all, leave the tab bar alone', () => {
  assert.equal(hidesTabBar(el('BUTTON')), false)
  assert.equal(hidesTabBar(el('SELECT')), false)
  assert.equal(hidesTabBar(null), false)
})

test('an element without closest() counts as outside the composer', () => {
  assert.equal(hidesTabBar({ tagName: 'TEXTAREA' }), true)
})

// ---- watchTyping ----------------------------------------------------------------------------------------------------------------------

function fakeDoc() {
  const handlers = {}
  const classes = new Set()
  return {
    handlers, classes,
    addEventListener: (type, fn) => { handlers[type] = fn },
    removeEventListener: (type, fn) => { if (handlers[type] === fn) delete handlers[type] },
    body: { classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name) } } },
  }
}

test('the class is "typing"', () => {
  assert.equal(TYPING_CLASS, 'typing')
})

test('focusing a text field outside the composer sets the body class, leaving it clears it', () => {
  const doc = fakeDoc()
  watchTyping(doc)
  doc.handlers.focusin({ target: el('INPUT', { type: 'search' }) })
  assert.equal(doc.classes.has('typing'), true)
  doc.handlers.focusout({ target: el('INPUT', { type: 'search' }), relatedTarget: null })
  assert.equal(doc.classes.has('typing'), false)
})

test('moving from one outside field to another keeps the class, and moving into the composer clears it', () => {
  const doc = fakeDoc()
  watchTyping(doc)
  const a = el('INPUT', { type: 'text' })
  const b = el('TEXTAREA')
  doc.handlers.focusin({ target: a })
  doc.handlers.focusout({ target: a, relatedTarget: b })
  assert.equal(doc.classes.has('typing'), true, 'no flicker of the bar between two fields')
  doc.handlers.focusin({ target: b })
  doc.handlers.focusout({ target: b, relatedTarget: el('TEXTAREA', { inComposer: true }) })
  assert.equal(doc.classes.has('typing'), false)
})

test('focusing the composer or a button does not set it', () => {
  const doc = fakeDoc()
  watchTyping(doc)
  doc.handlers.focusin({ target: el('TEXTAREA', { inComposer: true }) })
  assert.equal(doc.classes.has('typing'), false)
  doc.handlers.focusin({ target: el('BUTTON') })
  assert.equal(doc.classes.has('typing'), false)
})

test('the returned function stops watching and clears the class', () => {
  const doc = fakeDoc()
  const stop = watchTyping(doc)
  doc.handlers.focusin({ target: el('TEXTAREA') })
  assert.equal(doc.classes.has('typing'), true)
  stop()
  assert.equal(doc.classes.has('typing'), false)
  assert.deepEqual(Object.keys(doc.handlers), [])
})

test('a document without a body or listeners is left alone', () => {
  assert.doesNotThrow(() => watchTyping({}))
  assert.doesNotThrow(() => watchTyping(undefined))
})

// ---- wiring: app.js and style.css -----------------------------------------------------------------------------------------------------

test('app.js starts watching the page', () => {
  assert.match(app, /import\s*\{[^}]*\bwatchTyping\b[^}]*\}\s*from\s*['"]\.\/view-guard\.js['"]/)
  assert.match(app, /watchTyping\(\s*document\s*\)/)
})

test('style.css hides the tab bar and gives its room back while the body has the class', () => {
  assert.match(css, /body\.typing nav\s*\{[^}]*display:\s*none/)
  assert.match(css, /body\.typing \.app\s*\{[^}]*padding-bottom:\s*0/)
})

test('the composer is never hidden by the class: it sticks to the bottom edge then, and no rule hides it', () => {
  assert.match(css, /body\.typing \.composer\s*\{[^}]*bottom:\s*0/)
  for (const m of css.matchAll(/([^{}]*\.typing[^{}]*)\{([^}]*)\}/g)) {
    if (/\.composer/.test(m[1])) assert.doesNotMatch(m[2], /display:\s*none|visibility:\s*hidden|opacity:\s*0\b/, m[1].trim())
  }
})

test('the tab bar is still there for an ordinary page: nothing hides it without the class', () => {
  const nav = /(?:^|\n|\})\s*nav\s*\{([^}]*)\}/.exec(css)[1]
  assert.doesNotMatch(nav, /display:\s*none/)
})

test('this test file is in the package.json test script', () => {
  const listed = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.test.replace(/^node --test\s+/, '').split(/\s+/)
  assert.ok(listed.includes('test/mobile-keyboard.test.mjs'))
})
