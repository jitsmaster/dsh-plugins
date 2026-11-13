// Slice 0 of review grouping and priority: the judge may return an optional `severity` (low | medium | high), separate from `attention`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTriageJudge, parseJudgment } from '../triage-judge.js'

const GOOD = {
  needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null,
  matched_rule: 'green-done', attention: 12, reversible: true, touches_outside_workspace: false, read_only: true,
}
const RULES = [{ id: 'green-done', class: 'done', instruction: 'Mechanical done messages: handle.' }]
const ITEM = { id: 'i1', type: 'completed', sessionTitle: 'T', workspace: 'D:/w', payload: { reply: 'Tests pass.' } }

function fakeLlm(answer, seen = {}) {
  return {
    listProviders: async () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'claude-haiku-x' }],
    prepareCall: async () => ({
      config: {},
      stream: async function* (req) {
        seen.req = req
        const text = JSON.stringify(answer)
        yield { type: 'text-delta', text }
      },
    }),
  }
}

test('a valid severity is kept on the judgment', () => {
  for (const severity of ['low', 'medium', 'high']) {
    assert.equal(parseJudgment(JSON.stringify({ ...GOOD, severity })).judgment.severity, severity)
  }
})

test('severity is optional: a judgment without it is still usable and carries no severity', () => {
  const r = parseJudgment(JSON.stringify(GOOD))
  assert.ok(r.judgment)
  assert.equal(r.judgment.severity, undefined)
})

test('an invalid severity is dropped without failing the whole judgment', () => {
  for (const severity of ['urgent', 5, null, '', {}, 'HIGH ']) {
    const r = parseJudgment(JSON.stringify({ ...GOOD, severity }))
    assert.ok(r.judgment, JSON.stringify(severity))
    assert.equal(r.judgment.severity, undefined, JSON.stringify(severity))
    assert.equal(r.judgment.attention, 12)
  }
})

test('severity does not change attention: the two are separate fields', () => {
  const r = parseJudgment(JSON.stringify({ ...GOOD, attention: 80, severity: 'low' }))
  assert.equal(r.judgment.attention, 80)
  assert.equal(r.judgment.severity, 'low')
})

test('the prompt asks for severity as its own field and leaves the attention rule untouched', async () => {
  const seen = {}
  const j = createTriageJudge({ llm: fakeLlm(GOOD, seen) })
  await j.judge({ item: ITEM, rules: RULES })
  assert.match(seen.req.system, /"severity"/)
  assert.match(seen.req.system, /low.*medium.*high/s)
  assert.match(seen.req.system, /when unsure answer above 50/)
})
