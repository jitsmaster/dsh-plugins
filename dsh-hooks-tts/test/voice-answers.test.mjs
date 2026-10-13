// Spec: docs/voice-two-stage-flow.md §1 (answer classification) and §2 (voice/answers.js).
// Shapes chosen where the spec is open (implementer: follow these):
// - normalize(text): lower-case, CJK + ASCII punctuation removed, whitespace collapsed to single spaces, trimmed.
// - classifyAnswer matches the WHOLE normalized utterance only; a repeated answer word ("yes yes", "no no") still counts.
import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyAnswer, normalize } from '../voice/answers.js'

test('normalize lower-cases, drops punctuation (EN and ZH) and collapses whitespace', () => {
  assert.equal(normalize('  Yes. Yes!  '), 'yes yes')
  assert.equal(normalize('No,   send it to B.'), 'no send it to b')
  assert.equal(normalize('是的。'), '是的')
  assert.equal(normalize('...'), '')
})

test('A1 yes variants in English and Chinese classify as yes', () => {
  for (const t of ['yes', 'Yes.', 'YES', 'yeah!', 'yep', 'Yes. Yes.', ' yes yes ', '是', '是的', '是的。']) {
    assert.equal(classifyAnswer(t), 'yes', t)
  }
})

test('A2 stop and cancel words (EN and ZH) classify as stop', () => {
  for (const t of ['stop', 'Stop.', 'cancel', 'Cancel!', '取消', '停', '取消。']) {
    assert.equal(classifyAnswer(t), 'stop', t)
  }
})

test('A3 empty, whitespace-only and punctuation-only answers classify as empty', () => {
  for (const t of ['', '   ', '...', ' . . ', '\n\t']) {
    assert.equal(classifyAnswer(t), 'empty', JSON.stringify(t))
  }
})

test('A4 a yes inside a longer sentence is text, not yes (whole-utterance only)', () => {
  assert.equal(classifyAnswer('yes please send it to PR 5'), 'text')
  assert.equal(classifyAnswer('send it to PR 5'), 'text')
  assert.equal(classifyAnswer('是的，发给第二个会话'), 'text')
})

test('A5 a bare no-word classifies as no; no followed by an instruction is text', () => {
  for (const t of ['no', 'No.', 'nope', 'no no', '不', '不是', '不对', '不是。']) {
    assert.equal(classifyAnswer(t), 'no', t)
  }
  assert.equal(classifyAnswer('no, send it to B'), 'text')
  assert.equal(classifyAnswer('不是，发给B'), 'text')
})
