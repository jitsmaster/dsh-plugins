import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTE_NO_FIT, NOTE_NO_MODEL, NOTE_UNUSABLE, createModelRun, noteOf } from '../summary.js'

// createModelRun: the one pass of a cheap-model question that the workspace suggester (todo.js) and the session suggester (todo-follow-up.js) share:
// the model is picked once and remembered, a failed pick is forgotten, the call is cut off at a deadline (and aborted), and a failure becomes a short note. Never throws.

const llmWith = (over = {}) => {
  const calls = { providers: 0 }
  return {
    calls,
    listProviders: async () => { calls.providers++; return [{ id: 'p' }] },
    listModels: async () => [{ id: 'claude-haiku-4-5', name: 'Haiku' }],
    ...over,
  }
}

test('the note texts are fixed strings', () => {
  assert.deepEqual([NOTE_NO_MODEL, NOTE_NO_FIT, NOTE_UNUSABLE], ['no model available', 'the model found no clear fit', 'the model answered something unusable'])
})

test('the question gets the picked model, an abort signal and a trace; the result carries what the model said (raw)', async () => {
  const run = createModelRun({ llm: llmWith(), timeoutMs: 500 })
  let seen
  const out = await run(async ({ model, signal, trace }) => { seen = { model, signal }; trace.raw += 'abc'; return { suggested: 1 } })
  assert.deepEqual(out, { suggested: 1, raw: 'abc' })
  assert.deepEqual(seen.model, { provider: 'p', model: 'claude-haiku-4-5', name: 'claude-haiku-4-5 Haiku' })
  assert.ok(seen.signal instanceof AbortSignal)
  assert.equal(seen.signal.aborted, false, 'not aborted after an answer')
})

test('the model is picked once and remembered by the next question', async () => {
  const llm = llmWith()
  const run = createModelRun({ llm, timeoutMs: 500 })
  await run(async () => ({}))
  await run(async () => ({}))
  assert.equal(llm.calls.providers, 1)
})

test('a failed pick is forgotten: the next question picks again; the note says why', async () => {
  let n = 0
  const llm = llmWith({ listProviders: async () => { n++; if (n === 1) throw new Error('boom'); return [{ id: 'p' }] } })
  const run = createModelRun({ llm, timeoutMs: 500 })
  assert.deepEqual(await run(async () => ({ suggested: 1 })), { note: 'LLM error: boom', raw: '' })
  assert.deepEqual(await run(async () => ({ suggested: 2 })), { suggested: 2, raw: '' })
  assert.equal(n, 2)
})

test('no llm service, or no model in it: the note is "no model available" (and an empty pick is not remembered)', async () => {
  assert.deepEqual(await createModelRun({ llm: undefined, timeoutMs: 500 })(async () => ({ suggested: 1 })), { note: NOTE_NO_MODEL, raw: '' })
  let n = 0
  const llm = llmWith({ listModels: async () => (++n === 1 ? [] : [{ id: 'claude-haiku-4-5' }]) })
  const run = createModelRun({ llm, timeoutMs: 500 })
  assert.deepEqual(await run(async () => ({ suggested: 1 })), { note: NOTE_NO_MODEL, raw: '' })
  assert.equal((await run(async () => ({ suggested: 2 }))).suggested, 2)
})

test('a question that does not answer in time ends with a timeout note and its signal is aborted; what was said so far is kept', async () => {
  const run = createModelRun({ llm: llmWith(), timeoutMs: 40 })
  let signal
  const out = await run(({ signal: s, trace }) => { signal = s; trace.raw += 'half'; return new Promise(() => {}) })
  assert.deepEqual(out, { note: 'timed out after 40 ms', raw: 'half' })
  assert.equal(signal.aborted, true)
})

test('a question that throws gives a note of at most 80 characters of its message, one line, and aborts its signal', async () => {
  const run = createModelRun({ llm: llmWith(), timeoutMs: 500 })
  let signal
  const out = await run(async ({ signal: s }) => { signal = s; throw new Error('bad\n' + 'x'.repeat(200)) })
  assert.equal(out.note, 'LLM error: bad ' + 'x'.repeat(76))
  assert.equal(signal.aborted, true)
})

test('noteOf: the timeout in seconds from one second on, no model, an LLM error', () => {
  assert.equal(noteOf(new Error('timed out'), 30000), 'timed out after 30 s')
  assert.equal(noteOf(new Error('timed out'), 40), 'timed out after 40 ms')
  assert.equal(noteOf(new Error('no LLM service'), 1), NOTE_NO_MODEL)
  assert.equal(noteOf(new Error(NOTE_NO_MODEL), 1), NOTE_NO_MODEL)
  assert.equal(noteOf('plain', 1), 'LLM error: plain')
})
