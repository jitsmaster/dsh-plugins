import assert from 'node:assert/strict'
import test from 'node:test'
import { createLlmRouter } from '../voice/llm-router.js'

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
const SESSIONS = [{ id: 'a', title: 'Voice Work' }, { id: 'b', title: 'PR 6524' }]
const ask = (router, text) => router.route(text, { sessions: SESSIONS })

test('prefers a Haiku model and calls it with the transcript and the session titles', async () => {
  const llm = fakeLlm('{"id":"cancel"}')
  const router = createLlmRouter({ llm })
  await ask(router, 'hey could you stop that one please')
  assert.equal(llm.calls[0].config.provider, 'claude')
  assert.equal(llm.calls[0].config.model, 'claude-haiku-4-5')
  const user = JSON.stringify(llm.calls[0].options.messages)
  assert.match(user, /could you stop that one please/)
  assert.match(user, /Voice Work/)
  assert.match(user, /PR 6524/)
  assert.match(llm.calls[0].options.system, /cancel/)
})

test('a command reply becomes a match with viaLlm set', async () => {
  const router = createLlmRouter({ llm: fakeLlm('{"id":"cancel","target":"pr 6524"}') })
  const r = await ask(router, 'stop the PR session')
  assert.equal(r.id, 'cancel')
  assert.equal(r.target, 'pr 6524')
  assert.equal(r.viaLlm, true)
})

test('arguments are validated through makeMatch', async () => {
  const router = createLlmRouter({ llm: fakeLlm('{"id":"goal","text":"ship the voice client"}') })
  assert.equal((await ask(router, 'make the goal shipping the voice client')).args.text, 'ship the voice client')
  const bad = createLlmRouter({ llm: fakeLlm('{"id":"goal"}') })
  assert.deepEqual(await ask(bad, 'set a goal'), { kind: 'dictation' })
})

test('dictation, unknown ids and prose around the JSON are handled', async () => {
  assert.deepEqual(await ask(createLlmRouter({ llm: fakeLlm('{"id":"dictation"}') }), 'refactor the parser'), { kind: 'dictation' })
  assert.deepEqual(await ask(createLlmRouter({ llm: fakeLlm('{"id":"rm-rf"}') }), 'x'), { kind: 'dictation' })
  const wrapped = createLlmRouter({ llm: fakeLlm('Sure!\n```json\n{"id":"approve"}\n```') })
  assert.equal((await ask(wrapped, 'yes go ahead and approve it')).id, 'approve')
})

test('unparseable output, a failing call and a missing llm all report undefined (never a guess)', async () => {
  assert.equal(await ask(createLlmRouter({ llm: fakeLlm('no idea') }), 'x'), undefined)
  const broken = { listProviders: () => [{ id: 'p' }], listModels: async () => [{ provider: 'p', id: 'm' }], prepareCall: async () => { throw new Error('offline') } }
  const logs = []
  assert.equal(await ask(createLlmRouter({ llm: broken, log: (l) => logs.push(l) }), 'x'), undefined)
  assert.ok(logs.some((l) => /offline/.test(l)))
  assert.equal(await ask(createLlmRouter({ llm: undefined }), 'x'), undefined)
})

test('with no Haiku, it falls back to another small model, then to the first model', async () => {
  const flash = fakeLlm('{"id":"dictation"}', { models: { claude: [{ provider: 'claude', id: 'big-1' }], other: [{ provider: 'other', id: 'gpt-mini' }] } })
  await ask(createLlmRouter({ llm: flash }), 'x')
  assert.equal(flash.calls[0].config.model, 'gpt-mini')
  const plain = fakeLlm('{"id":"dictation"}', { models: { claude: [{ provider: 'claude', id: 'big-1' }], other: [{ provider: 'other', id: 'big-2' }] } })
  await ask(createLlmRouter({ llm: plain }), 'x')
  assert.equal(plain.calls[0].config.model, 'big-1')
})

test('an explicit provider/model override wins and the model choice is cached', async () => {
  const llm = fakeLlm('{"id":"dictation"}')
  const router = createLlmRouter({ llm, model: { provider: 'other', model: 'big' } })
  await ask(router, 'a'); await ask(router, 'b')
  assert.equal(llm.calls[0].config.model, 'big')
  assert.equal(llm.calls.length, 2)
})

test('the call has a deadline: a hung model resolves to undefined', async () => {
  const hung = { listProviders: () => [{ id: 'p' }], listModels: async () => [{ provider: 'p', id: 'm' }], prepareCall: async () => ({ config: {}, stream: (o) => (async function* () { await new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) })() }) }
  assert.equal(await ask(createLlmRouter({ llm: hung, timeoutMs: 30 }), 'x'), undefined)
})

test('after a failure the router backs off instead of waiting for the timeout on every utterance', async () => {
  let t = 1000
  let attempts = 0
  const llm = { listProviders: () => { attempts++; throw new Error('down') }, listModels: async () => [] }
  const router = createLlmRouter({ llm, now: () => t, backoffMs: 30000 })
  assert.equal(await ask(router, 'something unmatched'), undefined)
  assert.equal(attempts, 1)
  t += 5000
  assert.equal(await ask(router, 'another unmatched'), undefined)
  assert.equal(attempts, 1)
  t += 30000
  await ask(router, 'third unmatched')
  assert.equal(attempts, 2)
})
