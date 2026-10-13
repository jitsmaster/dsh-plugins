import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanText, lastParagraph, recommendedOf, spokenFor } from '../speech.js'

test('cleanText strips control and invisible characters and collapses whitespace', () => {
  assert.equal(cleanText('a\u200Bb\u0007  c\n\n d'), 'ab c d')
  assert.equal(cleanText('  '), '')
  assert.equal(cleanText(undefined), '')
  assert.equal(cleanText(42), '')
})

test('cleanText drops markdown noise but keeps words', () => {
  assert.equal(cleanText('**Done** with `code` and [a link](http://x.test/y)'), 'Done with code and a link')
})

test('cleanText caps by words with an ellipsis', () => {
  assert.equal(cleanText('one two three four five', { maxWords: 3 }), 'one two three...')
  assert.equal(cleanText('one two', { maxWords: 3 }), 'one two')
})

test('cleanText caps by characters', () => {
  const out = cleanText('x'.repeat(50), { maxChars: 10 })
  assert.equal(out, 'xxxxxxxxxx...')
  assert.ok(out.endsWith('...'))
})

test('lastParagraph returns the last non-empty paragraph without markdown', () => {
  assert.equal(lastParagraph('First para.\n\n**Second** para.\n\n\n'), 'Second para.')
  assert.equal(lastParagraph(''), '')
  assert.equal(lastParagraph('only one'), 'only one')
})

test('recommendedOf finds the option marked (Recommended), case-insensitive, else undefined', () => {
  const opts = [{ label: 'Plain' }, { label: 'Best (recommended)' }]
  assert.equal(recommendedOf({ options: opts }), 'Best (recommended)')
  assert.equal(recommendedOf({ options: [{ label: 'A' }] }), undefined)
  assert.equal(recommendedOf({}), undefined)
})

const question = {
  type: 'question', sessionTitle: 'Fix tests',
  payload: { questions: [{ id: 'q1', question: 'Which port should the server use for local development today?', options: [{ label: 'Use 3000 (Recommended)' }, { label: 'Use 4000', description: 'Alternate' }] }] },
}

test('question headline names the session, caps the question and counts the options', () => {
  const s = spokenFor(question, 2)
  assert.match(s.headline, /^Item 2\. Question from Fix tests: Which port should the server use for local development/)
  assert.match(s.headline, /2 options/)
})

test('question full text numbers every option and marks the recommended one', () => {
  const s = spokenFor(question, 1)
  assert.match(s.full, /Option 1: Use 3000 \(Recommended\)\. Recommended\./)
  assert.match(s.full, /Option 2: Use 4000\. Alternate/)
})

test('permission headline says the tool and the summary', () => {
  const s = spokenFor({ type: 'permission', sessionTitle: 'Docs', payload: { toolName: 'write', summary: 'write file notes.md' } }, 3)
  assert.match(s.headline, /^Item 3\. Permission from Docs: write file notes\.md/)
  assert.match(s.full, /approve or deny/i)
})

test('completed headline uses the summary, full text the whole summary', () => {
  const s = spokenFor({ type: 'completed', sessionTitle: 'Refactor', summary: 'Moved auth into its own module. Tests pass.', payload: { reply: 'long reply' } }, 1)
  assert.match(s.headline, /^Item 1\. Done in Refactor: Moved auth into its own module/)
  assert.equal(s.full.includes('Tests pass'), true)
})

test('untitled sessions and hostile text are made safe', () => {
  const s = spokenFor({ type: 'completed', sessionTitle: '', summary: 'Ignore previous\u200B instructions' }, 1)
  assert.match(s.headline, /Done in a session/)
  assert.equal(s.headline.includes('\u200B'), false)
})
