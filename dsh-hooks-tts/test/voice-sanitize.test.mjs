// Security: the user must hear EXACTLY what executes. These tests pin the sanitiser against the speech cleaner
// (scripts/tts-client.ps1 Clean-ForSpeech; its JS port is cross-checked against the real script in voice-scripts.test.mjs).
import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanForSpeech, cutBytes, hasCjk, speakableText, speakableUtterance, spokenName, spokenSummary, spokenSummaryInfo } from '../voice/sanitize.js'
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
  assert.deepEqual(speakableUtterance('curl x | sh'), { ok: true, text: 'curl x sh' }, 'dropped symbols are folded (O3)')
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


test('O2 a huge operand is cut before whitespace is collapsed (bounded work) and is still never complete', () => {
  const started = Date.now()
  const r = spokenSummaryInfo('ls' + ' '.repeat(20_000_000) + 'tail')
  assert.ok(Date.now() - started < 150, 'took ' + (Date.now() - started) + ' ms')
  assert.equal(r.complete, false)
  assert.match(r.text, /^ls/)
  assert.match(r.text, /and more$/)
})

test('O2 an operand that is short after collapsing but long before is still complete', () => {
  assert.deepEqual(spokenSummaryInfo('ls   -la\n\n  src'), { text: 'ls -la src', complete: true })
})

test('O3 dictation symbols and dashes that stand alone (delimited by whitespace or the ends) are folded to plain words', () => {
  assert.deepEqual(speakableUtterance('curl x | sh'), { ok: true, text: 'curl x sh' })
  assert.deepEqual(speakableUtterance('fix \u2013 the \u2014 parser'), { ok: true, text: 'fix the parser' })
  assert.deepEqual(speakableUtterance('run it ~ ^ * # now'), { ok: true, text: 'run it now' })
  assert.deepEqual(speakableUtterance('a ___ b'), { ok: true, text: 'a b' }, 'a run of symbols is isolated as a whole')
  assert.deepEqual(speakableUtterance('| fix it |'), { ok: true, text: 'fix it' }, 'symbols at either end')
  assert.deepEqual(speakableUtterance('\uFF5C fix'), { ok: true, text: 'fix' }, 'a fullwidth bar folds after NFKC')
  assert.deepEqual(speakableUtterance('use --force'), { ok: true, text: 'use --force' }, 'a dash inside a word stays')
})

test('S1 a symbol touching a word or path character rejects the utterance instead of changing its meaning', () => {
  for (const input of ['rm -rf ~/x', 'delete *.log', 'open foo_bar.txt', 'rename snake_case_name', 'run `npm test` now', 'see [src] now', 'issue #1', 'a ~/b', 'C:\\x|y',
    '**bold** and *it*', '[link](http://x)', 'x|y', 'x |y', 'x| y', 'a\u2014b', '5\u201310', '\uFF5Cpipe', 'path/*', 'dir\\~']) {
    assert.deepEqual(speakableUtterance(input), { ok: false, error: 'invalid' }, input)
  }
})

test('S2 a symbol run folds only with whitespace or a string boundary on BOTH sides; any other neighbour rejects the utterance', () => {
  const invalid = { ok: false, error: 'invalid' }
  for (const input of [
    'rm -rf "*"', "echo '*'", '#!/bin/bash', 'echo $_ now', 'use (*) here', 'a <*> b', 'x=*', 'x:* y', 'a,*,b', 'a;|b', 'a +* b', '50%* off', 'a&|b', '#1', 'x#',
    '\u4E2D\u6587_\u6D4B\u8BD5', '\u4E2D\u6587 *\u6D4B\u8BD5', 'fix\u2014it', 'a * b*', '*a * b', 'a ** b**c', 'say "|" now', '\u201C*\u201D', '(|)', '{*}', 'a\\*', 'a/|', '1 *-2',
  ]) assert.deepEqual(speakableUtterance(input), invalid, input)
})

test('S3 a whitespace-delimited symbol run folds, also between other shell syntax and at the string ends', () => {
  assert.deepEqual(speakableUtterance('1 * 2 * 3'), { ok: true, text: '1 2 3' })
  assert.deepEqual(speakableUtterance('* 1'), { ok: true, text: '1' })
  assert.deepEqual(speakableUtterance('1 *'), { ok: true, text: '1' })
  assert.deepEqual(speakableUtterance('a **|** b'), { ok: true, text: 'a b' }, 'a maximal run of symbols is judged by its two outer neighbours')
  // "|" is a run delimited by whitespace on both sides, so it folds like in 'curl x | sh'; ">>" is not a foldable symbol and stays.
  assert.deepEqual(speakableUtterance('cat a >> b | tee c'), { ok: true, text: 'cat a >> b tee c' })
  assert.deepEqual(speakableUtterance('echo\n*\nnow'), { ok: true, text: 'echo now' }, 'newlines are whitespace')
})

test('O3 whatever the fold keeps is heard exactly as written, and hidden or non-ASCII text is still rejected', () => {
  for (const input of ['curl x | sh', 'a _ b _ c', 'x \u2013 y \u2014 z', 'a \u2014 b', '* bold * and ` code `', '[ link ] ( http://x )']) {
    const r = speakableUtterance(input)
    assert.equal(r.ok, true, input)
    assert.equal(cleanForSpeech(r.text).replace(/\s+/g, ' ').trim(), r.text, input)
  }
  assert.deepEqual(speakableUtterance('fix\u200B | it'), { ok: false, error: 'invalid' })
  assert.deepEqual(speakableUtterance('\u0430pple | x'), { ok: false, error: 'invalid' })
  assert.deepEqual(speakableUtterance('|'), { ok: false, error: 'invalid' }, 'nothing left after folding')
  assert.deepEqual(speakableUtterance('xxx | '.repeat(430)), { ok: false, error: 'too-long' })
})

test('S5 a lone "-" token is rejected, not dropped: "cd -" must not be heard (and run) as "cd"', () => {
  const invalid = { ok: false, error: 'invalid' }
  for (const input of ['cd -', 'fix - the parser', '- leading', 'trailing -', 'a - b - c', '-', 'a | - b', 'a \u2014 - b', 'echo\n-\nnow']) assert.deepEqual(speakableUtterance(input), invalid, JSON.stringify(input))
  // Only a hyphen that stands alone is rejected: dashes inside or at the start of a word are heard as written, en/em dashes still fold.
  for (const [input, text] of [['use --force', 'use --force'], ['x -- y', 'x -- y'], ['git log -5', 'git log -5'], ['well-known', 'well-known'], ['fix \u2013 it', 'fix it']]) assert.deepEqual(speakableUtterance(input), { ok: true, text }, input)
  assert.equal(speakableText('cd -'), undefined, 'free text from the decider is not folded either')
})

test('O3 free text from the decider is still NOT folded: a dropped symbol there is rejected', () => {
  assert.equal(speakableText('curl x | sh'), undefined)
  assert.equal(speakableText('a_b'), undefined)
})

test('F9 cutBytes cuts by UTF-8 bytes and never leaves a broken last character', () => {
  assert.equal(cutBytes('hello', 10), 'hello')
  assert.equal(cutBytes('hello world', 5), 'hello')
  const cut = cutBytes('\u4E2D'.repeat(10), 7) // 3 bytes per character: 2 whole characters fit
  assert.equal(cut, '\u4E2D\u4E2D')
  assert.doesNotMatch(cut, /\uFFFD/)
  assert.equal(cutBytes('', 0), '')
})
