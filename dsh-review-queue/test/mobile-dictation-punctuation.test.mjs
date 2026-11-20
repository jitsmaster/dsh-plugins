import { test } from 'node:test'
import assert from 'node:assert/strict'

// createDictation uses the local punctuation layer (lib/mobile/punctuation.js): the box text it reports through onText has spoken punctuation
// applied and sentences capitalised, and when the engine ends on silence and the recognition restarts (the pause) the text so far gets a
// sentence end, so a long dictation is no longer one run-on sentence. `punctuate: false` keeps the raw behaviour.
const load = async () => import('../lib/mobile/dictation.js')

function fakeWin({ language = 'en-US' } = {}) {
  const instances = []
  class Fake {
    constructor() { this.started = 0; this.stopped = 0; this.aborted = 0; instances.push(this) }
    start() { this.started++ }
    stop() { this.stopped++ }
    abort() { this.aborted++ }
  }
  return { win: { SpeechRecognition: Fake, navigator: { language } }, instances }
}
const result = (transcript, isFinal = false) => Object.assign([{ transcript }], { isFinal })
const results = (...list) => ({ resultIndex: 0, results: list })
function recorder() {
  const log = { texts: [], errors: [] }
  return { log, onText: (text, isFinal) => log.texts.push([text, isFinal]), onError: (m) => log.errors.push(m) }
}
const last = (r) => r.log.texts[r.log.texts.length - 1]

test('dictated text is capitalised into an empty box', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('')
  instances[0].onresult(results(result('hello world')))
  assert.deepEqual(last(r), ['Hello world', false])
})

test('spoken punctuation words become symbols in the box text', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('')
  instances[0].onresult(results(result('hello comma how are you question mark', true)))
  assert.deepEqual(last(r), ['Hello, how are you?', true])
})

test('text already in the box is kept and the dictation continues it without a capital mid-sentence', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('Fix the login')
  instances[0].onresult(results(result('and add a test')))
  assert.deepEqual(last(r), ['Fix the login and add a test', false])
})

test('a refined interim result replaces the previous one (still merged into the captured base)', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('Hi.')
  instances[0].onresult(results(result('hello wor')))
  instances[0].onresult(results(result('hello world comma')))
  assert.deepEqual(r.log.texts.map((t) => t[0]), ['Hi. Hello wor', 'Hi. Hello world,'])
})

test('a Chinese mic language applies the Mandarin punctuation words', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin({ language: 'zh-CN' })
  const r = recorder()
  createDictation({ win, ...r }).start('')
  instances[0].onresult(results(result('你好逗号今天怎么样问号', true)))
  assert.deepEqual(last(r), ['你好，今天怎么样？', true])
})

test('an explicit lang option decides the punctuation language', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin({ language: 'en-US' })
  const r = recorder()
  createDictation({ win, lang: 'zh-CN', ...r }).start('')
  instances[0].onresult(results(result('完成句号', true)))
  assert.deepEqual(last(r), ['完成。', true])
})

test('the pause: when the engine ends on silence and listening restarts, the text so far gets a full stop and the next words start a sentence', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('')
  instances[0].onresult(results(result('first thought')))
  instances[0].onend()
  assert.equal(instances.length, 2, 'listening restarted')
  assert.deepEqual(last(r), ['First thought.', false], 'the full stop is shown in the box at once')
  instances[1].onresult(results(result('second thought')))
  assert.deepEqual(last(r), ['First thought. Second thought', false])
})

test('the pause adds 。 after Chinese text and no second mark when the text already ends in punctuation', async () => {
  const { createDictation } = await load()
  const zh = fakeWin({ language: 'zh-CN' })
  const rz = recorder()
  createDictation({ win: zh.win, ...rz }).start('')
  zh.instances[0].onresult(results(result('你好')))
  zh.instances[0].onend()
  assert.deepEqual(last(rz), ['你好。', false])

  const en = fakeWin()
  const re = recorder()
  createDictation({ win: en.win, ...re }).start('')
  en.instances[0].onresult(results(result('really question mark')))
  en.instances[0].onend()
  assert.deepEqual(last(re), ['Really?', false])
})

test('a restart after silence with nothing spoken leaves the box text alone (no mark added to what the user typed)', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, ...r }).start('typed by hand')
  instances[0].onend()
  assert.equal(instances.length, 2, 'listening restarted')
  assert.equal(r.log.texts.length, 0, 'nothing reported')
  instances[1].onresult(results(result('more')))
  assert.deepEqual(last(r), ['typed by hand more', false])
})

test('pressing stop does not add a full stop: the user may keep typing', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  const d = createDictation({ win, ...r })
  d.start('')
  instances[0].onresult(results(result('done for now')))
  d.stop()
  instances[0].onend()
  assert.equal(instances.length, 1, 'not restarted')
  assert.deepEqual(last(r), ['Done for now', false])
})

test('punctuate: false keeps the raw text (merge only)', async () => {
  const { createDictation } = await load()
  const { win, instances } = fakeWin()
  const r = recorder()
  createDictation({ win, punctuate: false, ...r }).start('')
  instances[0].onresult(results(result('hello comma world')))
  assert.deepEqual(last(r), ['hello comma world', false])
  instances[0].onend()
  assert.deepEqual(last(r), ['hello comma world', false], 'no full stop on a pause either')
})
