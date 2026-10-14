import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchQueueCommand } from '../voice/queue-commands.js'

const NAMES = ['task list', 'the task list', 'task-list', 'tasks', 'the queue', 'queue', 'review queue', 'the review queue', 'review list', 'my to-do list', 'todo list', 'the todo list', 'to do list']

const eq = (text, expected) => assert.deepEqual(matchQueueCommand(text), expected, JSON.stringify(text))

test('show: every list name, with the usual STT decoration', () => {
  for (const name of NAMES) {
    eq('show ' + name, { kind: 'show' })
    eq('Show ' + name + '.', { kind: 'show' })
    eq('open ' + name, { kind: 'show' })
  }
  for (const text of [
    'show task list', 'Show task list.', 'show the task list', 'Show the task list.', 'show me the task list', 'Show me the task list!',
    'open the task list', 'Open the task list.', 'open task list', 'show the task list, please', 'please show the task list',
    'Please, show me the task list.', 'can you show the task list', 'Can you show me the task list?', 'could you please open the task list',
    'hey show the task list', 'Hey, show me the task list.', 'SHOW THE TASK LIST', '  show   the   task   list  ', 'show the task list now',
    'display the task list', 'bring up the task list', 'pull up the queue', 'show the tasks', 'show my queue', 'Show the queue.',
    'show the review queue', 'show the review list.', 'show the to-do list', 'show the todo list', 'show the To-Do List.',
    'show the task list thanks', 'okay show the task list', 'show the task-list',
  ]) eq(text, { kind: 'show' })
})

test('show: hidden characters, fullwidth and odd spacing do not matter', () => {
  eq('show\u200b the task list', { kind: 'show' })
  eq('\ufeffshow the task list', { kind: 'show' })
  eq('show\u00a0the\u00a0task list', { kind: 'show' })
  eq('Ｓｈｏｗ ｔｈｅ ｔａｓｋ ｌｉｓｔ', { kind: 'show' })
  eq('show the task list\u0000', { kind: 'show' })
})

test('hide: close, dismiss and hide with every name', () => {
  for (const name of NAMES) {
    eq('hide ' + name, { kind: 'hide' })
    eq('close ' + name + '.', { kind: 'hide' })
    eq('dismiss ' + name, { kind: 'hide' })
  }
  for (const text of [
    'hide task list', 'Hide task list.', 'hide the task list', 'Hide the task list.', 'close the task list', 'Close the task list.',
    'dismiss the queue', 'Dismiss the queue.', 'hide the queue please', 'please close the task list', 'could you hide the task list',
    'hey, hide the task list', 'close the review queue', 'hide my to-do list', 'hide the tasks', 'close task list',
  ]) eq(text, { kind: 'hide' })
})

test('count: how many and what is in the list', () => {
  for (const text of [
    'how many items', 'How many items?', 'how many items.', 'how many tasks are waiting', 'How many tasks are waiting?', 'how many things are in the task list',
    "What's in my queue", "what's in my queue?", 'whats in my queue', 'what is in my queue', 'what is in the task list', "What's in the task list?",
    'how many items are waiting', 'how many items are in the queue', 'how many are waiting', 'how many are in the queue', 'how many tasks',
    'how many things are waiting', 'how many items are in my task list', 'how many tasks are in the review queue', 'how many items are left',
    'can you tell me how many items are waiting', 'please tell me how many items are waiting', 'how many items do I have', 'how many tasks do i have waiting',
    'how many items in the queue', 'how many things are in the to-do list', 'whats waiting', "what's waiting for me", 'is anything waiting', 'is there anything waiting',
    'hey how many items are waiting', 'HOW MANY ITEMS', 'how many items are pending',
  ]) eq(text, { kind: 'count' })
})

test('read: the first item and item N by number word or digit', () => {
  for (const text of ['read the first item', 'Read the first item.', 'read first item', 'Read first item', 'read the first one', 'read me the first item', 'please read the first item', 'can you read the first item', 'read the 1st item', 'read item one', 'Read item 1.', 'read item number one', 'read number one', 'read the first task']) {
    eq(text, { kind: 'read', n: 1 })
  }
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
  words.forEach((word, i) => {
    eq('read item ' + word, { kind: 'read', n: i + 1 })
    eq('Read item ' + word + '.', { kind: 'read', n: i + 1 })
    eq('read item ' + (i + 1), { kind: 'read', n: i + 1 })
    eq('read item number ' + (i + 1) + ',', { kind: 'read', n: i + 1 })
    eq('read number ' + word, { kind: 'read', n: i + 1 })
  })
  eq('read the second item', { kind: 'read', n: 2 })
  eq('read the third item.', { kind: 'read', n: 3 })
  eq('read the twentieth item', { kind: 'read', n: 20 })
  eq('read the 2nd one', { kind: 'read', n: 2 })
  eq('read item 21', { kind: 'read', n: 21 })
  eq('read item 105', { kind: 'read', n: 105 })
  eq('read item twenty one', { kind: 'read', n: 21 })
  eq('read item twenty-one', { kind: 'read', n: 21 })
  eq('read item for', { kind: 'read', n: 4 })
  eq('read item to', { kind: 'read', n: 2 })
  eq('play item two', { kind: 'read', n: 2 })
})

test('next: the next one, with or without a verb', () => {
  for (const text of ['next', 'Next.', 'the next one', 'The next one.', 'next one', 'next item', 'the next item', 'read the next one', 'Read the next one.', 'read next', 'read the next item', 'read me the next one', 'please read the next one', 'next please', 'play the next one', 'read the next task']) {
    eq(text, { kind: 'next' })
  }
})

test('again: read it again, repeat, say that again', () => {
  for (const text of ['read it again', 'Read it again.', 'read that again', 'read again', 'Read again.', 'repeat', 'Repeat.', 'repeat that', 'repeat it', 'say that again', 'Say that again.', 'say it again', 'play it again', 'please read it again', 'can you repeat that', 'could you say that again please', 'read the item again', 'read that one again', 'hey repeat that']) {
    eq(text, { kind: 'again' })
  }
})

test('stop: stop, stop reading, be quiet', () => {
  for (const text of ['stop', 'Stop.', 'STOP!', 'stop reading', 'Stop reading.', 'stop reading it', 'stop talking', 'stop speaking', 'stop that', 'stop it', 'be quiet', 'Be quiet.', 'quiet', 'please stop', 'please stop reading', 'hey stop', 'stop the reading']) {
    eq(text, { kind: 'stop' })
  }
})

test('open: the first item and its session', () => {
  for (const text of ['open the first item', 'Open the first item.', 'open first item', 'open its session', 'Open its session.', 'open the first item session', "open the first item's session", "Open the first item's session.", 'open the session of the first item', 'open item one', 'open item 1', 'open the first task', 'please open the first item', 'could you open its session', 'open the first one']) {
    eq(text, { kind: 'open' })
  }
})

test('reply: only the first item is recognised in this round', () => {
  for (const text of ['reply to the first item', 'Reply to the first item.', 'reply to first item', 'reply to item one', 'reply to item 1', 'reply to the first one', 'please reply to the first item', 'could you reply to the first task', 'reply to the 1st item', 'reply to item number one']) {
    eq(text, { kind: 'reply', n: 1 })
  }
  for (const text of ['reply to item two', 'reply to the second item', 'reply to item 3']) eq(text, undefined)
})

test('ordinary prompts that merely contain these words never match', () => {
  for (const text of [
    'I need to show the task list in the UI', 'show the task list in the UI', 'show the task list component', 'show the task list when the queue is empty',
    'stop the server', 'stop the dev server', 'stop all the tests', 'stop worrying about the lint errors', 'stop reading from the socket when it closes',
    'read the file', 'read the file src/index.js', 'read the first item of the array', 'read item from the list and print it', 'read the config again and fix the bug',
    'how many items does the cart have', 'how many items are in the cart', 'how many items are in the array', 'how many tasks does this function spawn', 'how many tasks can the pool run',
    'how many things are in the node_modules folder', 'what is in the config file', "what's in my package.json", 'what is in the queue implementation',
    'close the queue connection', 'close the file handle', 'close the issue', 'hide the sidebar', 'hide the task list when it is empty', 'dismiss the dialog',
    'open the file', 'open the settings page', 'open the first file', 'open the first PR', 'open its pull request', 'open the session list', 'open that session', 'open the review',
    'reply to the customer', 'reply to the email', 'reply to the first email', 'reply to item', 'reply',
    'next step is to run the tests', 'next we need to refactor', 'the next release', 'what is next', 'next time',
    'repeat the test three times', 'repeat this for each file', 'say that again to the user', 'say it again in the docs',
    'add a task list to the readme', 'add the queue to the design', 'the task list is broken', 'fix the review queue overlay', 'refactor the todo list component',
  ]) eq(text, undefined)
})

test('empty, filler-only and non-strings never match', () => {
  for (const text of ['', '   ', '...', 'please', 'hey', 'can you', 'show', 'show me', 'hide', 'open', 'close', 'read', 'item', 'the task list', 'task list', 'queue', 'tasks', 'again', 'one', 'first item']) eq(text, undefined)
  for (const value of [undefined, null, 5, {}, [], true]) assert.equal(matchQueueCommand(value), undefined)
})

test('a command followed by more speech is not the command', () => {
  for (const text of [
    'show the task list and then read the first item', 'show the task list. Then close it.', 'show the task list in the browser please', 'read the first item and reply to it',
    'stop reading and show the task list', 'hide the task list and open the first item', 'how many items are waiting in the cart',
    'show the task list, the queue and the review list', 'read item two of the plan',
  ]) eq(text, undefined)
})

test('very long utterances are not matched at all', () => {
  eq('show the task list ' + 'x '.repeat(200), undefined)
  eq('please '.repeat(30) + 'show the task list', undefined)
})

test('the matcher result is a fresh plain object', () => {
  const a = matchQueueCommand('read item two')
  const b = matchQueueCommand('read item two')
  assert.notEqual(a, b)
  a.n = 9
  assert.deepEqual(matchQueueCommand('read item two'), { kind: 'read', n: 2 })
})
