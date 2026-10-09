import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capWords, permissionHeadline, questionHeadline, spoken, stopHeadline } from '../voice/headline.js'

test('numbers up to twenty are spelled out and larger ones stay digits', () => {
  assert.equal(spoken(3), 'three')
  assert.equal(spoken(20), 'twenty')
  assert.equal(spoken(21), '21')
})

test('capWords collapses whitespace, caps with an ellipsis and tolerates non-text', () => {
  assert.equal(capWords('  a   b  c ', 5), 'a b c')
  assert.equal(capWords('a b c d', 2), 'a b...')
  assert.equal(capWords(undefined, 5), '')
  assert.equal(capWords(42, 5), '42')
})

test('stop headline names the number and project, and drops a missing project', () => {
  assert.equal(stopHeadline({ number: 3, project: 'dsh-plugins' }), 'Three, dsh-plugins, done.')
  assert.equal(stopHeadline({ number: 3, project: '' }), 'Three, done.')
  assert.equal(stopHeadline({ number: 27, project: 'x' }), '27, x, done.')
})

test('question headline speaks the first usable question, capped at 15 words', () => {
  assert.equal(
    questionHeadline({ number: 2, questions: [{ question: 'Which approach should I design around?' }] }),
    'Two, question: Which approach should I design around?')
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')
  const out = questionHeadline({ number: 2, questions: [{ question: long }] })
  assert.equal(out.split(' ').length, 2 + 15)
  assert.ok(out.endsWith('...'))
})

test('question headline survives missing, blank and non-string questions', () => {
  assert.equal(questionHeadline({ number: 2, questions: [] }), 'Two, question.')
  assert.equal(questionHeadline({ number: 2 }), 'Two, question.')
  assert.equal(questionHeadline({ number: 2, questions: [null, { question: '  ' }, { question: 7 }, { question: 'Real one?' }] }), 'Two, question: Real one?')
})

test('permission headline uses plain words for known tools and de-snakes unknown ones', () => {
  assert.equal(permissionHeadline({ number: 4, toolName: 'write' }), 'Four, approve write file?')
  assert.equal(permissionHeadline({ number: 4, toolName: 'pwsh' }), 'Four, approve run command?')
  assert.equal(permissionHeadline({ number: 4, toolName: 'custom_tool-x' }), 'Four, approve custom tool x?')
  assert.equal(permissionHeadline({ number: 4 }), 'Four, approve tool?')
})
