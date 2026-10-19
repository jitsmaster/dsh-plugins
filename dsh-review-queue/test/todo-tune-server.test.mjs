import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'

// RED tests: POST /review-queue/v1/todo-tune { text } -> { ok: true, text } | { ok: false, error }; 400 for an empty / non-string / over 4000 text
// (the limits of /v1/todo), 409 when there is no model. Service method tuneTodo(text) behind it, on the dependency createReviewQueue({ tuner })
// (tuner = createTuner(...) of todo-tune.js: { tune(text, { signal }) }). Today the route is an unknown action (404) and the service has no tuneTodo.
let server, base, queue, store, tune, seenTexts
const tuner = { tune: (text, opts) => tune(text, opts) }
before(async () => {
  store = createStore({ uuid: (() => { let n = 0; return () => 'i' + ++n })() })
  queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), registryOf: () => undefined, tuner })
  const serve = createRouter({ queue })
  server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
const post = async (body) => { const r = await fetch(base + '/v1/todo-tune', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } }
const reset = (impl) => { seenTexts = []; tune = async (text, opts) => { seenTexts.push(text); return impl ? impl(text, opts) : { ok: true, text: 'TUNED: ' + text } } }

test('POST /v1/todo-tune answers the tuned text and hands the text to the tuner as it was typed', async () => {
  reset()
  const text = 'Fix the login\n\n  - on Safari'
  const res = await post({ text })
  assert.deepEqual([res.status, res.json], [200, { ok: true, text: 'TUNED: ' + text }])
  assert.deepEqual(seenTexts, [text])
})

test('tuning adds nothing to the Task list', async () => {
  reset()
  assert.equal((await post({ text: 'rough' })).status, 200)
  assert.deepEqual(queue.snapshot().open, [])
})

test('the text limits are those of /v1/todo: empty, blank, missing and non-string are 400 empty; over 4000 is 400 too-long; the tuner is not asked', async () => {
  reset()
  for (const body of [{ text: '' }, { text: '   \n ' }, {}, { text: 42 }, { text: ['a'] }, { text: null }]) {
    const res = await post(body)
    assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'empty' }], JSON.stringify(body))
  }
  const long = await post({ text: 'x'.repeat(4001) })
  assert.deepEqual([long.status, long.json], [400, { ok: false, error: 'too-long' }])
  assert.deepEqual(seenTexts, [])
  assert.equal((await post({ text: 'x'.repeat(4000) })).status, 200, '4000 is still fine')
})

test('no model is a 409 with the tuner reason', async () => {
  reset(() => ({ ok: false, error: 'no model available' }))
  const res = await post({ text: 'rough' })
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'no model available' }])
})

test('any other failure of the tuner keeps its message and is not a 200', async () => {
  reset(() => ({ ok: false, error: 'the model returned nothing' }))
  const res = await post({ text: 'rough' })
  assert.notEqual(res.status, 200)
  assert.deepEqual(res.json, { ok: false, error: 'the model returned nothing' })
})

test('a tuner that throws still gives an { ok: false } answer, not a 500; the client only gets a generic "LLM error"', async () => {
  reset(() => { throw new Error('boom') })
  const res = await post({ text: 'rough' })
  assert.notEqual(res.status, 500)
  assert.deepEqual(res.json, { ok: false, error: 'LLM error' })
})

test('the provider detail of a throwing tuner stays in the review-queue log and never reaches the client', async () => {
  const logs = []
  const detail = 'provider 401 for key sk-secret-123 at https://llm.internal/v1'
  const q = createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}), tuner: { tune: async () => { throw new Error(detail) } }, log: (l) => logs.push(l) })
  const result = await q.tuneTodo('rough')
  assert.deepEqual(result, { ok: false, error: 'LLM error' })
  assert.ok(!JSON.stringify(result).includes('secret'))
  const line = logs.find((l) => l.includes('sk-secret-123'))
  assert.ok(line, JSON.stringify(logs))
  assert.match(line, /tune/i)
  const quiet = createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}), tuner: { tune: async () => { throw new Error('x') } } }) // no log given: still answers
  assert.deepEqual(await quiet.tuneTodo('rough'), { ok: false, error: 'LLM error' })
})

test('a wrong method is 405', async () => {
  assert.equal((await fetch(base + '/v1/todo-tune')).status, 405)
})

test('the service method: tuneTodo(text) is the same answer without HTTP, and with no tuner it is "no model available"', async () => {
  reset()
  assert.deepEqual(await queue.tuneTodo('rough'), { ok: true, text: 'TUNED: rough' })
  assert.deepEqual(await queue.tuneTodo('  '), { ok: false, error: 'empty' })
  const bare = createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}) })
  assert.deepEqual(await bare.tuneTodo('rough'), { ok: false, error: 'no model available' })
})
