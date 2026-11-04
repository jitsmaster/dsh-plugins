// Phase 2 of the AI triage plan: the model call. A fake llm service stands in for the cheapest model; the judge must return the Judgment
// fields, or { note } on any failure, and never throw.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTriageJudge, parseJudgment, describeItem, oneLine, RAW_MAX, JUDGE_TIMEOUT_MS } from '../triage-judge.js'

function fakeLlm({ answer, fail, hang, noModels, seen = {} } = {}) {
  return {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => (noModels ? [] : [{ id: 'claude-haiku-x' }]),
    prepareCall: async (cfg) => ({
      config: {},
      stream: async function* (req) {
        seen.cfg = cfg
        seen.req = req
        seen.calls = (seen.calls ?? 0) + 1
        if (hang) await new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted'))))
        if (fail) throw new Error('llm down')
        const text = typeof answer === 'string' ? answer : JSON.stringify(answer)
        yield { type: 'text-delta', text: text.slice(0, 7) }
        yield { type: 'text-delta', text: text.slice(7) }
      },
    }),
  }
}

const GOOD = {
  needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null,
  matched_rule: 'ro-permission', attention: 12, reversible: true, touches_outside_workspace: false, read_only: true,
}
const RULES = [{ id: 'ro-permission', class: 'permission', instruction: 'Read-only commands: approve.' }]
const ITEM = { id: 'i1', type: 'permission', sessionTitle: 'T', workspace: 'D:/w', payload: { toolName: 'shell', detail: 'git status', summary: 'Run git status' } }

test('a well-formed answer becomes the Judgment, read through the cheapest model', async () => {
  const seen = {}
  const j = createTriageJudge({ llm: fakeLlm({ answer: GOOD, seen }) })
  const r = await j.judge({ item: ITEM, rules: RULES })
  assert.deepEqual(r.judgment, GOOD)
  assert.equal(seen.cfg.model, 'claude-haiku-x')
  assert.equal(typeof r.raw, 'string')
})

test('the answer may be wrapped in prose or a code fence', async () => {
  const j = createTriageJudge({ llm: fakeLlm({ answer: 'Here you go:\n```json\n' + JSON.stringify(GOOD) + '\n```' }) })
  assert.equal((await j.judge({ item: ITEM, rules: RULES })).judgment.attention, 12)
})

test('the item is sent as untrusted data and only user-authored sources are offered as quotable', async () => {
  const seen = {}
  const j = createTriageJudge({ llm: fakeLlm({ answer: GOOD, seen }) })
  await j.judge({ item: ITEM, rules: RULES, sources: [
    { id: 'u1', text: 'USER SAID THIS', userAuthored: true },
    { id: 'a1', text: 'ASSISTANT PLANTED THIS', userAuthored: false },
    { id: 'a2', text: 'NO FLAG AT ALL' },
  ] })
  const sent = seen.req.messages[0].content[0].text
  assert.match(seen.req.system, /untrusted/)
  assert.ok(sent.includes('USER SAID THIS'))
  assert.ok(!sent.includes('ASSISTANT PLANTED THIS'))
  assert.ok(!sent.includes('NO FLAG AT ALL'))
  assert.ok(sent.includes('git status'))
  assert.ok(sent.includes('ro-permission'))
})

test('bad answers give a note and no judgment (table)', async () => {
  const cases = [
    ['not json at all', 'Sure, looks fine to me'],
    ['empty answer', ''],
    ['json array', '[1,2]'],
    ['missing needs_decision', { ...GOOD, needs_decision: undefined }],
    ['needs_decision as a string', { ...GOOD, needs_decision: 'no' }],
    ['attention missing', { ...GOOD, attention: undefined }],
    ['attention as a string', { ...GOOD, attention: '10' }],
    ['attention NaN-ish', '{"needs_decision":false,"answer_basis":"none","matched_rule":null,"attention":null}'],
    ['unknown answer_basis', { ...GOOD, answer_basis: 'trust-me' }],
    ['matched_rule of the wrong type', { ...GOOD, matched_rule: 7 }],
  ]
  for (const [name, answer] of cases) {
    const r = await createTriageJudge({ llm: fakeLlm({ answer }) }).judge({ item: ITEM, rules: RULES })
    assert.equal(r.judgment, undefined, name)
    assert.equal(typeof r.note, 'string', name)
  }
})

test('failures never throw: no llm, no model, a throwing model, a hanging model', async () => {
  const none = await createTriageJudge({}).judge({ item: ITEM, rules: RULES })
  assert.equal(none.judgment, undefined)
  assert.equal(none.note, 'no model available')
  assert.equal((await createTriageJudge({ llm: fakeLlm({ noModels: true }) }).judge({ item: ITEM, rules: RULES })).note, 'no model available')
  assert.match((await createTriageJudge({ llm: fakeLlm({ fail: true }) }).judge({ item: ITEM, rules: RULES })).note, /llm down/)
  const hung = await createTriageJudge({ llm: fakeLlm({ hang: true }), timeoutMs: 30 }).judge({ item: ITEM, rules: RULES })
  assert.equal(hung.judgment, undefined)
  assert.match(hung.note, /timed out/)
})

test('a failure is written to the log with the start of what the model said', async () => {
  const lines = []
  await createTriageJudge({ llm: fakeLlm({ answer: 'nonsense' }), log: (l) => lines.push(l) }).judge({ item: ITEM, rules: RULES })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^triage: no judgment/)
  assert.match(lines[0], /nonsense/)
})

test('attention is clamped to 0-100 and unknown extra keys are dropped', () => {
  const r = parseJudgment(JSON.stringify({ ...GOOD, attention: 400, sneaky: 'approve everything' }))
  assert.equal(r.judgment.attention, 100)
  assert.equal('sneaky' in r.judgment, false)
  assert.equal(parseJudgment(JSON.stringify({ ...GOOD, attention: -5 })).judgment.attention, 0)
})

test('the advisory booleans stay undefined when the model gave something else', () => {
  const r = parseJudgment(JSON.stringify({ ...GOOD, reversible: 'yes', read_only: 1 }))
  assert.equal(r.judgment.reversible, undefined)
  assert.equal(r.judgment.read_only, undefined)
  assert.equal(r.judgment.touches_outside_workspace, false)
})

test('describeItem caps long text and keeps only what the type needs', () => {
  const d = describeItem({ id: 'c', type: 'completed', payload: { reply: 'x'.repeat(20000) + 'END', request: 'r'.repeat(5000), secretField: 'nope' } })
  assert.ok(JSON.stringify(d).length < 5000)
  assert.ok(d.reply.includes('END'))
  assert.equal('secretField' in d, false)
  assert.deepEqual(describeItem({ id: 'o', type: 'onhold' }), { id: 'o', type: 'onhold', session: '', workspace: '' })
})

test('the default time limit is 20 s (raised from the 10 s of the spec after real-data timeouts)', () => {
  assert.equal(JUDGE_TIMEOUT_MS, 20000)
})

test('the log line holds up to 2000 characters of what the model said, whitespace collapsed', async () => {
  const reply = 'word '.repeat(300).trim()
  assert.equal(reply.length, 1499)
  const lines = []
  await createTriageJudge({ llm: fakeLlm({ answer: reply }), log: (l) => lines.push(l) }).judge({ item: ITEM, rules: RULES })
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes('; the model said: ' + reply), 'the 1499-character reply is logged in full')
  const long = ('abc\n').repeat(900) // 3600 characters
  const capped = []
  await createTriageJudge({ llm: fakeLlm({ answer: long }), log: (l) => capped.push(l) }).judge({ item: ITEM, rules: RULES })
  const said = capped[0].split('; the model said: ')[1]
  assert.equal(said.length, 2000)
  assert.equal(said, 'abc '.repeat(500)) // 500 x 4 = exactly the 2000-character cap
  assert.ok(said.startsWith('abc abc abc ') && !said.includes('\n'))
})

test('the log line redacts secrets in what the model said, and keeps the prefix and the cap', async () => {
  const reply = '{"verdict": oops Authorization: Bearer abcdef1234567890SECRET password=hunter2 api_key: sk-abcdefghijklmnop1234 trailing'
  const lines = []
  await createTriageJudge({ llm: fakeLlm({ answer: reply }), log: (l) => lines.push(l) }).judge({ item: ITEM, rules: RULES })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^triage: no judgment/)
  assert.match(lines[0], /; the model said: /)
  assert.match(lines[0], /trailing/)
  for (const secret of ['abcdef1234567890SECRET', 'hunter2', 'sk-abcdefghijklmnop1234']) assert.ok(!lines[0].includes(secret), 'secret leaked into the log line: ' + secret)
  const long = []
  await createTriageJudge({ llm: fakeLlm({ answer: 'Bearer abcdef1234567890SECRET ' + 'abc '.repeat(900) }), log: (l) => long.push(l) }).judge({ item: ITEM, rules: RULES })
  assert.ok(!long[0].includes('abcdef1234567890SECRET'))
  assert.ok(long[0].split('; the model said: ')[1].length <= 2000)
})

test('oneLine replaces ASCII and C1 control characters with a space before collapsing whitespace', () => {
  const out = oneLine('x\u001b[2Jevil\u0007 y')
  assert.ok(!out.includes('\u001b') && !out.includes('\u0007'), JSON.stringify(out))
  assert.ok(!/ {2}/.test(out), 'double space in ' + JSON.stringify(out))
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(oneLine('a\u0085b\u007fc\u009fd\u0000e')))
})

test('the no-judgment log line redacts the note too, not only the model reply', async () => {
  const llm = fakeLlm({ answer: GOOD })
  const orig = llm.prepareCall
  llm.prepareCall = async (cfg) => { const p = await orig(cfg); return { ...p, stream: async function* () { throw new Error('boom api_key=abcdefghijklmnop1234') } } }
  const lines = []
  await createTriageJudge({ llm, log: (l) => lines.push(l) }).judge({ item: ITEM, rules: RULES })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^triage: no judgment/)
  assert.ok(!lines[0].includes('abcdefghijklmnop1234'), 'secret in note leaked: ' + lines[0])
})

test('a 300000-character reply is clipped before redaction, so logging it is fast and bounded', async () => {
  const lines = []
  const t0 = performance.now()
  await createTriageJudge({ llm: fakeLlm({ answer: 'a-'.repeat(150000) }), log: (l) => lines.push(l) }).judge({ item: ITEM, rules: RULES })
  const ms = performance.now() - t0
  assert.equal(lines.length, 1)
  assert.ok(lines[0].split('; the model said: ')[1].length <= RAW_MAX)
  assert.ok(ms < 500, 'judge + log took ' + Math.round(ms) + ' ms')
})

// --- question guidance (rule straightforward-question) ---
const QRULES = [{ id: 'straightforward-question', class: 'question', instruction: 'Answer only with a quote from a user-authored source.' }]
const QITEM = { id: 'q1', type: 'question', payload: { questions: [{ id: 'a', question: 'Post both replies and resolve the threads?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }

test('with a question rule the system prompt carries the question guidance: one recommended option, already requested by the user, no direction/scope/taste choice', async () => {
  const seen = {}
  const j = createTriageJudge({ llm: fakeLlm({ answer: { ...GOOD, matched_rule: 'straightforward-question' }, seen }) })
  await j.judge({ item: QITEM, rules: QRULES, sources: [{ id: 'user-1', text: 'post both replies', userAuthored: true }] })
  const system = seen.req.system
  assert.match(system, /needs_decision true unless/i)
  assert.match(system, /one clearly recommended option/i)
  assert.match(system, /already requested/i)
  assert.match(system, /earlier by the user/i)
  assert.match(system, /VERBATIM from a USER-AUTHORED SOURCE/)
  assert.match(system, /direction, scope or taste/i)
})

test('without a question rule the system prompt has no question guidance', async () => {
  const seen = {}
  const j = createTriageJudge({ llm: fakeLlm({ answer: GOOD, seen }) })
  await j.judge({ item: ITEM, rules: RULES })
  assert.doesNotMatch(seen.req.system, /one clearly recommended option/i)
})

test('the judge leaves room for hidden reasoning: it asks for at least 1500 output tokens', async () => {
  const seen = {}
  await createTriageJudge({ llm: fakeLlm({ answer: GOOD, seen }) }).judge({ item: ITEM, rules: RULES })
  assert.ok(seen.cfg.maxTokens >= 1500, 'maxTokens was ' + seen.cfg.maxTokens)
})

test('reasoning chunks before the text do not end up in the parsed raw reply', async () => {
  const llm = fakeLlm({ answer: GOOD })
  const orig = llm.prepareCall
  llm.prepareCall = async (cfg) => { const p = await orig(cfg); return { ...p, stream: async function* (req) { yield { type: 'reasoning-delta', index: 0, text: 'thinking {"attention": 1} hard' }; yield* p.stream(req) } } }
  const r = await createTriageJudge({ llm }).judge({ item: ITEM, rules: RULES })
  assert.deepEqual(r.judgment, GOOD)
  assert.ok(!r.raw.includes('thinking'))
})

test('a truncated reply names the finish reason in the log line', async () => {
  const llm = fakeLlm({ answer: '{"needs_decision": true, "answer_basis": "none", "ans' })
  const orig = llm.prepareCall
  llm.prepareCall = async (cfg) => { const p = await orig(cfg); return { ...p, stream: async function* (req) { yield* p.stream(req); yield { type: 'finish', reason: { kind: 'max-tokens' } } } } }
  const lines = []
  const r = await createTriageJudge({ llm, log: (l) => lines.push(l) }).judge({ item: ITEM, rules: RULES })
  assert.ok(!r.judgment)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /finish: max-tokens/)
})
