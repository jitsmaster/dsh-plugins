// Slice 6: the phrases that answer the first task-list item by voice (permission: approve / deny; question: option N,
// the Nth one, recommended, "answer <text>"; "reply to the first item" also starts a free-text answer). Like every other rule they are
// anchored to the whole utterance, so ordinary prompts that merely contain these words fall through to the LLM flow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchQueueCommand, parseOptionAnswer } from '../voice/queue-commands.js'

const eq = (text, expected) => assert.deepEqual(matchQueueCommand(text), expected, JSON.stringify(text))
const none = (text) => assert.equal(matchQueueCommand(text), undefined, JSON.stringify(text))

test('approve: the word, with the usual decoration', () => {
  for (const text of ['approve', 'Approve.', 'approve it', 'Approve it.', 'approve this', 'approve that', 'approve this request', 'approve the request',
    'yes approve', 'Yes, approve it.', 'yeah approve', 'please approve', 'Please approve it.', 'hey approve', 'okay approve it', 'approve it please', 'APPROVE',
    'I want you to approve', 'can you approve it', 'No, approve', 'approve the first item', 'approve the first one', 'approveIt', 'Approve\u200b it']) eq(text, { kind: 'approve' })
})

test('deny: deny and reject', () => {
  for (const text of ['deny', 'Deny.', 'deny it', 'Deny it.', 'deny this', 'deny that', 'deny this request', 'deny the request', 'yes deny', 'Yes, deny it.',
    'reject', 'Reject.', 'reject it', 'reject this request', 'please deny', 'hey reject', 'deny it please', 'DENY', 'I want you to deny it', 'No, deny', 'deny the first item', 'denyIt']) eq(text, { kind: 'deny' })
})

test('approve / deny: a sentence that merely contains the word is not a command', () => {
  for (const text of ['approve the pull request on github', 'approve all', 'approve the plan and merge it', 'I approve of this plan', 'deny access to the repository',
    'deny all requests', 'reject the idea of caching', 'do not approve it', 'approve or deny', 'what should I approve', 'approval', 'approved', 'denied', 'rejected',
    'approve it and then push', 'can you reject the second one', 'approve the second item', 'deny item two', 'disapprove', 'undeny', 'approve approve approve approve approve approve approve approve approve approve approve approve approve approve approve']) none(text)
})

test('option: "option two", "choose option 2" and the spoken variants', () => {
  for (const [text, n] of [['option two', 2], ['Option two.', 2], ['option 2', 2], ['Option 3', 3], ['choose option 2', 2], ['Choose option two.', 2], ['pick option three', 3],
    ['select option 1', 1], ['go with option two', 2], ['I choose option two', 2], ['answer option two', 2], ['please choose option two', 2], ['option number two', 2],
    ['option one', 1], ['option ten', 10], ['option twenty one', 21], ['option to', 2], ['option for', 4], ['option won', 1], ['hey option two', 2], ['option two please', 2],
    ['OPTION TWO', 2], ['choice two', 2], ['optionTwo', 2], ['No, option two', 2], ['I want you to choose option three', 3], ['use option two', 2], ['take option 1', 1]]) eq(text, { kind: 'option', n })
})

test('option: "the second one" and friends', () => {
  for (const [text, n] of [['the second one', 2], ['The second one.', 2], ['second one', 2], ['the first one', 1], ['the third option', 3], ['choose the first option', 1], ['pick the third one', 3],
    ['go with the second one', 2], ['the 2nd one', 2], ['select the fourth choice', 4], ['please choose the second one', 2], ['the second option please', 2]]) eq(text, { kind: 'option', n })
})

test('option: not a command when a word is missing, another word comes in, or it is a question', () => {
  for (const text of ['option', 'choose option', 'option two is better', 'what is option two', 'which option is recommended', 'option two and three', 'the second', 'second',
    'choose the second one in the list on the left', 'read option two', 'option zero maybe', 'the one', 'the second one is wrong', 'options', 'show option two',
    'explain option two', 'option a', 'the second one of the three']) none(text)
})

test('recommended: the word, with the usual lead-ins', () => {
  for (const text of ['recommended', 'Recommended.', 'the recommended one', 'choose recommended', 'Choose the recommended option.', 'go with the recommended one', 'pick the recommended option',
    'use the recommended answer', 'answer recommended', 'the recommended option', 'please choose recommended', 'recommended option', 'recommended please', 'I choose the recommended one', 'hey recommended', 'RECOMMENDED', 'the recommendation']) eq(text, { kind: 'recommended' })
})

test('recommended: not a command inside a sentence', () => {
  for (const text of ['recommended settings for the project', 'which one is recommended', 'what is recommended', 'is it recommended', 'recommended by the docs', 'not recommended', 'read the recommended one',
    'the recommended one is bad', 'recommended or not']) none(text)
})

test('answer <text>: the free text keeps its own case and punctuation', () => {
  eq('answer use Postgres', { kind: 'answer', text: 'use Postgres' })
  eq('Answer: use Postgres, please.', { kind: 'answer', text: 'use Postgres, please.' })
  eq('answer yes', { kind: 'answer', text: 'yes' })
  eq('please answer use the small one', { kind: 'answer', text: 'use the small one' })
  eq('I want you to answer keep it as is', { kind: 'answer', text: 'keep it as is' })
  eq('No, answer ship it', { kind: 'answer', text: 'ship it' })
  eq('Answer, the blue one.', { kind: 'answer', text: 'the blue one.' })
  eq('answer  spaced   out ', { kind: 'answer', text: 'spaced   out' })
  const long = 'x'.repeat(1400) + ' end'
  eq('answer ' + long, { kind: 'answer', text: long })
})

test('answer <text>: only when "answer" leads the utterance, and only with something to say', () => {
  for (const text of ['answer', 'Answer.', 'please answer', 'the answer is yes', 'what is the answer', 'I will answer later', 'answers', 'tell me the answer to life', 'unanswered question', 'answer ' + 'y'.repeat(3200)]) none(text)
})

test('answer <text>: "answer please" has no content, "answer the phone" has (a deliberate trade-off, see the docs)', () => {
  none('answer please')
  eq('can you answer the phone', { kind: 'answer', text: 'the phone' })
})

test('reply to the first item (or question) still starts a reply; other items do not', () => {
  eq('reply to the first item', { kind: 'reply', n: 1 })
  eq('Reply to the first question.', { kind: 'reply', n: 1 })
  eq('reply to the first task', { kind: 'reply', n: 1 })
  none('reply to the second question')
  none('reply to item two')
  none('reply to the first question about caching')
})

test('the new phrases never swallow the old ones', () => {
  eq('read the first item', { kind: 'read', n: 1 })
  eq('open the first item', { kind: 'open' })
  eq('stop', { kind: 'stop' })
  eq('read the next one', { kind: 'next' })
  none('read the first one now and the second')
})

test('parseOptionAnswer: option / recommended inside a question step, else undefined (free text)', () => {
  assert.deepEqual(parseOptionAnswer('Option two.'), { kind: 'option', n: 2 })
  assert.deepEqual(parseOptionAnswer('the second one'), { kind: 'option', n: 2 })
  assert.deepEqual(parseOptionAnswer('recommended'), { kind: 'recommended' })
  assert.deepEqual(parseOptionAnswer('choose the recommended option'), { kind: 'recommended' })
  for (const text of ['two', 'use postgres', 'approve', 'show the task list', 'option two is fine', '', '   ', undefined, null, 5]) assert.equal(parseOptionAnswer(text), undefined, String(text))
})
