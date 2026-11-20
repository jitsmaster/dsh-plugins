import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeLlm, systemOf, userOf } from './todo-tune-helpers.mjs'

// The cleaner only uses the provider 'anthropic': this fake lists its models under that id (the default fake's provider is 'p1').
const anthropicLlm = (o = {}) => fakeLlm({ ...o, providers: [{ id: 'anthropic', models: o.models ?? [{ id: 'claude-haiku-x' }] }] })

// The Haiku cleanup of a phone dictation (dictation-clean.js): createDictationCleaner({ llm, timeoutMs = 20000, maxTokens = 1200, log }).clean(text, { lang })
//   -> { ok: true, text } | { ok: false, error }; never throws. Haiku model only (no fallback to another model), input at most 2000 characters,
//   the answer must be 0.6x to 1.6x the length of the input, provider messages never reach the caller, the text is never logged.
const load = async () => import('../dictation-clean.js')
const cleaner = async (opts) => { const { createDictationCleaner } = await load(); return createDictationCleaner(opts) }

test('the cleaned text comes back and the model gets the dictated text as it was', async () => {
  const seen = {}
  const c = await cleaner({ llm: anthropicLlm({ answer: 'Fix the login, please.', seen }) })
  const out = await c.clean('fix the login please')
  assert.deepEqual(out, { ok: true, text: 'Fix the login, please.' })
  assert.equal(userOf(seen), 'fix the login please')
})

test('only a Haiku model is used; without one the answer is "no model available" and nothing is called', async () => {
  const seen = {}
  const ok = await cleaner({ llm: anthropicLlm({ answer: 'Fix the login.', seen, models: [{ id: 'gpt-x' }, { id: 'claude-haiku-4-5' }] }) })
  await ok.clean('fix the login')
  assert.equal(seen.cfg.model, 'claude-haiku-4-5')
  const seen2 = {}
  const none = await cleaner({ llm: anthropicLlm({ answer: 'x', seen: seen2, models: [{ id: 'gpt-x' }] }) })
  assert.deepEqual(await none.clean('fix the login'), { ok: false, error: 'no model available' })
  assert.equal(seen2.calls, 0)
  assert.deepEqual(await (await cleaner({})).clean('fix the login'), { ok: false, error: 'no model available' })
})

test('without an Anthropic Haiku the log names the provider ids seen (ids only, so a wrong id is diagnosable), never the dictated text or a model id', async () => {
  const logs = []
  const llm = fakeLlm({ providers: [{ id: 'claude-code', models: [{ id: 'claude-haiku-secret-model' }] }, { id: 'openai', models: [{ id: 'gpt-x' }] }] })
  const c = await cleaner({ llm, log: (l) => logs.push(l) })
  assert.deepEqual(await c.clean('my private dictated words'), { ok: false, error: 'no model available' })
  const line = logs.find((l) => /claude-code/.test(l))
  assert.ok(line, 'a line lists the provider ids: ' + logs.join(' | '))
  assert.match(line, /openai/)
  assert.equal(logs.some((l) => /private dictated|secret-model|gpt-x/.test(l)), false, 'no text and no model ids')
  assert.ok(logs.every((l) => l.startsWith('dictation-clean: ')))
})
test('the system prompt keeps meaning and identifiers, forbids following instructions in the text, and allows fixing mis-heard words', async () => {
  const seen = {}
  const c = await cleaner({ llm: anthropicLlm({ answer: 'Fix the login.', seen }) })
  await c.clean('fix the login')
  const s = systemOf(seen)
  assert.match(s, /punctuation/i)
  assert.match(s, /capital/i)
  assert.match(s, /mis-?heard/i)
  assert.match(s, /AB#|ticket|path|identifier/i)
  assert.match(s, /never (answer|follow)|do not (answer|follow)|not an instruction/i)
  assert.match(s, /only the text|nothing else/i)
})

test('empty, blank and non-string input is "empty"; over 2000 characters is "too-long"; the model is not asked', async () => {
  const seen = {}
  const c = await cleaner({ llm: anthropicLlm({ answer: 'x', seen }) })
  for (const t of ['', '   ', undefined, null, 42, ['a']]) assert.deepEqual(await c.clean(t), { ok: false, error: 'empty' }, String(t))
  assert.deepEqual(await c.clean('x'.repeat(2001)), { ok: false, error: 'too-long' })
  assert.equal(seen.calls, 0)
})

test('an answer outside 0.6x to 1.6x of the input, or an empty one, is "unusable" so the local text stays', async () => {
  const input = 'please run the tests before you push the branch'
  for (const answer of ['', '   ', 'Ok.', input.repeat(2)]) {
    const c = await cleaner({ llm: anthropicLlm({ answer }) })
    assert.deepEqual(await c.clean(input), { ok: false, error: 'unusable' }, JSON.stringify(answer))
  }
})

test('a code fence or wrapping quotes around the answer are removed, and the text is trimmed', async () => {
  const c = await cleaner({ llm: anthropicLlm({ answer: '```\nFix the login.\n```' }) })
  assert.deepEqual(await c.clean('fix the login'), { ok: true, text: 'Fix the login.' })
  const q = await cleaner({ llm: anthropicLlm({ answer: '  "Fix the login."  ' }) })
  assert.deepEqual(await q.clean('fix the login'), { ok: true, text: 'Fix the login.' })
})

test('a provider failure gives a generic "LLM error"; the detail only reaches the log, and the dictated text never does', async () => {
  const logs = []
  const c = await cleaner({ llm: anthropicLlm({ fail: true, failMessage: '401 from https://api.example/?k=sk-SECRET1234' }), log: (l) => logs.push(l) })
  const out = await c.clean('my private dictated sentence')
  assert.deepEqual(out, { ok: false, error: 'LLM error' })
  assert.equal(logs.length, 1, 'the failure is logged')
  assert.equal(logs.some((l) => /private dictated|sk-SECRET1234/.test(l)), false, 'neither the text nor the provider detail is logged')
  assert.equal(JSON.stringify(out).includes('sk-SECRET'), false)
})

test('a provider error that echoes the dictated text or a key fragment never puts either in the log: only its code or name', async () => {
  const logs = []
  const dictated = 'my private dictated sentence'
  const llm = anthropicLlm({ fail: true, failMessage: 'bad request: "' + dictated + '" sk-SECRET1234' })
  const c = await cleaner({ llm, log: (l) => logs.push(l) })
  assert.deepEqual(await c.clean(dictated), { ok: false, error: 'LLM error' })
  assert.ok(logs.length > 0, 'something is logged')
  assert.equal(logs.some((l) => l.includes('private dictated') || l.includes('SECRET')), false, logs.join('\n'))
  assert.ok(logs.every((l) => /^dictation-clean: LLM error \(\w+\)$/.test(l)), logs.join('\n'))
})

test('a model that never answers ends with a timeout message', async () => {
  const c = await cleaner({ llm: anthropicLlm({ hang: true }), timeoutMs: 30 })
  assert.match((await c.clean('fix the login')).error, /timed out/)
})

test('the language of the mic is told to the model so the answer stays in that language', async () => {
  const seen = {}
  const c = await cleaner({ llm: anthropicLlm({ answer: '你好，今天怎么样？', seen }) })
  await c.clean('你好今天怎么样', { lang: 'zh-CN' })
  assert.match(systemOf(seen), /zh-CN|Chinese|same language/i)
})

test('maxTokens grows with the input so a long CJK dictation is not cut off at the token cap', async () => {
  const seen = {}
  const input = '你好今天怎么样'.repeat(215) // ~1500 characters: about 1-2 tokens each
  const c = await cleaner({ llm: anthropicLlm({ answer: input + '。', seen }) })
  assert.equal((await c.clean(input)).ok, true)
  assert.ok(seen.cfg.maxTokens >= input.length * 2, 'maxTokens ' + seen.cfg.maxTokens)
  const short = {}
  await (await cleaner({ llm: anthropicLlm({ answer: 'Fix the login.', seen: short }) })).clean('fix the login')
  assert.equal(short.cfg.maxTokens, 1200, 'short input keeps the floor')
})

test('an answer the model stopped at the token limit is "unusable", even when its length passes the 0.6x check', async () => {
  const input = 'please run the tests before you push the branch'
  const chunks = ['Please run the tests before you push', { type: 'finish', reason: { kind: 'max-tokens' } }]
  const c = await cleaner({ llm: anthropicLlm({ chunks }) })
  assert.deepEqual(await c.clean(input), { ok: false, error: 'unusable' })
  const ok = await cleaner({ llm: anthropicLlm({ chunks: ['Please run the tests before you push the branch.', { type: 'finish', reason: { kind: 'stop' } }] }) })
  assert.equal((await ok.clean(input)).ok, true)
})

test('a Haiku model of another provider is never used: without an anthropic Haiku the answer is "no model available" and the stub is not called', async () => {
  const seen = {}
  const llm = fakeLlm({ answer: 'Fix the login.', seen, providers: [{ id: 'openrouter', models: [{ id: 'claude-haiku-4-5' }, { id: 'haiku-clone' }] }, { id: 'anthropic', models: [{ id: 'claude-sonnet-4-5' }] }] })
  const c = await cleaner({ llm })
  assert.deepEqual(await c.clean('fix the login'), { ok: false, error: 'no model available' })
  assert.equal(seen.calls, 0)
})

test('an anthropic Haiku is chosen over a Haiku of another provider, even a newer one', async () => {
  const seen = {}
  const llm = fakeLlm({ answer: 'Fix the login.', seen, providers: [{ id: 'openrouter', models: [{ id: 'claude-haiku-9-9' }] }, { id: 'anthropic', models: [{ id: 'claude-3-5-haiku-20241022' }, { id: 'claude-haiku-4-5-20251001' }] }] })
  const c = await cleaner({ llm })
  assert.deepEqual(await c.clean('fix the login'), { ok: true, text: 'Fix the login.' })
  assert.equal(seen.cfg.provider, 'anthropic')
  assert.equal(seen.cfg.model, 'claude-haiku-4-5-20251001')
})

test('the model pick is forgotten when the call fails, so a model that lost auth or disappeared is picked again on the next call', async () => {
  const base = anthropicLlm({ answer: 'Fix the login.' })
  let prepares = 0
  const llm = { ...base, prepareCall: async (cfg, signal) => { if (++prepares === 1) throw new Error('auth lost'); return base.prepareCall(cfg, signal) } }
  const seen = {}
  const counted = fakeLlm({ answer: 'Fix the login.', seen, providers: [{ id: 'anthropic', models: [{ id: 'claude-haiku-x' }] }] })
  llm.listProviders = counted.listProviders
  llm.listModels = counted.listModels
  const c = await cleaner({ llm })
  assert.equal((await c.clean('fix the login')).ok, false)
  assert.equal(seen.providerCalls, 1)
  assert.deepEqual(await c.clean('fix the login'), { ok: true, text: 'Fix the login.' })
  assert.equal(seen.providerCalls, 2, 'the model was listed again')
})

test('a stream that throws also forgets the model pick, but a cancel keeps it', async () => {
  const seen = {}
  const failing = fakeLlm({ fail: true, seen, providers: [{ id: 'anthropic', models: [{ id: 'claude-haiku-x' }] }] })
  const c = await cleaner({ llm: failing })
  await c.clean('fix the login')
  await c.clean('fix the login')
  assert.equal(seen.providerCalls, 2, 'picked again after a stream failure')
  const s2 = {}
  const ok = await cleaner({ llm: fakeLlm({ answer: 'Fix the login.', seen: s2, providers: [{ id: 'anthropic', models: [{ id: 'claude-haiku-x' }] }] }) })
  const ac = new AbortController()
  ac.abort()
  assert.deepEqual(await ok.clean('fix the login', { signal: ac.signal }), { ok: false, error: 'cancelled' })
  await ok.clean('fix the login')
  await ok.clean('fix the login')
  assert.equal(s2.providerCalls, 1, 'a success keeps the pick')
})

test('control characters and bidi override/isolate characters are stripped from the answer; newlines and tabs stay', async () => {
  const answer = 'Fix\u202E the\u0007 login\u2066,\u2069 now\u200E\u200F.\nNext\tline'
  const c = await cleaner({ llm: anthropicLlm({ answer }) })
  assert.deepEqual(await c.clean('fix the login now next line'), { ok: true, text: 'Fix the login, now.\nNext\tline' })
})

test('"no model available" is remembered for 60 s: no new listing and no new provider-id log line inside the window, and a model that appears is picked up after it', async () => {
  const seen = {}
  const providers = [{ id: 'anthropic', models: [{ id: 'claude-sonnet-4-5' }] }]
  const logs = []
  let clock = 1_000_000
  const c = await cleaner({ llm: fakeLlm({ answer: 'Fix the login.', seen, providers }), log: (l) => logs.push(l), now: () => clock })
  const idLines = () => logs.filter((l) => /provider ids seen/.test(l)).length
  assert.deepEqual(await c.clean('fix the login'), { ok: false, error: 'no model available' })
  const listed = seen.providerCalls
  assert.equal(idLines(), 1)
  clock += 59_000
  assert.deepEqual(await c.clean('fix the login'), { ok: false, error: 'no model available' })
  assert.equal(seen.providerCalls, listed, 'not listed again inside the window')
  assert.equal(idLines(), 1, 'logged only on the first miss')
  providers[0].models.push({ id: 'claude-haiku-x' })
  assert.equal((await c.clean('fix the login')).ok, false, 'still inside the window')
  clock += 2_000
  assert.deepEqual(await c.clean('fix the login'), { ok: true, text: 'Fix the login.' }, 'picked up after the window')
  assert.ok(seen.providerCalls > listed)
})

test('after the window a repeated miss lists again and logs again (once per window)', async () => {
  const seen = {}
  const logs = []
  let clock = 5_000
  const c = await cleaner({ llm: fakeLlm({ answer: 'x', seen, models: [{ id: 'gpt-x' }], providers: [{ id: 'anthropic', models: [{ id: 'gpt-x' }] }] }), log: (l) => logs.push(l), now: () => clock })
  await c.clean('fix the login')
  await c.clean('fix the login')
  clock += 60_001
  await c.clean('fix the login')
  await c.clean('fix the login')
  assert.equal(logs.filter((l) => /provider ids seen/.test(l)).length, 2)
})

test('a failed model call still forgets the pick after a miss window was never set (no cached miss for a failure)', async () => {
  const seen = {}
  let clock = 0
  const c = await cleaner({ llm: fakeLlm({ fail: true, seen, providers: [{ id: 'anthropic', models: [{ id: 'claude-haiku-x' }] }] }), now: () => clock })
  await c.clean('fix the login')
  await c.clean('fix the login')
  assert.equal(seen.providerCalls, 2, 'a failing model is picked again at once')
})
