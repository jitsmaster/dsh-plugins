import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSummarizer } from '../summary.js'

function fakeLlm({ models = [{ id: 'big-model' }, { id: 'claude-haiku-x' }], reply = 'Moved auth out. Tests pass.', fail, hang, seen = {} } = {}) {
  return {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => models,
    prepareCall: async (cfg) => {
      seen.cfg = cfg
      return {
        config: {},
        stream: async function* (req) {
          seen.req = req
          if (hang) await new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted'))))
          if (fail) throw new Error('llm down')
          yield { type: 'text-delta', text: reply.slice(0, 5) }
          yield { type: 'text-delta', text: reply.slice(5) }
        },
      }
    },
  }
}

test('uses the cheapest-looking model (haiku first) and returns the cleaned summary', async () => {
  const seen = {}
  const s = createSummarizer({ llm: fakeLlm({ seen }) })
  const r = await s.summarize('I did a lot.\n\nFinal paragraph.')
  assert.equal(r.source, 'llm')
  assert.equal(r.text, 'Moved auth out. Tests pass.')
  assert.equal(seen.cfg.model, 'claude-haiku-x')
})

test('the reply is passed as untrusted data and capped to its tail', async () => {
  const seen = {}
  const s = createSummarizer({ llm: fakeLlm({ seen }), maxInputChars: 100 })
  await s.summarize('A'.repeat(500) + 'TAIL')
  const text = seen.req.messages[0].content[0].text
  assert.ok(text.endsWith('TAIL') || text.includes('TAIL'))
  assert.ok(text.length < 600)
  assert.match(seen.req.system, /untrusted/i)
})

test('falls back to the last paragraph when the model fails', async () => {
  const s = createSummarizer({ llm: fakeLlm({ fail: true }) })
  const r = await s.summarize('First.\n\nLast **para**.')
  assert.deepEqual({ text: r.text, source: r.source }, { text: 'Last para.', source: 'fallback' })
})

test('falls back on timeout and aborts the model call', async () => {
  const s = createSummarizer({ llm: fakeLlm({ hang: true }), timeoutMs: 20 })
  const r = await s.summarize('x\n\nfinal bit')
  assert.equal(r.source, 'fallback')
  assert.equal(r.text, 'final bit')
})

test('falls back with no llm service, no models, or an empty answer', async () => {
  assert.equal((await createSummarizer({}).summarize('a\n\nb')).text, 'b')
  assert.equal((await createSummarizer({ llm: fakeLlm({ models: [] }) }).summarize('a\n\nb')).source, 'fallback')
  assert.equal((await createSummarizer({ llm: fakeLlm({ reply: '  \u200B ' }) }).summarize('a\n\nb')).source, 'fallback')
})

test('an empty reply needs no model call', async () => {
  const seen = {}
  const r = await createSummarizer({ llm: fakeLlm({ seen }) }).summarize('   ')
  assert.equal(r.text, '')
  assert.equal(seen.cfg, undefined)
})

test('a caller abort stops the work and gives the fallback', async () => {
  const ac = new AbortController()
  const s = createSummarizer({ llm: fakeLlm({ hang: true }), timeoutMs: 5000 })
  const p = s.summarize('x\n\nend', { signal: ac.signal })
  ac.abort()
  assert.equal((await p).source, 'fallback')
})

test('the model pick is cached between summaries', async () => {
  let listed = 0
  const llm = fakeLlm()
  const orig = llm.listProviders
  llm.listProviders = async () => { listed++; return orig() }
  const s = createSummarizer({ llm })
  await s.summarize('a'); await s.summarize('b')
  assert.equal(listed, 1)
})
