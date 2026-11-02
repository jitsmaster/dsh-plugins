// Phase 2 of the AI triage plan: the model call. A fake llm service stands in for the cheapest model; the judge must return the Judgment
// fields, or { note } on any failure, and never throw.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTriageJudge, parseJudgment, describeItem, JUDGE_TIMEOUT_MS } from '../triage-judge.js'

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

test('the default time limit is the 10 s of the spec', () => {
  assert.equal(JUDGE_TIMEOUT_MS, 10000)
})
