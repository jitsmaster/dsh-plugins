import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Rules found while running the phone page in a browser: tap targets and text contrast of the dark theme.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'mobile', 'style.css'), 'utf8')

const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp('(?:^|\\n|\\})\\s*' + escaped + '\\s*\\{([^}]*)\\}').exec(css)
  assert.ok(m, 'rule ' + selector)
  return m[1]
}
const variable = (name) => new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})', 'i').exec(css)?.[1]
const channel = (hex, i) => { const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const luminance = (hex) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2)
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
const colour = (body, prop) => { const m = new RegExp(prop + ':\\s*(#[0-9a-f]{6}|var\\(--[a-z0-9-]+\\))', 'i').exec(body); assert.ok(m, prop); return m[1].startsWith('var(') ? variable(m[1].slice(6, -1)) : m[1] }

test('the filter chips are at least 48 px tall (tap target)', () => {
  const min = /min-height:\s*(\d+)px/.exec(rule('.fchip'))
  assert.ok(min && Number(min[1]) >= 48, 'min-height ' + (min && min[1]))
})

test('white text on the red buttons (Deny, Remove) has AA contrast', () => {
  assert.ok(contrast('#ffffff', colour(rule('.btn.bad'), 'background')) >= 4.5)
})

test('the hold button label stays readable on the progress fill', () => {
  assert.ok(contrast('#ffffff', colour(rule('.hold .fill'), 'background')) >= 4.5)
})

test('the dim text colour has AA contrast on the page and on the card colours', () => {
  for (const bg of ['bg', 'panel', 'panel2']) assert.ok(contrast(variable('dim'), variable(bg)) >= 4.5, bg)
})

test('the chat bubbles keep AA contrast: text on the user bubble, text on the assistant bubble, and the new-messages pill', () => {
  assert.ok(contrast(variable('text'), colour(rule('.bubble.user'), 'background')) >= 4.5, 'user bubble')
  assert.ok(contrast(variable('text'), colour(rule('.bubble.assistant'), 'background')) >= 4.5, 'assistant bubble')
  assert.ok(contrast(variable('dim'), colour(rule('.bubble.user'), 'background')) >= 4.5, 'time on the user bubble')
  assert.ok(contrast(variable('accent-ink'), colour(rule('.pill'), 'background')) >= 4.5, 'pill')
})

test('the Send button and the composer text box are at least 48 px tall', () => {
  for (const sel of ['.composer-input', '.send']) {
    const min = /min-height:\s*(?:(\d+)px|var\(--tap\))/.exec(rule(sel))
    assert.ok(min && (min[1] === undefined || Number(min[1]) >= 48), sel)
  }
})
