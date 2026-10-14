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

import { titleFor, fullTextFor, speakable, chunkForSpeech } from '../speech.js'

test('titleFor: a completed item prefers the model title, then the request, then the reply', () => {
  assert.equal(titleFor({ type: 'completed', title: 'Move auth out', payload: { request: 'please do x', reply: 'r' } }), 'Move auth out')
  assert.equal(titleFor({ type: 'completed', payload: { request: 'Fix the login bug in the auth module today please and then run all tests', reply: 'Done.' } }), 'Fix the login bug in the auth module today please...')
  assert.equal(titleFor({ type: 'completed', payload: { reply: 'Refactored auth. Tests pass.' } }), 'Refactored auth.')
  assert.equal(titleFor({ type: 'completed', payload: { reply: '# Login refactor\n\nI moved the code.' } }), 'Login refactor')
  assert.equal(titleFor({ type: 'completed', payload: {} }), 'Finished')
})

test('titleFor: questions and permissions are named by what they ask', () => {
  assert.equal(titleFor({ type: 'question', payload: { questions: [{ id: 'q', header: 'Port', question: 'Which port should the server use?' }] } }), 'Port')
  assert.equal(titleFor({ type: 'question', payload: { questions: [{ id: 'q', question: 'Which port should the server use?' }] } }), 'Which port should the server use?')
  assert.equal(titleFor({ type: 'permission', payload: { summary: 'shell: git push origin main', toolName: 'shell' } }), 'shell: git push origin main')
  assert.equal(titleFor({ type: 'permission', payload: { toolName: 'shell' } }), 'shell')
})

test('speakable keeps paragraphs, drops markdown and code blocks, and removes hidden characters', () => {
  const md = '# Heading\n\nSome **bold** text with a [link](http://x.y) and `code`.\n\n```js\nconst a = 1\n```\n\n- one\n- two\u200B\n'
  const out = speakable(md)
  assert.equal(out, 'Heading\n\nSome bold text with a link and code.\n\n(code block omitted)\n\none\ntwo')
  assert.equal(speakable(undefined), '')
  assert.equal(speakable('a'.repeat(30000)).length <= 20003, true)
})

test('chunkForSpeech packs sentences into short pieces, the first one shorter so playback starts early', () => {
  const s = (n) => ('Sentence number ' + n + ' is here.')
  const text = Array.from({ length: 30 }, (_, i) => s(i)).join(' ')
  const chunks = chunkForSpeech(text, { first: 100, max: 200 })
  assert.ok(chunks.length > 3)
  assert.ok(chunks[0].length <= 100)
  assert.ok(chunks.every((c) => c.length <= 200))
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text)
  assert.deepEqual(chunkForSpeech('   '), [])
  const long = chunkForSpeech('word '.repeat(200), { first: 50, max: 80 })
  assert.ok(long.every((c) => c.length <= 80))
})

test('chunkForSpeech splits paragraphs apart', () => {
  assert.deepEqual(chunkForSpeech('One.\n\nTwo.', { first: 100, max: 200 }), ['One.', 'Two.'])
})

test('fullTextFor reads the whole reply for a done item, not the summary', () => {
  const t = fullTextFor({ type: 'completed', sessionTitle: 'Proj', title: 'Move auth', summary: 'SHORT SUMMARY', payload: { reply: 'First part.\n\nSecond part.' } }, 3)
  assert.match(t, /Move auth/)
  assert.match(t, /First part\.\n\nSecond part\./)
  assert.doesNotMatch(t, /SHORT SUMMARY/)
})

test('fullTextFor reads a question with its options and a permission with its reason', () => {
  const q = fullTextFor({ type: 'question', sessionTitle: 'P', payload: { questions: [{ id: 'q', question: 'Pick?', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }] } }, 1)
  assert.match(q, /Pick\?/)
  assert.match(q, /Option 2: B/)
  const p = fullTextFor({ type: 'permission', sessionTitle: 'P', payload: { summary: 'shell: ls', reason: 'Needs to list files' } }, 2)
  assert.match(p, /shell: ls/)
  assert.match(p, /Needs to list files/)
})
