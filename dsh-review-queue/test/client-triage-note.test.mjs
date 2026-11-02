// Phase 2 of the AI triage plan: the observe-mode note on an open card, shared by the desktop overlay and the phone (exports.shared).
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './client-todo-helpers.mjs'

const { mod, T } = loadClient()
const triageNote = mod.shared.triageNote

const proposal = { verdict: 'handle', mode: 'observe', ruleName: 'Read-only commands', score: 10.4, would: 'approve this read-only command' }

test('triageNote is exported through shared and __test', () => {
  assert.equal(typeof triageNote, 'function')
  assert.equal(T.triageNote, triageNote)
})

test('an open card with a proposal says what the AI would have done, the rule and the score, and that nothing was done', () => {
  const text = triageNote({ id: 'i', status: 'open', type: 'permission', triage: proposal })
  assert.match(text, /^AI would have handled this: approve this read-only command/)
  assert.match(text, /Read-only commands/)
  assert.match(text, /attention 10\b/)
  assert.match(text, /Nothing was done\.$/)
})

test('no note without a handle proposal, and none on a resolved item', () => {
  assert.equal(triageNote({ status: 'open', type: 'permission' }), undefined)
  assert.equal(triageNote({ status: 'open', triage: { verdict: 'ask' } }), undefined)
  assert.equal(triageNote({ status: 'resolved', triage: proposal }), undefined)
  assert.equal(triageNote(undefined), undefined)
})

test('a proposal with no rule name or text still reads sensibly', () => {
  assert.equal(triageNote({ status: 'open', triage: { verdict: 'handle' } }), 'AI would have handled this: handle it. Nothing was done.')
})
