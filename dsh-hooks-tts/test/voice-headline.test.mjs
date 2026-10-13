import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capWords, lastParagraph, permissionHeadline, questionHeadline, stopHeadline, toolSummary } from '../voice/headline.js'

test('capWords collapses whitespace, caps with an ellipsis and tolerates non-text', () => {
  assert.equal(capWords('  a   b  c ', 5), 'a b c')
  assert.equal(capWords('a b c d', 2), 'a b...')
  assert.equal(capWords(undefined, 5), '')
  assert.equal(capWords(42, 5), '42')
})

test('stop headline says where it is done and then reads the last paragraph', () => {
  assert.equal(stopHeadline({ session: 'Voice work', workspace: 'dsh-plugins', summary: 'All merged.' }),
    'Done on: Session: Voice work; Workspace: dsh-plugins. All merged.')
  assert.equal(stopHeadline({ session: 'A', workspace: 'B' }), 'Done on: Session: A; Workspace: B.')
  assert.equal(stopHeadline({ workspace: 'B', summary: 'Text.' }), 'Done on: Workspace: B. Text.')
  assert.equal(stopHeadline({ session: 'A', summary: 'Text.' }), 'Done on: Session: A. Text.')
  assert.equal(stopHeadline({ summary: 'Text.' }), 'Done. Text.')
  assert.equal(stopHeadline({}), 'Done.')
})

test('lastParagraph takes the final prose block of a markdown reply', () => {
  assert.equal(lastParagraph('First part.\n\nSecond part.\n\n  Last one,\nwrapped over two lines.  \n\n'), 'Last one, wrapped over two lines.')
  assert.equal(lastParagraph('Only one.'), 'Only one.')
  assert.equal(lastParagraph('a\r\n\r\nb\r\nc'), 'b c')
  assert.equal(lastParagraph('Intro.\n\n- one\n- two\n- three'), 'one. two. three')
  assert.equal(lastParagraph('Result below.\n\n~~~js\ncode();\n~~~\n'), 'Result below.')
  assert.equal(lastParagraph('Result below.\n\n```js\n\ncode();\n```'), 'Result below.')
  assert.equal(lastParagraph(''), '')
  assert.equal(lastParagraph(undefined), '')
  assert.equal(lastParagraph(42), '42')
})

test('question headline speaks the first usable question, capped at 15 words', () => {
  assert.equal(
    questionHeadline({ questions: [{ question: 'Which approach should I design around?' }] }),
    'Question: Which approach should I design around?')
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')
  const out = questionHeadline({ questions: [{ question: long }] })
  assert.equal(out.split(' ').length, 1 + 15)
  assert.ok(out.endsWith('...'))
})

test('question headline survives missing, blank and non-string questions', () => {
  assert.equal(questionHeadline({ questions: [] }), 'Question.')
  assert.equal(questionHeadline({}), 'Question.')
  assert.equal(questionHeadline({ questions: [null, { question: '  ' }, { question: 7 }, { question: 'Real one?' }] }), 'Question: Real one?')
})

test('permission headline uses plain words for known tools and de-snakes unknown ones', () => {
  assert.equal(permissionHeadline({ toolName: 'write' }), 'Approve write file?')
  assert.equal(permissionHeadline({ toolName: 'pwsh' }), 'Approve run command?')
  assert.equal(permissionHeadline({ toolName: 'custom_tool-x' }), 'Approve custom tool x?')
  assert.equal(permissionHeadline({}), 'Approve tool?')
})

test('toolSummary: the command, file path or URL of the tool input, ready to be spoken', () => {
  assert.equal(toolSummary('pwsh', { command: 'npm test' }), 'npm test')
  assert.equal(toolSummary('bash', { command: 'ls -la' }), 'ls -la')
  assert.equal(toolSummary('write', { file_path: 'D:\\proj\\a.txt', content: 'secret body' }), 'D:\\proj\\a.txt')
  assert.equal(toolSummary('web_fetch', { url: 'https://example.com/a' }), 'https://example.com/a')
  assert.equal(toolSummary('web_search', { query: 'node docs' }), 'node docs')
  assert.equal(toolSummary('pwsh', JSON.stringify({ command: 'whoami' })), 'whoami', 'a JSON string input is parsed')
})

test('toolSummary is undefined when the input is unknown or has nothing to say', () => {
  for (const input of [undefined, null, '', {}, 42]) assert.equal(toolSummary('pwsh', input), undefined, JSON.stringify(input))
})

test('toolSummary keeps the first 100 characters and says "and more" when it cut', () => {
  const s = toolSummary('pwsh', { command: 'a'.repeat(250) })
  assert.equal(s, 'a'.repeat(100) + ' and more')
  assert.equal(toolSummary('pwsh', { command: 'b'.repeat(100) }), 'b'.repeat(100), 'exactly 100 is not cut')
})

test('toolSummary spells out what the speech cleaner would drop, so nothing is confirmed unheard', () => {
  const s = toolSummary('pwsh', { command: 'rm -rf ~/x | tee a_b > o; echo `id` [x](http://evil.test)' })
  for (const word of ['tilde', 'pipe', 'underscore', 'backtick']) assert.match(s, new RegExp(word), word)
  assert.doesNotMatch(s, /[|~_`^*#]/, 'none of the characters Clean-ForSpeech drops is left')
  assert.doesNotMatch(s, /\]\(/, 'no markdown link syntax is left')
})

test('toolSummary turns hidden characters into spoken warnings and collapses whitespace', () => {
  const s = toolSummary('pwsh', { command: 'echo a\u200Bb\u202Ec\nd\u00e9' })
  assert.match(s, /hidden character/)
  assert.match(s, /unusual character/)
  assert.doesNotMatch(s, /[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u00e9]/)
  assert.equal(toolSummary('pwsh', { command: '  a \r\n  b\t c ' }), 'a b c')
})
