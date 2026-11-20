import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILES } from '../mobile.js'
import { createDictation } from '../lib/mobile/dictation.js'
import { CLEAN_MAX_CHARS, cleanWorthy } from '../lib/mobile/punctuation.js'
import { MAX_DICTATION } from '../follow-up-shared.js'

// Wiring of the Haiku cleanup on the phone:
//   mobile.js serves punctuation.js (dictation.js imports it: a 404 would break every Mic);
//   createDictation reports onEnd({ base, text, lang }) once when a dictation ends naturally (stop pressed, or silence for too long after speech),
//     never after halt() (a send, a disabled box, a left screen), never after a real error, never when nothing was dictated;
//   cleanWorthy(part) is true for a dictated part of 3+ words (6+ CJK characters) up to CLEAN_MAX_CHARS;
//   views.js Mic calls cleanDictation on that end, shows "Cleaning…", applies the answer with applyCleaned and offers Undo.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const views = read('lib', 'mobile', 'views.js')

function body(src, name) {
  const start = src.search(new RegExp('(?:^|\\n)(?:export )?(?:async )?function ' + name + '\\b'))
  assert.notEqual(start, -1, 'views.js defines function ' + name)
  const rest = src.slice(start + 1)
  const next = rest.search(/\n(?:export )?(?:async )?function \w+|\n\/\/ ---- /)
  return next === -1 ? rest : rest.slice(0, next)
}

function fakeWin() {
  const instances = []
  class Fake {
    constructor() { instances.push(this) }
    start() {}
    stop() {}
    abort() {}
  }
  return { win: { SpeechRecognition: Fake, navigator: { language: 'en-US' } }, instances }
}
const result = (transcript, isFinal = false) => Object.assign([{ transcript }], { isFinal })
const results = (...list) => ({ resultIndex: 0, results: list })

test('the phone router serves punctuation.js as JavaScript (dictation.js imports it)', () => {
  assert.ok(Object.hasOwn(FILES, 'punctuation.js'))
  assert.match(FILES['punctuation.js'].type, /javascript/)
  assert.ok(FILES['punctuation.js'].file.endsWith('punctuation.js'))
})

test('cleanWorthy: at least 3 words (6 CJK characters) and at most CLEAN_MAX_CHARS', () => {
  assert.equal(cleanWorthy('fix the login'), true)
  assert.equal(cleanWorthy('fix it'), false)
  assert.equal(cleanWorthy('  '), false)
  assert.equal(cleanWorthy(undefined), false)
  assert.equal(cleanWorthy('修复登录页面问题'), true)
  assert.equal(cleanWorthy('修复登录'), false)
  const words = (n) => ('ab ').repeat(Math.ceil(n / 3)).slice(0, n)
  assert.equal(cleanWorthy(words(2000)), true)
  assert.equal(cleanWorthy(words(2001)), false)
  assert.equal(cleanWorthy('修'.repeat(2001)), false)
})

test('the phone limit equals the hub limit', () => {
  assert.equal(CLEAN_MAX_CHARS, MAX_DICTATION)
})

test('onEnd reports the whole dictation once when the user stops: the first base, the final text and the mic language', () => {
  const { win, instances } = fakeWin()
  const texts = []
  const ends = []
  const d = createDictation({ win, onText: (t) => texts.push(t), onEnd: (i) => ends.push(i), lang: 'en-US' })
  d.start('Notes:')
  instances[0].onstart()
  instances[0].onresult(results(result('fix the login please', true)))
  d.stop()
  assert.equal(ends.length, 0, 'not before the engine ends')
  instances[0].onend()
  assert.equal(ends.length, 1)
  assert.equal(ends[0].base, 'Notes:')
  assert.equal(ends[0].text, texts[texts.length - 1])
  assert.equal(ends[0].lang, 'en-US')
  assert.match(ends[0].text, /fix the login please/i)
})

test('onEnd after a pause restart still carries the base the dictation began with, and the pause full stop', () => {
  const { win, instances } = fakeWin()
  const ends = []
  const d = createDictation({ win, onText() {}, onEnd: (i) => ends.push(i) })
  d.start('Notes:')
  instances[0].onstart()
  instances[0].onresult(results(result('fix the login', true)))
  instances[0].onend() // silence: restarts, no end yet
  assert.equal(ends.length, 0)
  instances[1].onstart()
  instances[1].onresult(results(result('and add tests', true)))
  d.stop()
  instances[1].onend()
  assert.equal(ends.length, 1)
  assert.equal(ends[0].base, 'Notes:')
  assert.equal(ends[0].text, 'Notes: fix the login. And add tests')
})

test('onEnd is not called after halt, after a real error, or when nothing was dictated', () => {
  let r = fakeWin()
  let ends = []
  let d = createDictation({ win: r.win, onText() {}, onEnd: (i) => ends.push(i) })
  d.start('x')
  r.instances[0].onstart()
  r.instances[0].onresult(results(result('fix the login please', true)))
  d.halt()
  r.instances[0].onend()
  assert.equal(ends.length, 0, 'halt')

  r = fakeWin(); ends = []
  d = createDictation({ win: r.win, onText() {}, onError() {}, onEnd: (i) => ends.push(i) })
  d.start('x')
  r.instances[0].onstart()
  r.instances[0].onresult(results(result('fix the login please', true)))
  r.instances[0].onerror({ error: 'network' })
  r.instances[0].onend()
  assert.equal(ends.length, 0, 'error')

  r = fakeWin(); ends = []
  d = createDictation({ win: r.win, onText() {}, onEnd: (i) => ends.push(i) })
  d.start('x')
  r.instances[0].onstart()
  d.stop()
  r.instances[0].onend()
  assert.equal(ends.length, 0, 'nothing dictated')
})

function silenceRun({ speak }) {
  const { win, instances } = fakeWin()
  let t = 1000
  const ends = []
  const errors = []
  const d = createDictation({ win, onText() {}, onError: (m) => errors.push(m), onEnd: (i) => ends.push(i), now: () => t })
  d.start('')
  instances[0].onstart()
  if (speak) instances[0].onresult(results(result('fix the login page', true)))
  t += 31_000
  instances[0].onerror({ error: 'no-speech' })
  instances[0].onend()
  return { ends, errors }
}

test('the silence timeout after speech is a natural end: onEnd fires once and no "Didn\'t hear anything." shows', () => {
  const { ends, errors } = silenceRun({ speak: true })
  assert.equal(ends.length, 1)
  assert.match(ends[0].text, /fix the login page/i)
  assert.deepEqual(errors.filter(Boolean), [])
})

test('the silence timeout with nothing dictated shows the error and does not report an end', () => {
  const { ends, errors } = silenceRun({ speak: false })
  assert.equal(ends.length, 0)
  assert.deepEqual(errors.filter(Boolean), ["Didn't hear anything."])
})

test('views.js imports the cleanup helpers', () => {
  assert.match(views, /import\s*\{[^}]*\bcleanDictation\b[^}]*\}\s*from\s*['"]\.\/api\.js['"]/)
  for (const name of ['applyCleaned', 'dictatedPart', 'cleanWorthy', 'cleanFailureNote']) {
    assert.match(views, new RegExp('import\\s*\\{[^}]*\\b' + name + '\\b[^}]*\\}\\s*from\\s*[\'"]\\./punctuation\\.js[\'"]'), name)
  }
})

test('the Mic cleans on the dictation end: onEnd, the dictated part, cleanDictation, "Cleaning…", applyCleaned and an Undo button', () => {
  const mic = body(views, 'Mic')
  assert.match(mic, /createDictation\(\s*\{[^}]*onText[\s\S]*onEnd/)
  assert.match(mic, /dictatedPart\(/)
  assert.match(mic, /cleanWorthy\(/)
  assert.match(mic, /cleanDictation\(/)
  assert.match(mic, /Cleaning…/)
  assert.match(mic, /applyCleaned\(/)
  assert.match(mic, /cleanFailureNote\(/)
  assert.match(mic, />\s*Undo\s*</)
})

test('the "Cleaning…" status is a live region that stays mounted and is styled only while cleaning', () => {
  const mic = body(views, 'Mic')
  assert.match(mic, /<div class=\$\{cleaning \? 'sub' : ''\} role="status">\$\{cleaning \? 'Cleaning…' : ''\}<\/div>/)
})

test('the Mic drops a late cleaned answer: after a newer dictation, after unmount (a sequence guard and a mounted flag)', () => {
  const mic = body(views, 'Mic')
  assert.match(mic, /mine !== seq\.current/)
  assert.match(mic, /!mounted\.current/)
})

test('the cleanup stays out of dictation.js and the Mic never names an endpoint', () => {
  assert.doesNotMatch(read('lib', 'mobile', 'dictation.js'), /cleanDictation/)
  assert.doesNotMatch(body(views, 'Mic'), /\/v1\//)
})

test('the new punctuation and cleanup tests are in the package.json test script list', () => {
  const listed = JSON.parse(read('scripts', 'test-files.json'))
  for (const f of ['test/mobile-punctuation.test.mjs', 'test/mobile-dictation-punctuation.test.mjs', 'test/mobile-dictation-clean.test.mjs', 'test/mobile-dictation-clean-wiring.test.mjs', 'test/dictation-clean.test.mjs', 'test/dictation-clean-plumbing.test.mjs', 'test/agent-client-dictation-lane.test.mjs']) {
    assert.ok(listed.includes(f), f + ' is listed')
  }
})
