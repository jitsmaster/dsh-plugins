import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spokenFor, titleFor, fullTextFor, chunkForSpeech } from '../speech.js'

// How the task list reads a FOLLOW-UP todo (kind 'followup': the text goes to an existing session) aloud, and how its card is titled.
const item = (over = {}) => ({
  type: 'todo', kind: 'followup', text: 'Reply to the reviewer.', query: 'the PR 6563 session', sparc: false, state: 'awaiting-confirm',
  candidates: [{ sessionId: 's1', title: 'PR 6563 review', workspaceTitle: 'CTnP-Final' }],
  suggested: { sessionId: 's1', title: 'PR 6563 review', reason: 'named in the words', workspaceTitle: 'CTnP-Final' }, ...over,
})

test('a follow-up waiting for confirmation reads "Follow up: <text>, send to <session title>?"', () => {
  assert.equal(spokenFor(item(), 2).headline, 'Item 2. Follow up: Reply to the reviewer, send to PR 6563 review?')
  assert.equal(spokenFor(item(), undefined).headline, 'Follow up: Reply to the reviewer, send to PR 6563 review?')
  assert.match(fullTextFor(item(), 2), /^Item 2\.\n\nFollow up: Reply to the reviewer, send to PR 6563 review\?/)
})

test('without a suggestion it asks which session', () => {
  assert.equal(spokenFor(item({ suggested: undefined }), 1).headline, 'Item 1. Follow up: Reply to the reviewer. Which session?')
  assert.equal(spokenFor(item({ suggested: undefined, suggesting: true }), 1).headline, 'Item 1. Follow up: Reply to the reviewer. Which session?')
})

test('failed, sending and sent have their own line', () => {
  assert.equal(spokenFor(item({ state: 'failed', error: 'the session is gone', targetSessionId: 's1', sessionTitle: 'PR 6563 review' }), 1).headline, 'Item 1. Follow up: Reply to the reviewer. Failed to send: the session is gone.')
  assert.equal(spokenFor(item({ state: 'failed' }), 1).headline, 'Item 1. Follow up: Reply to the reviewer. Failed to send: unknown error.')
  assert.equal(spokenFor(item({ state: 'starting', targetSessionId: 's1', sessionTitle: 'PR 6563 review' }), 1).headline, 'Item 1. Follow up: Reply to the reviewer, sending to PR 6563 review.')
  assert.equal(spokenFor(item({ state: 'started', status: 'resolved', sessionId: 's1', sessionTitle: 'PR 6563 review' }), 1).headline, 'Item 1. Follow up: Reply to the reviewer, sent to PR 6563 review.')
})

test('a sent follow-up read from the resolved list (no queue position) says where it went, in the headline and the full text', () => {
  const sent = item({ state: 'started', status: 'resolved', sessionId: 's1', sessionTitle: 'PR 6563 review', resolution: { kind: 'followed-up', by: 'card', sessionId: 's1' } })
  assert.equal(spokenFor(sent, undefined).headline, 'Follow up: Reply to the reviewer, sent to PR 6563 review.')
  assert.equal(fullTextFor(sent, undefined), 'Follow up: Reply to the reviewer, sent to PR 6563 review.')
})

test('the text is cut to 25 words and, in characters, to 300 for the headline and 600 for the full text (as for a todo)', () => {
  const words = Array.from({ length: 60 }, (_, i) => 'word' + i).join(' ')
  const spoken = spokenFor(item({ text: words }), 1)
  assert.ok(spoken.headline.includes('word24') && !spoken.headline.includes('word25'), 'the headline keeps 25 words')
  const wide = Array.from({ length: 25 }, () => 'w'.repeat(30)).join(' ')
  const head = spokenFor(item({ text: wide }), 1).headline
  const full = fullTextFor(item({ text: wide }), 1)
  assert.ok(head.length < full.length, head.length + ' vs ' + full.length)
  assert.ok(full.length < 700 && head.length < 400)
})

test('the session title and the text are untrusted: hidden characters and markdown are cleaned and a long text is cut', () => {
  const long = 'word '.repeat(200)
  const h = spokenFor(item({ text: '**Fix**\u200B this ' + long, suggested: { sessionId: 's1', title: '**Bold**\u200B session' } }), 1).headline
  assert.ok(!h.includes('**') && !h.includes('\u200B'), h)
  assert.match(h, /send to Bold session\?$/)
  assert.ok(h.length < 400, String(h.length))
  assert.ok(chunkForSpeech(fullTextFor(item({ text: long }), 1)).length >= 2)
})

test('a very long session title is cut to a few words', () => {
  const title = Array.from({ length: 30 }, (_, i) => 'title' + i).join(' ')
  const h = spokenFor(item({ suggested: { sessionId: 's1', title } }), 1).headline
  assert.ok(h.includes('title7') && !h.includes('title8'), h)
})

test('the card title is "Follow up: <first line>"; an empty text still has a title', () => {
  assert.equal(titleFor(item({ text: 'Reply to the reviewer\nline two' })), 'Follow up: Reply to the reviewer')
  assert.equal(titleFor(item({ text: '\n\n  second line\nthird' })), 'Follow up: second line')
  assert.equal(titleFor(item({ text: 'Reply to the reviewer and more words than ten can hold today ok\nline two' })), 'Follow up: Reply to the reviewer and more words than ten can...')
  assert.equal(titleFor(item({ text: '' })), 'Follow up')
})

test('a workspace todo is read and titled exactly as before', () => {
  const todo = { type: 'todo', text: 'Fix the login redirect.', sparc: false, state: 'awaiting-confirm', suggested: { workspaceId: 'w', title: 'dsh-plugins' } }
  assert.equal(spokenFor(todo, 2).headline, 'Item 2. Todo: Fix the login redirect, start in dsh-plugins?')
  assert.equal(spokenFor({ ...todo, suggested: undefined }, 1).headline, 'Item 1. Todo: Fix the login redirect. Which workspace?')
  assert.equal(titleFor(todo), 'Fix the login redirect.')
})
