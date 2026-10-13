// Spec: docs/voice-two-stage-flow.md §2 (voice/decider.js) and §4 (decider prompt).
// Shapes chosen where the spec is open (implementer: follow these):
// - llm is DSH's LLM service shape (listProviders / listModels / prepareCall(config, signal) -> { config, stream(options) }),
//   same as the old llm-router; config passed to prepareCall = { provider, model, maxTokens }.
// - The user message is ONE text part whose text is JSON:
//     { utterance, history, sessions: [{ handle, title, selected, lastAlerted, pending }], slash }
//   pending is null when the context entry has none; slash is capped at the first 30 entries; target is NOT sent.
// - The timeout uses the global setTimeout (node:test mock timers drive it) and aborts the AbortSignal passed to stream().
// - Any failure to call the model (no llm, no model, listProviders/prepareCall/stream throws) -> { ok:false, error:'llm' }.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createDecider } from '../voice/decider.js'

function fakeLlm(reply, { models } = {}) {
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'claude', name: 'Claude' }, { id: 'other', name: 'Other' }],
    listModels: async (p) => models?.[p] ?? (p === 'claude'
      ? [{ provider: 'claude', id: 'claude-sonnet-5-5', name: 'Sonnet' }, { provider: 'claude', id: 'claude-haiku-4-5', name: 'Haiku 4.5' }]
      : [{ provider: 'other', id: 'big', name: 'Big' }]),
    prepareCall: async (config) => ({
      config: { ...config },
      stream: async function* (options) {
        calls.push({ config, options })
        const text = typeof reply === 'function' ? reply(options) : reply
        yield { type: 'text-delta', index: 0, text: text.slice(0, 7) }
        yield { type: 'text-delta', index: 0, text: text.slice(7) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
}

const CTX = () => ({
  sessions: [
    { handle: 's1', title: 'Voice Work', selected: true, lastAlerted: false },
    { handle: 's2', title: 'PR 6524', selected: false, lastAlerted: true, pending: 'permission: run command' },
  ],
  slash: [{ name: 'compact', description: 'Compact the conversation' }],
  target: 'a',
})
const HISTORY = [{ utterance: 'stop it', question: 'Voice Work or PR 6524?' }]
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

test('D1 prefers a Haiku model and sends the utterance, history, session handles, pending and slash list as JSON', async () => {
  const llm = fakeLlm('{"action":"cancel","session":"s2"}')
  const decider = createDecider({ llm, context: CTX })
  await decider.decide('stop the PR one', { history: HISTORY })
  assert.equal(llm.calls.length, 1)
  const { config, options } = llm.calls[0]
  assert.equal(config.provider, 'claude')
  assert.equal(config.model, 'claude-haiku-4-5')
  // default must cover MAX_TEXT (4000 chars, voice/actions.js) echoed back in the JSON reply, or parseReply gets a truncated reply
  assert.equal(config.maxTokens, 1500)
  assert.match(options.system, /Reply with ONE line of JSON, no prose\./)
  for (const name of ['switch', 'prompt', 'new', 'approve', 'deny', 'cancel', 'slash', 'clarify']) assert.match(options.system, new RegExp('"' + name + '"'), name)
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].role, 'user')
  assert.deepEqual(JSON.parse(options.messages[0].content[0].text), {
    utterance: 'stop the PR one',
    history: HISTORY,
    sessions: [
      { handle: 's1', title: 'Voice Work', selected: true, lastAlerted: false, pending: null },
      { handle: 's2', title: 'PR 6524', selected: false, lastAlerted: true, pending: 'permission: run command' },
    ],
    slash: [{ name: 'compact', description: 'Compact the conversation' }],
  })
})

test('D1 the slash list sent to the model is capped at 30 entries', async () => {
  const llm = fakeLlm('{"action":"cancel"}')
  const slash = Array.from({ length: 35 }, (_, i) => ({ name: 'cmd' + i, description: 'd' + i }))
  await createDecider({ llm, context: () => ({ ...CTX(), slash }) }).decide('x', { history: [] })
  assert.deepEqual(JSON.parse(llm.calls[0].options.messages[0].content[0].text).slash, slash.slice(0, 30))
})

test('D2 JSON wrapped in prose or a code fence is parsed into raw', async () => {
  const decider = createDecider({ llm: fakeLlm('Sure!\n```json\n{"action":"cancel","session":"s2"}\n```'), context: CTX })
  assert.deepEqual(await decider.decide('stop the PR one', { history: [] }), { ok: true, raw: { action: 'cancel', session: 's2' }, model: 'claude-haiku-4-5' })
})

test('D3 a reply without parseable JSON is unparseable', async () => {
  for (const reply of ['no idea', '{not json}', '"just a string"']) {
    const decider = createDecider({ llm: fakeLlm(reply), context: CTX })
    assert.deepEqual(await decider.decide('x', { history: [] }), { ok: false, error: 'unparseable', model: 'claude-haiku-4-5' }, reply)
  }
})

test('D4 a hung model resolves timeout exactly at timeoutMs (default 8000) and aborts the call signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let streamSignal
  const hung = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ provider: 'p', id: 'm' }],
    prepareCall: async () => ({
      config: {},
      stream: (o) => (async function* () {
        streamSignal = o.signal
        await new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))))
      })(),
    }),
  }
  let settled
  const p = createDecider({ llm: hung, context: CTX }).decide('x', { history: [] }).then((r) => { settled = r; return r })
  await flush()
  t.mock.timers.tick(7999)
  await flush()
  assert.equal(settled, undefined)
  t.mock.timers.tick(1)
  await flush()
  assert.deepEqual(await p, { ok: false, error: 'timeout' })
  assert.equal(streamSignal.aborted, true)
})

test('D4 a custom timeoutMs is honoured', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const hung = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ provider: 'p', id: 'm' }],
    prepareCall: async () => ({ config: {}, stream: (o) => (async function* () { await new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) })() }),
  }
  let settled
  const p = createDecider({ llm: hung, context: CTX, timeoutMs: 2000 }).decide('x', { history: [] }).then((r) => { settled = r; return r })
  await flush()
  t.mock.timers.tick(1999)
  await flush()
  assert.equal(settled, undefined)
  t.mock.timers.tick(1)
  await flush()
  assert.deepEqual(await p, { ok: false, error: 'timeout' })
})

test('D5 a failing call, no model, a throwing provider list or no llm at all is llm', async () => {
  const base = { listProviders: () => [{ id: 'p' }], listModels: async () => [{ provider: 'p', id: 'm' }] }
  const cases = {
    'prepareCall throws': { ...base, prepareCall: async () => { throw new Error('offline') } },
    'stream throws': { ...base, prepareCall: async () => ({ config: {}, stream: () => (async function* () { throw new Error('500') })() }) },
    'no model': { listProviders: () => [{ id: 'p' }], listModels: async () => [], prepareCall: async () => { throw new Error('unreachable') } },
    'listProviders throws': { listProviders: () => { throw new Error('down') }, listModels: async () => [] },
    'no llm': undefined,
  }
  for (const [name, llm] of Object.entries(cases)) {
    assert.deepEqual(await createDecider({ llm, context: CTX }).decide('x', { history: [] }), { ok: false, error: 'llm' }, name)
  }
})

test('D6 no backoff: the call right after a failure really calls the model again', async () => {
  let attempts = 0
  const good = fakeLlm('{"action":"cancel"}')
  const llm = {
    ...good,
    prepareCall: async (config, signal) => { attempts++; if (attempts === 1) throw new Error('offline'); return good.prepareCall(config, signal) },
  }
  const decider = createDecider({ llm, context: CTX, now: () => 1000 })
  assert.deepEqual(await decider.decide('stop it', { history: [] }), { ok: false, error: 'llm' })
  assert.deepEqual(await decider.decide('stop it', { history: [] }), { ok: true, raw: { action: 'cancel' }, model: 'claude-haiku-4-5' })
  assert.equal(attempts, 2)
})
