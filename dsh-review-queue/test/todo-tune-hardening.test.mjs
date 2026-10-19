import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { createTuner } from '../todo-tune.js'
import { fakeLlm } from './todo-tune-helpers.mjs'

const SECRET = 'sk-live-ABC123SECRET'
const URL_ = 'https://llm.internal.example/v1/chat'
const failingLlm = { listProviders: async () => [{ id: 'p1' }], listModels: async () => [{ id: 'claude-haiku-x' }], prepareCall: async () => { throw new Error('401 from ' + URL_ + ' with key ' + SECRET) } }
const quiet = (extra = {}) => createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => ({}), ...extra })

// ---- the provider's message never reaches the browser (REAL tuner) ----
test('a provider error with a key and a URL: the tuner result and the HTTP answer carry neither, the log has the detail', async (t) => {
  const logs = []
  const tuner = createTuner({ llm: failingLlm, rulesText: 'R', log: (l) => logs.push(l) })
  assert.deepEqual(await tuner.tune('rough'), { ok: false, error: 'LLM error' })
  const queue = quiet({ tuner, log: (l) => logs.push(l) })
  const result = await queue.tuneTodo('rough')
  assert.deepEqual(result, { ok: false, error: 'LLM error' })
  const server = createServer(createRouter({ queue }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const res = await fetch('http://127.0.0.1:' + server.address().port + '/v1/todo-tune', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'rough' }) })
  const body = await res.text()
  for (const secret of [SECRET, 'llm.internal', '401']) assert.ok(!body.includes(secret), secret + ' in ' + body)
  assert.ok(logs.some((l) => l.includes(SECRET) && l.includes('LLM error')), JSON.stringify(logs))
})

test('a provider list that throws is a generic LLM error too, with the detail in the log', async () => {
  const logs = []
  const r = await createTuner({ llm: fakeLlm({ providersThrow: true }), rulesText: 'R', log: (l) => logs.push(l) }).tune('rough')
  assert.deepEqual(r, { ok: false, error: 'LLM error' })
  assert.ok(logs.some((l) => /providers down/.test(l)))
})

test('the readable failures stay readable: timeout and no model', async () => {
  assert.match((await createTuner({ llm: fakeLlm({ hang: true }), rulesText: 'R', timeoutMs: 30 }).tune('rough')).error, /timed out/)
  assert.deepEqual(await createTuner({ rulesText: 'R' }).tune('rough'), { ok: false, error: 'no model available' })
})

// ---- a text that is only a flag ----
test('a text that is only a flag is empty once the flag is stripped: no model call', async () => {
  const seen = {}
  const tuner = createTuner({ llm: fakeLlm({ answer: 'x', seen }), rulesText: 'R' })
  for (const raw of ['--thorough', '  --concise \n', '\n--thorough']) assert.deepEqual(await tuner.tune(raw), { ok: false, error: 'empty' }, JSON.stringify(raw))
  assert.equal(seen.calls, 0)
  assert.deepEqual(await quiet({ tuner }).tuneTodo('--thorough'), { ok: false, error: 'empty' })
})

// ---- the service hands the trimmed body to the tuner ----
test('tuneTodo passes the trimmed body to the tuner and applies the limit to it', async () => {
  const seen = []
  const queue = quiet({ tuner: { tune: async (text) => { seen.push(text); return { ok: true, text: 'T' } } } })
  assert.deepEqual(await queue.tuneTodo('  \n rough idea \n '), { ok: true, text: 'T' })
  assert.deepEqual(seen, ['rough idea'])
  assert.equal((await queue.tuneTodo(' '.repeat(50) + 'x'.repeat(4000) + ' '.repeat(50))).ok, true, 'padding does not count towards the limit')
  assert.deepEqual(seen.at(-1), 'x'.repeat(4000))
  assert.deepEqual(await queue.tuneTodo(' x' + 'y'.repeat(4000)), { ok: false, error: 'too-long' })
  assert.equal(seen.length, 2)
})

// ---- one tune at a time ----
test('a second tune while one runs is busy; the flag is cleared when the first ends, fails or throws', async () => {
  let release
  let mode = 'wait'
  const queue = quiet({ tuner: { tune: (text) => (mode === 'throw' ? Promise.reject(new Error('boom')) : mode === 'fail' ? Promise.resolve({ ok: false, error: 'the model returned nothing' }) : new Promise((r) => { release = () => r({ ok: true, text: 'T:' + text }) })) } })
  const first = queue.tuneTodo('one')
  assert.deepEqual(await queue.tuneTodo('two'), { ok: false, error: 'busy' })
  release()
  assert.deepEqual(await first, { ok: true, text: 'T:one' })
  mode = 'throw'
  assert.deepEqual(await queue.tuneTodo('three'), { ok: false, error: 'LLM error' })
  mode = 'fail'
  assert.deepEqual(await queue.tuneTodo('four'), { ok: false, error: 'the model returned nothing' })
  mode = 'wait'
  const fifth = queue.tuneTodo('five')
  release()
  assert.equal((await fifth).ok, true)
})

test('invalid input is never busy, and a busy answer is the existing conflict (409) over HTTP', async (t) => {
  let release
  const queue = quiet({ tuner: { tune: () => new Promise((r) => { release = () => r({ ok: true, text: 'T' }) }) } })
  const server = createServer(createRouter({ queue }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const post = async (text) => { const r = await fetch('http://127.0.0.1:' + server.address().port + '/v1/todo-tune', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); return [r.status, await r.json()] }
  const first = queue.tuneTodo('one')
  assert.deepEqual(await post('two'), [409, { ok: false, error: 'busy' }])
  assert.deepEqual(await post(' '), [400, { ok: false, error: 'empty' }])
  release()
  await first
})
