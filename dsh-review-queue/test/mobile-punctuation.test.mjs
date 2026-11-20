import { test } from 'node:test'
import assert from 'node:assert/strict'

// Spoken and automatic punctuation for the phone's dictation (lib/mobile/punctuation.js, pure, no DOM). The Web Speech engine returns one run-on
// sentence with no punctuation, so the local layer (free, instant) does three things:
//   applySpokenPunctuation(text, lang) -> spoken words ("comma", "question mark", "new line", 逗号 ...) become symbols with the right spacing
//   capitalizeSentences(text, atStart) -> the first letter of each sentence/line is upper case (plain words only: never an identifier, a path, a camelCase word or npm/git-style command)
//   formatDictation(base, transcript, lang) -> the new box text: base kept, spoken punctuation applied, capitals, joined without a stray space
//   endSentence(text) -> a full stop (or 。 after Chinese) when the text does not already end in punctuation (the pause-based sentence end)
const load = async () => import('../lib/mobile/punctuation.js')

test('spoken English punctuation words become symbols attached to the previous word', async () => {
  const { applySpokenPunctuation: p } = await load()
  assert.equal(p('hello comma how are you question mark', 'en-US'), 'hello, how are you?')
  assert.equal(p('stop exclamation mark', 'en-US'), 'stop!')
  assert.equal(p('stop exclamation point', 'en-US'), 'stop!')
  assert.equal(p('done period next', 'en-US'), 'done. next')
  assert.equal(p('done full stop', 'en-US'), 'done.')
  assert.equal(p('note colon one semicolon two', 'en-US'), 'note: one; two')
  assert.equal(p('one semi colon two', 'en-US'), 'one; two')
})

test('spoken words are matched case-insensitively and as whole words only', async () => {
  const { applySpokenPunctuation: p } = await load()
  assert.equal(p('Hello Comma there', 'en-US'), 'Hello, there')
  assert.equal(p('the commander read the periodic table', 'en-US'), 'the commander read the periodic table')
  assert.equal(p('colonel', 'en-US'), 'colonel')
})

test('new line and new paragraph insert line breaks with no spaces around them', async () => {
  const { applySpokenPunctuation: p } = await load()
  assert.equal(p('first line new line second line', 'en-US'), 'first line\nsecond line')
  assert.equal(p('first newline second', 'en-US'), 'first\nsecond')
  assert.equal(p('first new paragraph second', 'en-US'), 'first\n\nsecond')
})

test('quotes and parentheses open without a trailing space and close without a leading one', async () => {
  const { applySpokenPunctuation: p } = await load()
  assert.equal(p('say open quote hi close quote now', 'en-US'), 'say "hi" now')
  assert.equal(p('say open quote hi end quote now', 'en-US'), 'say "hi" now')
  assert.equal(p('call open parenthesis x close parenthesis now', 'en-US'), 'call (x) now')
  assert.equal(p('call open paren x close paren', 'en-US'), 'call (x)')
})

test('dash is a spaced dash and hyphen joins the two words', async () => {
  const { applySpokenPunctuation: p } = await load()
  assert.equal(p('a dash b', 'en-US'), 'a - b')
  assert.equal(p('well hyphen known', 'en-US'), 'well-known')
})

test('a text with no spoken words, an empty or a non-string input comes back clean', async () => {
  const { applySpokenPunctuation: p } = await load()
  assert.equal(p('just words here', 'en-US'), 'just words here')
  assert.equal(p('', 'en-US'), '')
  assert.equal(p(undefined, 'en-US'), '')
  assert.equal(p(null), '')
  assert.equal(p('  spaced   out  ', 'en-US'), 'spaced out')
})

test('the trade-off: a spoken punctuation word is always converted, even when it was meant as a noun', async () => {
  const { applySpokenPunctuation: p, formatDictation: f } = await load()
  assert.equal(p('the trial period', 'en-US'), 'the trial.', 'a real "period" becomes a full stop')
  assert.equal(p('the trial period ends today', 'en-US'), 'the trial. ends today')
  assert.equal(p('the second colon of the line', 'en-US'), 'the second: of the line')
  assert.equal(p('a long dash', 'en-US'), 'a long -')
  assert.equal(f('', 'the trial period', 'en-US'), 'The trial.')
})

test('a lone punctuation word still produces the symbol', async () => {
  const { applySpokenPunctuation: p } = await load()
  assert.equal(p('period', 'en-US'), '.')
})

test('Mandarin punctuation words become full-width marks with no spaces, only for a Chinese mic language', async () => {
  const { applySpokenPunctuation: p } = await load()
  assert.equal(p('你好逗号今天怎么样问号', 'zh-CN'), '你好，今天怎么样？')
  assert.equal(p('你好 逗号 今天', 'zh-CN'), '你好，今天')
  assert.equal(p('完成句号', 'zh-CN'), '完成。')
  assert.equal(p('太好了感叹号', 'zh-CN'), '太好了！')
  assert.equal(p('注意冒号一分号二', 'zh-CN'), '注意：一；二')
  assert.equal(p('第一行换行第二行', 'zh-CN'), '第一行\n第二行')
  assert.equal(p('第一段新段落第二段', 'zh-CN'), '第一段\n\n第二段')
  assert.equal(p('你好逗号今天', 'en-US'), '你好逗号今天', 'not applied for an English mic language')
  assert.equal(p('你好逗号今天'), '你好逗号今天', 'not applied without a language')
})

test('English words still work with a Chinese mic language (mixed speech)', async () => {
  const { applySpokenPunctuation: p } = await load()
  assert.equal(p('open the file comma then run it', 'zh-CN'), 'open the file, then run it')
})

test('capitalizeSentences upper-cases the start, after . ? ! and after a line break', async () => {
  const { capitalizeSentences: c } = await load()
  assert.equal(c('hello world', true), 'Hello world')
  assert.equal(c('hello world', false), 'hello world')
  assert.equal(c('one. two? three! four', false), 'one. Two? Three! Four')
  assert.equal(c('one\ntwo', false), 'one\nTwo')
  assert.equal(c('"hello there"', true), '"Hello there"')
})

test('capitalizeSentences leaves identifiers, paths, numbers and ticket ids alone', async () => {
  const { capitalizeSentences: c } = await load()
  assert.equal(c('ab#26344 is done', true), 'ab#26344 is done')
  assert.equal(c('node.js is fine', true), 'node.js is fine')
  assert.equal(c('src/index.js changed', true), 'src/index.js changed')
  assert.equal(c('pr6512 merged', true), 'pr6512 merged')
  assert.equal(c('snake_case works', true), 'snake_case works')
})

test('capitalizeSentences leaves a word with an inner capital alone (getUser, iPhone, iOS, JavaScript-style camelCase)', async () => {
  const { capitalizeSentences: c } = await load()
  assert.equal(c('getUser returns iPhone data', true), 'getUser returns iPhone data')
  assert.equal(c('iOS is fine', true), 'iOS is fine')
  assert.equal(c('done. getUser again', false), 'done. getUser again')
  assert.equal(c('one\neBay sells', false), 'one\neBay sells')
  assert.equal(c('getUser(id) works', true), 'getUser(id) works')
})

test('capitalizeSentences keeps the lower-case tech words npm, pnpm, git, npx, yarn, eslint, kubectl and docker at a sentence start', async () => {
  const { capitalizeSentences: c } = await load()
  assert.equal(c('npm run build', true), 'npm run build')
  for (const w of ['npm', 'pnpm', 'git', 'npx', 'yarn', 'eslint', 'kubectl', 'docker']) assert.equal(c(w + ' status', true), w + ' status', w)
  assert.equal(c('done. git status', true), 'Done. git status')
  assert.equal(c('git, then more', true), 'git, then more')
  assert.equal(c('gitlab is next', true), 'Gitlab is next', 'only the listed words, not a word that starts with one')
})

test('capitalizeSentences still capitalises a plain word at a sentence start', async () => {
  const { capitalizeSentences: c } = await load()
  assert.equal(c('fix the login', true), 'Fix the login')
  assert.equal(c('run the build. then deploy', true), 'Run the build. Then deploy')
})

test('capitalizeSentences does not treat an abbreviation (e.g., i.e., etc., vs., Mr., Dr. ...) as a sentence end', async () => {
  const { capitalizeSentences: c } = await load()
  assert.equal(c('notes: e.g. the api is down', false), 'notes: e.g. the api is down')
  assert.equal(c('use a tool, i.e. the cli', false), 'use a tool, i.e. the cli')
  assert.equal(c('etc. and more', false), 'etc. and more')
  assert.equal(c('one vs. two', false), 'one vs. two')
  assert.equal(c('ask Mr. smith or dr. jones or mrs. lee', false), 'ask Mr. smith or dr. jones or mrs. lee')
  assert.equal(c('about approx. five', false), 'about approx. five')
  assert.equal(c('(E.G. the api) is down', false), '(E.G. the api) is down', 'case-insensitive, after an opening mark')
  assert.equal(c('hello e.g. the api', true), 'Hello e.g. the api')
})

test('capitalizeSentences still capitalises after a normal word that ends in a full stop', async () => {
  const { capitalizeSentences: c } = await load()
  assert.equal(c('fix it. then go', true), 'Fix it. Then go')
  assert.equal(c('see the doc. etc is next', false), 'see the doc. Etc is next', 'etc without a dot is a plain word')
  assert.equal(c('ship it. dr who', false), 'ship it. Dr who', 'dr without a dot is a plain word')
})

test('formatDictation capitalises into an empty box and keeps the base when nothing was said', async () => {
  const { formatDictation: f } = await load()
  assert.equal(f('', 'hello world', 'en-US'), 'Hello world')
  assert.equal(f('keep me', '', 'en-US'), 'keep me')
  assert.equal(f('keep me', '   ', 'en-US'), 'keep me')
  assert.equal(f(undefined, undefined, 'en-US'), '')
  assert.equal(f(null, ' hi ', 'en-US'), 'Hi')
})

test('formatDictation joins mid-sentence text with one space and no capital', async () => {
  const { formatDictation: f } = await load()
  assert.equal(f('Fix the login', 'and add a test', 'en-US'), 'Fix the login and add a test')
})

test('formatDictation capitalises after a finished sentence or a line break', async () => {
  const { formatDictation: f } = await load()
  assert.equal(f('Done.', 'next', 'en-US'), 'Done. Next')
  assert.equal(f('Done. ', 'next', 'en-US'), 'Done. next'.replace('next', 'Next'))
  assert.equal(f('Really?', 'yes', 'en-US'), 'Really? Yes')
  assert.equal(f('line one\n', 'line two', 'en-US'), 'line one\nLine two')
})

test('formatDictation applies spoken punctuation and capitals together', async () => {
  const { formatDictation: f } = await load()
  assert.equal(f('', 'one period two', 'en-US'), 'One. Two')
  assert.equal(f('', 'hello comma how are you question mark', 'en-US'), 'Hello, how are you?')
})

test('a transcript that starts with punctuation attaches to the base without a space', async () => {
  const { formatDictation: f } = await load()
  assert.equal(f('Done', 'period', 'en-US'), 'Done.')
  assert.equal(f('Done ', 'comma next', 'en-US'), 'Done, next')
  assert.equal(f('Line', 'new line next', 'en-US'), 'Line\nNext')
})

test('formatDictation is repeatable: an interim result refines without piling up (same base, new transcript)', async () => {
  const { formatDictation: f } = await load()
  const a = f('Hi.', 'hello wor', 'en-US')
  const b = f('Hi.', 'hello world comma', 'en-US')
  assert.equal(a, 'Hi. Hello wor')
  assert.equal(b, 'Hi. Hello world,')
})

test('endSentence adds a full stop, or 。 after Chinese, unless the text already ends in punctuation', async () => {
  const { endSentence: e } = await load()
  assert.equal(e('hello'), 'hello.')
  assert.equal(e('hello.'), 'hello.')
  assert.equal(e('hello?'), 'hello?')
  assert.equal(e('hello!'), 'hello!')
  assert.equal(e('你好'), '你好。')
  assert.equal(e('你好。'), '你好。')
  assert.equal(e('你好？'), '你好？')
  assert.equal(e('list:'), 'list:')
  assert.equal(e('one,'), 'one,')
  assert.equal(e('say "hi"'), 'say "hi".'.replace('".', '"'), 'a closing quote ends the sentence as it is')
  assert.equal(e(''), '')
  assert.equal(e('   '), '   ')
  assert.equal(e('line\n'), 'line\n')
  assert.equal(e(undefined), '')
})

test('the English spoken words apply only to an English, unset or Chinese (mixed speech) mic language', async () => {
  const { applySpokenPunctuation: p } = await load()
  assert.equal(p('the comma is here', 'it-IT'), 'the comma is here')
  assert.equal(p('the colon is here', 'es-ES'), 'the colon is here')
  assert.equal(p('the colon is here', 'de'), 'the colon is here')
  assert.equal(p('hello comma world', 'en-GB'), 'hello, world')
  assert.equal(p('hello comma world', 'EN-us'), 'hello, world')
  assert.equal(p('hello comma world', 'en'), 'hello, world')
  assert.equal(p('hello comma world', undefined), 'hello, world')
  assert.equal(p('hello comma world', ''), 'hello, world')
  assert.equal(p('hello comma world', 'zh-CN'), 'hello, world', 'mixed speech keeps working for Chinese')
  assert.equal(p('你好逗号今天', 'zh-CN'), '你好，今天')
})

test('endSentence leaves a text ending in a script that does not use the ASCII stop (Arabic, Devanagari, Thai) unchanged', async () => {
  const { endSentence: e } = await load()
  assert.equal(e('مرحبا'), 'مرحبا')
  assert.equal(e('नमस्ते'), 'नमस्ते')
  assert.equal(e('สวัสดี'), 'สวัสดี')
  assert.equal(e('hello'), 'hello.')
})
test('endSentence leaves a text that ends in an opening or joining mark alone (word dash, open parenthesis), with or without trailing blanks', async () => {
  const { endSentence: e } = await load()
  assert.equal(e('word -'), 'word -')
  assert.equal(e('word-'), 'word-')
  assert.equal(e('open ('), 'open (')
  assert.equal(e('open ( '), 'open ( ')
  assert.equal(e('word – '), 'word – ')
  assert.equal(e('word —'), 'word —')
  assert.equal(e('see ['), 'see [')
  assert.equal(e('see {'), 'see {')
  assert.equal(e('word'), 'word.')
})

test('formatDictation: an attach mark spoken right after a pause stop replaces or merges with the stop instead of doubling it', async () => {
  const { formatDictation: f } = await load()
  assert.equal(f('Hello world.', 'comma and more', 'en-US'), 'Hello world, and more')
  assert.equal(f('Hello world.', 'colon and more', 'en-US'), 'Hello world: and more')
  assert.equal(f('Hello world.', 'semicolon and more', 'en-US'), 'Hello world; and more')
  assert.equal(f('Hello world.', 'period', 'en-US'), 'Hello world.')
  assert.equal(f('Hello world.', 'period next one', 'en-US'), 'Hello world. Next one')
  assert.equal(f('Hello world.', 'question mark', 'en-US'), 'Hello world?')
  assert.equal(f('Hello world.', 'exclamation mark', 'en-US'), 'Hello world!')
  assert.equal(f('你好。', '逗号然后', 'zh-CN'), '你好，然后')
  assert.equal(f('你好。', '句号', 'zh-CN'), '你好。')
  assert.equal(f('你好。', '问号', 'zh-CN'), '你好？')
})

test('formatDictation leaves a base that does not end in a full stop alone, and an ellipsis', async () => {
  const { formatDictation: f } = await load()
  assert.equal(f('Hello world', 'comma and more', 'en-US'), 'Hello world, and more')
  assert.equal(f('Hello world?', 'comma and more', 'en-US'), 'Hello world?, and more')
  assert.equal(f('Wait...', 'comma and more', 'en-US'), 'Wait..., and more')
  assert.equal(f('Hello world. ', 'comma and more', 'en-US'), 'Hello world., and more') // only a base that ends exactly in the stop is the pause stop: this one was typed
})

test('cleanFailureNote is silent for the expected failures and words the unexpected ones', async () => {
  const { cleanFailureNote: n } = await load()
  for (const code of ['no-registry', 'no model available', 'rate-limited', 'signed-out', 'empty', 'busy', 'unknown-command', 'owner-timeout', 'owner-offline', 'unknown-outcome', 'shutting-down', 'superseded']) assert.equal(n(code), null, code)
  for (const code of ['failed', 'timeout', 'unusable', 'LLM error', 'something-new', undefined, null, '']) assert.equal(n(code), 'Could not tidy the text: kept as dictated.', String(code))
})
