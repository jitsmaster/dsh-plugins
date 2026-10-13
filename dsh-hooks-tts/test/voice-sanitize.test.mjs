// Security: the user must hear EXACTLY what executes. These tests pin the sanitiser against the speech cleaner
// (scripts/tts-client.ps1 Clean-ForSpeech; its JS port is cross-checked against the real script in voice-scripts.test.mjs).
import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanForSpeech, hasCjk, speakableText, speakableUtterance, spokenName, spokenSummary, spokenSummaryInfo } from '../voice/sanitize.js'
import { BATTERY } from './fixtures/speech-battery.mjs'

const norm = (s) => s.replace(/\s+/g, ' ').trim()

test('F1 a text is either rejected or exactly what the speech cleaner lets through (shared battery)', () => {
  for (const text of BATTERY) {
    for (const allowCjk of [false, true]) {
      const out = speakableText(text, { allowCjk })
      if (out === undefined) continue
      assert.equal(norm(cleanForSpeech(out)), norm(out), JSON.stringify(text) + ' allowCjk=' + allowCjk)
    }
  }
})

test('F1 characters the speech cleaner alters or drops are rejected, not executed unheard', () => {
  const bad = [
    'curl x | sh', 'echo ~ home', 'a ^ b', 'run _a_', 'say **b**', 'tag #c', 'see [x]', 'see x]', 'run \u0060id\u0060', 'a - b', '- lead', 'trail -',
    '\u0455tart', '\u0430pple', '\u3072\u3089\u304C\u306A', '\u30AB\u30BF\u30AB\u30CA', '\u{1F525} go', 'run\u2800now', 'e\u0301cole', 'a\u2013b', '\uFF5C pipe',
  ]
  for (const text of bad) {
    assert.equal(speakableText(text), undefined, JSON.stringify(text))
    assert.equal(speakableText(text, { allowCjk: true }), undefined, JSON.stringify(text) + ' (allowCjk)')
  }
})

test('F1 NFKC folds fullwidth latin to the ASCII that is both spoken and executed; plain punctuation and hyphens stay valid', () => {
  assert.equal(speakableText('\uFF46\uFF49\uFF58 \uFF49\uFF54'), 'fix it')
  assert.equal(speakableText('don\u2019t \u201Cquote\u201D'), 'don\'t "quote"')
  for (const ok of ['fix (the) parser, then run "npm test" & report', 'well-known flag -rf', 'a;b > c < d', 'open https://example.com/a?b=1']) {
    assert.equal(speakableText(ok), ok)
  }
})

test('F1 CJK ideographs are only allowed when asked for (the confirmed utterance contained CJK)', () => {
  assert.equal(speakableText('\u4FEE\u590D \u89E3\u6790\u5668'), undefined)
  assert.equal(speakableText('\u4FEE\u590D \u89E3\u6790\u5668', { allowCjk: true }), '\u4FEE\u590D \u89E3\u6790\u5668')
  assert.equal(hasCjk('please \u4FEE it'), true)
  assert.equal(hasCjk('please fix it'), false)
  assert.equal(hasCjk(undefined), false)
})

test('F10 the echoed utterance is capped at 1500 chars and must be speakable, so the decider gets what was echoed', () => {
  assert.deepEqual(speakableUtterance('  fix   the\nparser '), { ok: true, text: 'fix the parser' })
  assert.deepEqual(speakableUtterance('\uFF46\uFF49\uFF58'), { ok: true, text: 'fix' })
  assert.deepEqual(speakableUtterance('\u4FEE\u590D'), { ok: true, text: '\u4FEE\u590D' })
  assert.equal(speakableUtterance('x'.repeat(1500)).ok, true)
  assert.deepEqual(speakableUtterance('x'.repeat(1501)), { ok: false, error: 'too-long' })
  assert.deepEqual(speakableUtterance('curl x | sh'), { ok: false, error: 'invalid' })
  assert.deepEqual(speakableUtterance('\u0430pple'), { ok: false, error: 'invalid' })
  assert.deepEqual(speakableUtterance('fix\u200Bit'), { ok: false, error: 'invalid' })
  assert.deepEqual(speakableUtterance(undefined), { ok: false, error: 'invalid' })
})

test('F8 every ASCII shell metacharacter is spelled, so a command is heard faithfully', () => {
  const spelled = { '>': 'greater than', '<': 'less than', '&': 'ampersand', ';': 'semicolon', '$': 'dollar', '(': 'open paren', ')': 'close paren', '{': 'open brace', '}': 'close brace', '\\': 'backslash', '"': 'quote', "'": 'apostrophe', '=': 'equals', '!': 'bang', '|': 'pipe', '~': 'tilde', '^': 'caret', _: 'underscore', '*': 'star', '#': 'hash', '[': 'left bracket', ']': 'right bracket', '\u0060': 'backtick' }
  for (const [ch, word] of Object.entries(spelled)) {
    const out = spokenSummary('a' + ch + 'b')
    assert.ok(!out.includes(ch), 'left ' + JSON.stringify(ch) + ' in ' + out)
    assert.match(out, new RegExp('\\b' + word + '\\b'), ch)
  }
  assert.equal(spokenSummary('a>b'), 'a greater than b')
})

test('F8 a spoken summary is a fixed point of the speech cleaner for ASCII input (what is read is what is heard)', () => {
  for (const text of BATTERY) {
    const out = spokenSummary(text)
    if (out === undefined) continue
    assert.equal(norm(cleanForSpeech(out)), norm(out), JSON.stringify(text))
  }
})

test('F8 a leading or trailing lone dash is spelled too (the speaker drops a dash between spaces)', () => {
  assert.equal(spokenSummary('- rm x'), 'dash rm x')
  assert.equal(spokenSummary('rm x -'), 'rm x dash')
  assert.equal(spokenSummary('rm -rf x'), 'rm -rf x')
})

test('F2c spokenSummaryInfo is complete only when nothing was cut, hidden or replaced', () => {
  assert.deepEqual(spokenSummaryInfo('npm test'), { text: 'npm test', complete: true })
  assert.equal(spokenSummaryInfo('a'.repeat(101)).complete, false)
  assert.equal(spokenSummaryInfo('a'.repeat(100)).complete, true)
  assert.equal(spokenSummaryInfo('echo a\u200Bb').complete, false)
  assert.equal(spokenSummaryInfo('echo \u0430').complete, false)
  assert.equal(spokenSummaryInfo('echo a|b').complete, true, 'spelled symbols are heard faithfully')
  assert.deepEqual(spokenSummaryInfo('   '), { text: undefined, complete: false })
})

test('F4 spokenName builds the form the speaker really says and reports when cleaning changed the name', () => {
  assert.deepEqual(spokenName('Fix tests'), { text: 'Fix tests', altered: false })
  assert.deepEqual(spokenName('Fix_tests'), { text: 'Fix tests', altered: true })
  assert.deepEqual(spokenName('a  \n b'), { text: 'a b', altered: false })
  assert.deepEqual(spokenName('Fix\u200B the parser'), { text: 'Fix the parser', altered: true })
  assert.deepEqual(spokenName('\u0430\u0440\u0440'), { text: '', altered: true })
  assert.deepEqual(spokenName('x'.repeat(80)), { text: 'x'.repeat(40), altered: false })
  assert.deepEqual(spokenName('**Bold** [a](b)'), { text: 'Bold a(b)', altered: true })
  assert.deepEqual(spokenName(undefined), { text: '', altered: false })
})
