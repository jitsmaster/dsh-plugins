import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_TIPS } from '../tip-builtin.js'
import { CATEGORIES, MAX_BODY, MAX_TITLE, parseTip } from '../tip.js'

// The curated fallback tips (tip-builtin.js): the same shape the model must produce, spread over the three categories.
const sentences = (text) => text.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/).length

test('there are at least 55 built-in tips, the first three categories have at least 8 and every other one at least 2', () => {
  assert.ok(BUILTIN_TIPS.length >= 55)
  for (const c of CATEGORIES) assert.ok(BUILTIN_TIPS.filter((t) => t.category === c).length >= (CATEGORIES.indexOf(c) < 3 ? 8 : 2), c)
})

test('every built-in tip has a unique short title, a body of 2 to 4 sentences within the caps and a known category', () => {
  const titles = new Set()
  for (const tip of BUILTIN_TIPS) {
    assert.ok(CATEGORIES.includes(tip.category), tip.title)
    assert.ok(tip.title.length > 0 && tip.title.length <= MAX_TITLE, tip.title)
    assert.ok(tip.body.length <= MAX_BODY, tip.title + ' body length ' + tip.body.length)
    const n = sentences(tip.body)
    assert.ok(n >= 2 && n <= 4, tip.title + ' has ' + n + ' sentences')
    assert.ok(!titles.has(tip.title.toLowerCase()), 'duplicate title ' + tip.title)
    titles.add(tip.title.toLowerCase())
  }
})

test('every built-in tip passes the same validation as a model answer (no URL, path or key-looking text)', () => {
  for (const tip of BUILTIN_TIPS) assert.deepEqual(parseTip(JSON.stringify(tip)), tip, tip.title)
})

test('the tips are plain data (only title, body, category)', () => {
  for (const tip of BUILTIN_TIPS) assert.deepEqual(Object.keys(tip).sort(), ['body', 'category', 'title'])
})
