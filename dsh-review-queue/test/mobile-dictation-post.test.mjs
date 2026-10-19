import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Dictation vs Send, end to end below the views (no DOM): the real dictation controller (fake Web Speech engine), the real draft buffer and the
// real postFollowUp, glued the way the Composer glues them (views.js). Review finding: a recognition still listening or finalizing after Send kept
// calling onText, so (A) the buffer wrote the just-sent text back into state.replies once the post was accepted, or (B) a final result that
// differed from the sent interim text made postFollowUp keep the draft after success.
globalThis.location = { pathname: '/review-queue/m/', hash: '#/item/i1' }
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)) }, removeItem: (k) => { store.delete(k) } }
globalThis.document = { hidden: false, addEventListener() {} }
globalThis.window = { addEventListener() {} }
const api = await import('../lib/mobile/api.js')
const { createDraftBuffer } = await import('../lib/mobile/thread.js')
const { createDictation } = await import('../lib/mobile/dictation.js')

const TOKEN = 'rqd_' + 'C'.repeat(43)
const ID = 'i1'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const result = (transcript, isFinal = false) => Object.assign([{ transcript }], { isFinal })
const results = (...list) => ({ resultIndex: 0, results: list })

let instances, release, glue
function composer() {
  const buffer = createDraftBuffer({ read: () => api.state.replies[ID] || '', write: (text) => api.set({ replies: { ...api.state.replies, [ID]: text } }), delay: 20 })
  class Fake { constructor() { this.aborted = 0; instances.push(this) } start() {} stop() {} abort() { this.aborted++ } }
  const dictation = createDictation({ win: { SpeechRecognition: Fake, navigator: { language: 'en-US' } }, onText: (t) => setDraft(t) })
  // the Composer's glue (views.js): dictated text is ignored while a post runs; Send halts the dictation, flushes the draft, then posts
  const setDraft = (text) => { if (api.state.busy[ID]) return; buffer.set(text) }
  const send = async () => { dictation.halt(); buffer.flush(); return api.postFollowUp(ID, api.state.replies[ID] || '') }
  return { buffer, dictation, setDraft, send }
}

beforeEach(() => {
  instances = []
  store.clear()
  store.set('rq-m.token', TOKEN)
  api.setCoreForTests({ errorText: (s) => 'E' + s, pruneSaved: (saved) => saved })
  api.set({ needsPairing: false, error: null, auth: false, errors: {}, busy: {}, replies: {}, threads: {}, snap: { open: [{ id: ID, type: 'completed', sessionId: 's1', summary: 'x' }], resolved: [] } })
  release = null
  globalThis.fetch = async (url, init = {}) => {
    const path = url.replace('/review-queue', '')
    if (path === '/v1/post') { await new Promise((r) => { release = r }) }
    const body = path === '/v1/thread' ? { ok: true, sessionId: 's1', title: 't', messages: [], hasMore: false } : { ok: true }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }
  }
  glue = composer()
})

test('(A) a late final result after an accepted post does not write the sent text back into the drafts', async () => {
  glue.dictation.start('')
  instances[0].onstart()
  instances[0].onresult(results(result('please run the tests')))
  await wait(40) // the buffer flushed the interim text into state.replies
  assert.equal(api.state.replies[ID], 'please run the tests')
  const sending = glue.send()
  await wait(5)
  assert.equal(api.state.busy[ID], true)
  release()
  await sending
  assert.equal(api.state.replies[ID], '', 'the accepted post cleared the draft')
  instances[0].onresult(results(result('please run the tests', true))) // the engine was still finalizing
  await wait(60) // longer than the buffer delay
  assert.equal(api.state.replies[ID], '', 'the sent text did not come back as an unsent draft')
  assert.equal(instances[0].aborted, 1, 'the recognition was aborted by Send')
})

test('(B) a final result that differs from the sent interim text does not make the draft survive an accepted post', async () => {
  glue.dictation.start('')
  instances[0].onstart()
  instances[0].onresult(results(result('please run the test')))
  await wait(40)
  const sending = glue.send()
  await wait(5)
  instances[0].onresult(results(result('please run the tests', true))) // arrives while the post is in flight, differs from the sent text
  release()
  await sending
  await wait(60)
  assert.equal(api.state.replies[ID], '', 'the draft was cleared by the accepted post and nothing refilled it')
})

test('dictated text that arrives while a post runs is ignored even without a halt (the busy guard of the composer)', async () => {
  glue.dictation.start('')
  instances[0].onstart()
  instances[0].onresult(results(result('hello there')))
  await wait(40)
  glue.buffer.flush()
  const sending = api.postFollowUp(ID, api.state.replies[ID]) // a post that did not go through the composer's Send (no halt)
  await wait(5)
  instances[0].onresult(results(result('hello there!', true)))
  release()
  await sending
  await wait(60)
  assert.equal(api.state.replies[ID], '')
})
