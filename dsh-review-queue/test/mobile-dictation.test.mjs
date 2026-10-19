import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Dictation (speech to text) for the phone: fills a text box, never sends. lib/mobile/dictation.js is pure and driven by an injected
// SpeechRecognition class (the Web Speech API: in Chrome/TWA on Android that is Google's speech service). Plain STT, no LLM.
// Contract under test:
//   dictationSupport(win)            -> the SpeechRecognition constructor (standard or webkit-prefixed), or null
//   mergeDictation(base, transcript) -> the new box text: base (never lost) + one space when needed + the trimmed transcript
//   dictationError(code)             -> a short plain message, or null when nothing should be shown (aborted)
//   createDictation({ win, onText, onState, onError, lang }) -> { start(base?), stop(), listening } or null without support
//     start(base) captures the box text at that moment; onText(newBoxText, isFinal) is the ONLY way text leaves the module;
//     onState(listening) follows onstart/onend; onError(message|null) shows a message under the box (null clears it).
// The module is imported per test (not at the top) so each case fails on its own while lib/mobile/dictation.js does not exist yet.
const load = async () => import('../lib/mobile/dictation.js')

/** A fake Web Speech API: every instance is kept so a test can fire its events. */
function fakeWin({ name = 'SpeechRecognition', language = 'en-GB', navigator = { language }, startThrows } = {}) {
  const instances = []
  class Fake {
    constructor() { this.started = 0; this.stopped = 0; this.aborted = 0; instances.push(this) }
    start() { if (startThrows) throw startThrows; this.started++ }
    stop() { this.stopped++ }
    abort() { this.aborted++ }
  }
  const win = { [name]: Fake }
  if (navigator) win.navigator = navigator
  return { win, instances, Fake }
}
const result = (transcript, isFinal = false) => Object.assign([{ transcript }], { isFinal })
const results = (...list) => ({ resultIndex: 0, results: list })
function recorder() {
  const log = { texts: [], states: [], errors: [] }
  return { log, onText: (text, isFinal) => log.texts.push([text, isFinal]), onState: (on) => log.states.push(on), onError: (message) => log.errors.push(message) }
}
const stopsOf = (rec) => rec.stopped + rec.aborted

// ---- dictationSupport ----------------------------------------------------------------------------------------------------------------

test('dictationSupport returns the standard SpeechRecognition constructor', async () => {
  const { dictationSupport } = await load()
  const { win, Fake } = fakeWin()
  assert.equal(dictationSupport(win), Fake)
})

test('dictationSupport falls back to webkitSpeechRecognition (Chrome on Android)', async () => {
  const { dictationSupport } = await load()
  const { win, Fake } = fakeWin({ name: 'webkitSpeechRecognition' })
  assert.equal(dictationSupport(win), Fake)
})

test('dictationSupport returns null when the API is missing, and never throws on a missing window', async () => {
  const { dictationSupport } = await load()
  assert.equal(dictationSupport({}), null)
  assert.equal(dictationSupport({ SpeechRecognition: 'nope' }), null, 'not a constructor')
  assert.equal(dictationSupport(undefined), null)
  assert.equal(dictationSupport(null), null)
})

// ---- mergeDictation ------------------------------------------------------------------------------------------------------------------

test('mergeDictation appends the transcript to the existing text with one separating space', async () => {
  const { mergeDictation } = await load()
  assert.equal(mergeDictation('Fix the login', 'and add a test'), 'Fix the login and add a test')
})

test('mergeDictation uses no extra space when the box is empty or the base already ends in whitespace', async () => {
  const { mergeDictation } = await load()
  assert.equal(mergeDictation('', 'hello'), 'hello')
  assert.equal(mergeDictation('Done. ', 'next'), 'Done. next')
  assert.equal(mergeDictation('line one\n', 'line two'), 'line one\nline two')
})

test('mergeDictation trims the transcript and never loses the existing text', async () => {
  const { mergeDictation } = await load()
  assert.equal(mergeDictation('abc', '  hello world \n'), 'abc hello world')
  assert.equal(mergeDictation('keep me', ''), 'keep me')
  assert.equal(mergeDictation('keep me', '   '), 'keep me')
  assert.equal(mergeDictation('keep me', undefined), 'keep me')
})

test('mergeDictation tolerates a missing base', async () => {
  const { mergeDictation } = await load()
  assert.equal(mergeDictation(undefined, 'hello'), 'hello')
  assert.equal(mergeDictation(null, ' hi '), 'hi')
  assert.equal(mergeDictation(undefined, undefined), '')
})

// ---- dictationError ------------------------------------------------------------------------------------------------------------------

test('dictationError: a blocked microphone permission points at the Chrome site settings (not-allowed and service-not-allowed)', async () => {
  const { dictationError } = await load()
  for (const code of ['not-allowed', 'service-not-allowed']) {
    const m = dictationError(code)
    assert.match(m, /microphone/i, code)
    assert.match(m, /permission/i, code)
    assert.match(m, /blocked/i, code)
    assert.match(m, /Chrome/, code)
    assert.match(m, /settings/i, code)
  }
  assert.equal(dictationError('not-allowed'), dictationError('service-not-allowed'))
})

test('dictationError: no-speech, audio-capture, network and language-not-supported each get their own plain message', async () => {
  const { dictationError } = await load()
  assert.match(dictationError('no-speech'), /Didn.t hear anything/)
  assert.match(dictationError('audio-capture'), /no microphone/i)
  assert.match(dictationError('network'), /speech service/i)
  assert.match(dictationError('network'), /reach/i)
  assert.match(dictationError('language-not-supported'), /language/i)
  const all = ['no-speech', 'audio-capture', 'network', 'language-not-supported', 'not-allowed'].map(dictationError)
  assert.equal(new Set(all).size, all.length, 'distinct messages')
})

test('dictationError: every message is a short single line', async () => {
  const { dictationError } = await load()
  for (const code of ['not-allowed', 'service-not-allowed', 'no-speech', 'audio-capture', 'network', 'language-not-supported', 'bad-grammar']) {
    const m = dictationError(code)
    assert.equal(typeof m, 'string', code)
    assert.ok(m.length > 0 && m.length <= 120, code + ' length ' + m.length)
    assert.ok(!/[\r\n]/.test(m), code)
  }
})

test('dictationError: aborted is silent (null), an unknown code gets a generic message that names it', async () => {
  const { dictationError } = await load()
  assert.equal(dictationError('aborted'), null)
  const m = dictationError('something-new')
  assert.equal(typeof m, 'string')
  assert.ok(m.includes('something-new'))
})

// ---- createDictation: configuration --------------------------------------------------------------------------------------------------

test('createDictation returns null when the browser has no speech recognition', async () => {
  const { createDictation } = await load()
  assert.equal(createDictation({ win: {} }), null)
})

test('createDictation sets lang from navigator.language, shows interim results and is not continuous', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin({ language: 'de-DE' })
  createDictation({ win, ...recorder() }).start('')
  assert.equal(instances.length, 1)
  assert.equal(instances[0].lang, 'de-DE')
  assert.equal(instances[0].interimResults, true)
  assert.equal(instances[0].continuous, false)
  assert.equal(instances[0].started, 1)
})

test('createDictation falls back to en-US without a navigator language, and an explicit lang wins', async () => {
  const { createDictation } = await load()
  const none = fakeWin({ navigator: null })
  createDictation({ win: none.win, ...recorder() }).start('')
  assert.equal(none.instances[0].lang, 'en-US')
  const blank = fakeWin({ navigator: { language: '' } })
  createDictation({ win: blank.win, ...recorder() }).start('')
  assert.equal(blank.instances[0].lang, 'en-US')
  const explicit = fakeWin({ language: 'de-DE' })
  createDictation({ win: explicit.win, lang: 'fr-FR', ...recorder() }).start('')
  assert.equal(explicit.instances[0].lang, 'fr-FR')
})

test('createDictation works without any callbacks', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const d = createDictation({ win })
  assert.doesNotThrow(() => { d.start('x'); instances[0].onstart(); instances[0].onresult(results(result('hi', true))); instances[0].onend(); d.stop() })
})

// ---- createDictation: text flow ------------------------------------------------------------------------------------------------------

test('listening follows onstart and onend, and onState reports each change', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  assert.equal(d.listening, false)
  d.start('')
  instances[0].onstart()
  assert.equal(d.listening, true)
  instances[0].onend()
  assert.equal(d.listening, false)
  assert.deepEqual(r.log.states, [true, false])
})

test('an interim result is pasted after the text that was in the box when dictation started', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('Fix the login')
  instances[0].onstart()
  instances[0].onresult(results(result('and add')))
  assert.deepEqual(r.log.texts, [['Fix the login and add', false]])
})

test('a later interim result replaces the earlier one instead of accumulating', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('Fix')
  instances[0].onresult(results(result('and')))
  instances[0].onresult(results(result('and add')))
  instances[0].onresult(results(result('and add a test')))
  assert.deepEqual(r.log.texts, [['Fix and', false], ['Fix and add', false], ['Fix and add a test', false]])
})

test('the final result commits the text, flagged as final', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('Fix')
  instances[0].onresult(results(result('and add')))
  instances[0].onresult(results(result('and add a test', true)))
  instances[0].onend()
  assert.deepEqual(r.log.texts.at(-1), ['Fix and add a test', true])
  assert.equal(r.log.texts.filter(([, final]) => final).length, 1)
})

test('the transcript of every result in the list is joined (Android Chrome splits one phrase into several results)', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('')
  instances[0].onresult(results(result('hello', true), result(' wor')))
  assert.deepEqual(r.log.texts, [['hello wor', false]], 'one interim result left, so not final yet')
  instances[0].onresult(results(result('hello', true), result(' world', true)))
  assert.deepEqual(r.log.texts.at(-1), ['hello world', true])
})

test('dictation into an empty box does not add a leading space, and an empty transcript leaves the text alone', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('')
  instances[0].onresult(results(result('  hi there ')))
  assert.deepEqual(r.log.texts, [['hi there', false]])
  const again = fakeWin()
  const r2 = recorder()
  createDictation({ win: again.win, ...r2 }).start('keep')
  again.instances[0].onresult(results(result('')))
  assert.deepEqual(r2.log.texts, [['keep', false]])
})

test('a second start captures its own base: each dictation appends to what the box holds then', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  d.start('one')
  instances[0].onstart()
  instances[0].onresult(results(result('two', true)))
  instances[0].onend()
  d.start('one two')
  instances[1].onstart()
  instances[1].onresult(results(result('three', true)))
  assert.deepEqual(r.log.texts, [['one two', true], ['one two three', true]])
})

// ---- createDictation: never sends, one at a time, stop ------------------------------------------------------------------------------

test('dictation only reports text through onText: it has no way to send, and its source does not touch the network or the actions', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'mobile', 'dictation.js'), 'utf8')
  assert.ok(!/\bfetch\s*\(/.test(src), 'no fetch')
  assert.ok(!/\bact\s*\(/.test(src), 'no act()')
  assert.ok(!/\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b/.test(src), 'no other transport')
  assert.ok(!/from\s*['"]\.\/api\.js['"]/.test(src), 'does not import the api (and so cannot call an action)')
  assert.ok(!/\/v1\//.test(src), 'names no endpoint')
})

test('starting a second dictation stops the first one: one recognition at a time', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const a = createDictation({ win, ...recorder() })
  const b = createDictation({ win, ...recorder() })
  a.start('a')
  instances[0].onstart()
  b.start('b')
  assert.ok(stopsOf(instances[0]) >= 1, 'the first recognition was stopped')
  assert.equal(instances[1].started, 1, 'the second one runs')
})

test('start while already listening does not open a second recognition', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const d = createDictation({ win, ...recorder() })
  d.start('a')
  instances[0].onstart()
  d.start('a')
  assert.equal(instances.length, 1)
  assert.equal(instances[0].started, 1)
})

test('stop asks the recognition to stop and the state turns off at onend', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  d.start('x')
  instances[0].onstart()
  d.stop()
  assert.ok(stopsOf(instances[0]) >= 1)
  instances[0].onend()
  assert.equal(d.listening, false)
  assert.deepEqual(r.log.states, [true, false])
})

test('stop without a running dictation does nothing and does not throw', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const d = createDictation({ win, ...recorder() })
  assert.doesNotThrow(() => d.stop())
  assert.equal(instances.length, 0)
})

test('after the recognition ended, a late result from the engine cannot put text in the box', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  d.start('x')
  instances[0].onstart()
  d.stop()
  instances[0].onend()
  const before = r.log.texts.length
  instances[0].onresult(results(result('late', true)))
  assert.equal(r.log.texts.length, before)
})

// ---- createDictation: errors ---------------------------------------------------------------------------------------------------------

test('an engine error is reported as its plain message through onError, and the end turns listening off', async () => {
  const { createDictation, dictationError } = await load()
  for (const code of ['not-allowed', 'service-not-allowed', 'no-speech', 'audio-capture', 'network', 'language-not-supported']) {
    const { win, instances } = fakeWin()
    const r = recorder()
    const d = createDictation({ win, ...r })
    d.start('x')
    instances[0].onstart()
    instances[0].onerror({ error: code })
    instances[0].onend()
    assert.deepEqual(r.log.errors.filter(Boolean), [dictationError(code)], code)
    assert.equal(d.listening, false, code)
    assert.deepEqual(r.log.texts, [], code + ': an error never writes text')
  }
})

test('an aborted recognition (stopped by us or by a second start) shows no error', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('x')
  instances[0].onerror({ error: 'aborted' })
  instances[0].onend()
  assert.deepEqual(r.log.errors.filter(Boolean), [])
})

test('starting clears an earlier error message', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  d.start('x')
  instances[0].onerror({ error: 'no-speech' })
  instances[0].onend()
  d.start('x')
  assert.equal(r.log.errors.at(-1), null)
})

test('a recognition that throws on start (engine busy, not allowed here) becomes an error message, not an exception', async () => {
  const { createDictation } = await load()
  const { win } = fakeWin({ startThrows: new Error('InvalidStateError') })
  const r = recorder()
  const d = createDictation({ win, ...r })
  assert.doesNotThrow(() => d.start('x'))
  assert.equal(d.listening, false)
  assert.ok(r.log.errors.some((m) => typeof m === 'string' && m.length > 0))
  assert.notEqual(r.log.states.at(-1), true)
})

// ---- iOS (Safari / Home Screen app) --------------------------------------------------------------------------------------------------------
// dictationError(code, { ios } = {}): with { ios: true } a blocked microphone / speech permission points at the iPhone's Settings (Safari, Siri &
// Dictation) instead of Chrome's site settings. Every other code, and calls without the option, are unchanged. createDictation({ ..., ios })
// passes the flag to dictationError, and views.js's Mic passes platformInfo(...).ios.
const IOS_PERMISSION_CODES = ['not-allowed', 'service-not-allowed']

test('dictationError with { ios: true }: a blocked permission gets a distinct iPhone message that mentions Settings and Safari or Siri & Dictation', async () => {
  const { dictationError } = await load()
  for (const code of IOS_PERMISSION_CODES) {
    const m = dictationError(code, { ios: true })
    assert.equal(typeof m, 'string', code)
    assert.notEqual(m, dictationError(code), code + ': differs from the Chrome message')
    assert.match(m, /Settings/, code)
    assert.match(m, /Safari|Siri & Dictation/, code)
    assert.ok(!/Chrome/.test(m), code + ': no Chrome wording on an iPhone')
    assert.match(m, /microphone|speech|dictation/i, code)
  }
  assert.equal(dictationError('not-allowed', { ios: true }), dictationError('service-not-allowed', { ios: true }))
})

test('dictationError with { ios: true }: the message is a single line of at most 120 characters', async () => {
  const { dictationError } = await load()
  for (const code of IOS_PERMISSION_CODES) {
    const m = dictationError(code, { ios: true })
    assert.ok(m.length > 0 && m.length <= 120, code + ' length ' + m.length)
    assert.ok(!/[\r\n]/.test(m), code + ' single line')
  }
})

test('dictationError with { ios: true }: no-speech, audio-capture, network, language-not-supported, aborted and unknown codes are unchanged', async () => {
  const { dictationError } = await load()
  for (const code of ['no-speech', 'audio-capture', 'network', 'language-not-supported', 'aborted', 'bad-grammar', 'something-new']) {
    assert.equal(dictationError(code, { ios: true }), dictationError(code), code)
  }
})

test('dictationError without the option, with ios false, or with an empty options object keeps the Chrome message', async () => {
  const { dictationError } = await load()
  for (const code of IOS_PERMISSION_CODES) {
    const chrome = dictationError(code)
    assert.match(chrome, /Chrome/, code)
    assert.equal(dictationError(code, {}), chrome, code)
    assert.equal(dictationError(code, { ios: false }), chrome, code)
    assert.equal(dictationError(code, undefined), chrome, code)
    assert.equal(dictationError(code, { ios: 'yes' }), chrome, code + ': only ios === true counts')
  }
})

test('createDictation({ ios: true }) reports the iPhone message when the permission is blocked, and the Chrome message without ios', async () => {
  const { createDictation, dictationError } = await load()
  for (const code of IOS_PERMISSION_CODES) {
    const ios = fakeWin()
    const r = recorder()
    createDictation({ win: ios.win, ios: true, ...r }).start('x')
    ios.instances[0].onstart()
    ios.instances[0].onerror({ error: code })
    ios.instances[0].onend()
    assert.deepEqual(r.log.errors.filter(Boolean), [dictationError(code, { ios: true })], code)
    assert.match(r.log.errors.filter(Boolean)[0], /Settings/, code + ': it is the iPhone message')
    assert.ok(!/Chrome/.test(r.log.errors.filter(Boolean)[0]), code + ': no Chrome wording')

    const plain = fakeWin()
    const r2 = recorder()
    createDictation({ win: plain.win, ...r2 }).start('x')
    plain.instances[0].onerror({ error: code })
    assert.deepEqual(r2.log.errors.filter(Boolean), [dictationError(code)], code)
  }
})

test('createDictation({ ios: true }) leaves other engine errors as they were (no-speech)', async () => {
  const { createDictation, dictationError } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ios: true, ...r }).start('x')
  instances[0].onerror({ error: 'no-speech' })
  assert.deepEqual(r.log.errors.filter(Boolean), [dictationError('no-speech')])
})

test('the iOS option keeps the dictation source rules (no fetch, act(), other transports, api import or endpoint names)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'mobile', 'dictation.js'), 'utf8')
  assert.ok(!/\bfetch\s*\(/.test(src), 'no fetch')
  assert.ok(!/\bact\s*\(/.test(src), 'no act()')
  assert.ok(!/\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b/.test(src), 'no other transport')
  assert.ok(!/from\s*['"]\.\/api\.js['"]/.test(src), 'does not import the api')
  assert.ok(!/\/v1\//.test(src), 'names no endpoint')
  assert.match(src, /ios/, 'the module knows about the ios option')
})

// ---- halt: stop for good (a send, a disabled box, a left screen) ----------------------------------------------------------------------
// stop() asks the engine to finish: the last (final) result still arrives. halt() is the hard version: it aborts the recognition and nothing
// that engine reports afterwards (a late interim or final result, an error, onend) reaches onText/onError any more. The Composer halts before
// it posts, so a result that lands after the post cannot put the sent text back into the box. Review finding: a recognition still finalizing
// after Send wrote the sent text back as an unsent draft, or a final result that differed from the interim text kept the draft after success.

test('halt aborts the recognition and turns listening off at once', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  d.start('x')
  instances[0].onstart()
  assert.equal(typeof d.halt, 'function', 'a dictation can be halted')
  d.halt()
  assert.equal(instances[0].aborted, 1, 'abort drops what was not recognised yet (stop would let a final result through)')
  assert.equal(instances[0].stopped, 0)
  assert.equal(d.listening, false)
  assert.deepEqual(r.log.states, [true, false])
})

test('after halt a late interim or final result does not call onText', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  d.start('Fix the login')
  instances[0].onstart()
  instances[0].onresult(results(result('and add')))
  assert.equal(typeof d.halt, 'function')
  d.halt()
  const before = r.log.texts.length
  instances[0].onresult(results(result('and add a test')))
  instances[0].onresult(results(result('and add a test', true)))
  assert.equal(r.log.texts.length, before, 'nothing reached the box after the halt')
})

test('after halt a late error and the late onend neither show a message nor flip the state again', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  d.start('x')
  instances[0].onstart()
  d.halt()
  instances[0].onerror({ error: 'network' })
  instances[0].onerror({ error: 'aborted' })
  instances[0].onend()
  assert.deepEqual(r.log.errors.filter(Boolean), [])
  assert.deepEqual(r.log.states, [true, false])
})

test('halt before the engine reported onstart still cancels the dictation', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  d.start('x')
  assert.equal(typeof d.halt, 'function')
  d.halt()
  instances[0].onstart()
  instances[0].onresult(results(result('late', true)))
  assert.equal(instances[0].aborted, 1)
  assert.equal(d.listening, false, 'a start event of a halted recognition does not switch listening back on')
  assert.deepEqual(r.log.texts, [])
})

test('halt without a running dictation does nothing and does not throw (twice either)', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const d = createDictation({ win, ...recorder() })
  assert.equal(typeof d.halt, 'function')
  assert.doesNotThrow(() => { d.halt(); d.halt() })
  assert.equal(instances.length, 0)
  d.start('x')
  instances[0].onstart()
  d.halt()
  d.halt()
  assert.equal(instances[0].aborted, 1, 'aborted once')
})

test('a dictation started after a halt works again: the new recognition delivers text, the halted one stays silent', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  d.start('one')
  instances[0].onstart()
  assert.equal(typeof d.halt, 'function')
  d.halt()
  d.start('')
  instances[1].onstart()
  instances[0].onresult(results(result('ghost', true)))
  instances[1].onresult(results(result('two', true)))
  assert.deepEqual(r.log.texts, [['two', true]])
  assert.equal(d.listening, true)
})

test('stop still lets the engine deliver its final result (halt is the one that drops it)', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  d.start('x')
  instances[0].onstart()
  d.stop()
  instances[0].onresult(results(result('final words', true)))
  assert.deepEqual(r.log.texts, [['x final words', true]])
})

test('a halted dictation does not leave the one-at-a-time slot taken: another dictation can start without aborting anything', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const a = createDictation({ win, ...recorder() })
  const b = createDictation({ win, ...recorder() })
  a.start('a')
  instances[0].onstart()
  assert.equal(typeof a.halt, 'function')
  a.halt()
  b.start('b')
  assert.equal(instances[0].aborted, 1, 'the first recognition was aborted once, by halt, not again by the second start')
  assert.equal(instances[1].started, 1)
})
