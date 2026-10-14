import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spokenFor, titleFor, fullTextFor, chunkForSpeech } from '../speech.js'

// How the task list reads a todo aloud (the voice readers must cope with the new type).
const item = (over = {}) => ({ type: 'todo', text: 'Fix the login redirect.', sparc: false, state: 'awaiting-confirm', suggested: { workspaceId: 'w', title: 'dsh-plugins', reason: 'named in the text' }, ...over })

test('a todo waiting for confirmation reads "Todo: <text>, start in <workspace>?"', () => {
  assert.equal(spokenFor(item(), 2).headline, 'Item 2. Todo: Fix the login redirect, start in dsh-plugins?')
  assert.equal(spokenFor(item(), undefined).headline, 'Todo: Fix the login redirect, start in dsh-plugins?')
  assert.match(fullTextFor(item(), 2), /^Item 2\.\n\nTodo: Fix the login redirect, start in dsh-plugins\?/)
})

test('without a suggestion it asks which workspace; failed, starting and started have their own line', () => {
  assert.equal(spokenFor(item({ suggested: undefined }), 1).headline, 'Item 1. Todo: Fix the login redirect. Which workspace?')
  assert.match(spokenFor(item({ state: 'failed', error: 'no workspace', workspaceId: 'w', workspaceTitle: 'dsh-plugins' }), 1).headline, /^Item 1\. Todo: Fix the login redirect\. Failed to start: no workspace/)
  assert.match(spokenFor(item({ state: 'starting', workspaceTitle: 'dsh-plugins' }), 1).headline, /Todo: Fix the login redirect, starting in dsh-plugins/)
  assert.match(spokenFor(item({ state: 'started', workspaceTitle: 'dsh-plugins' }), 1).headline, /Todo: Fix the login redirect, started in dsh-plugins/)
})

test('todo text is untrusted: hidden characters and markdown are cleaned and a long text is cut', () => {
  const long = 'word '.repeat(200)
  const h = spokenFor(item({ text: '**Fix**\u200B this ' + long }), 1).headline
  assert.ok(!h.includes('**') && !h.includes('\u200B'))
  assert.ok(h.length < 400, String(h.length))
  assert.ok(chunkForSpeech(fullTextFor(item({ text: long }), 1)).length >= 2)
})

test('the card title is the first line of the todo; an empty text still has a title', () => {
  assert.equal(titleFor(item({ text: 'Fix the login redirect and more words than ten can hold today\nline two' })), 'Fix the login redirect and more words than ten can...')
  assert.equal(titleFor(item({ text: '' })), 'Todo')
})
