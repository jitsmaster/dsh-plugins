import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFT_SAVE_MS, MAX_THREADS, PAGE_SIZE, applyEarlier, applyNewest, bubbleChanged, createDraftBuffer, expirePending, markSent, mergeMessages, pendingMessage,
  pollDelay, reconcile, sameThread, threadErrorText, threadPayload, touchThreads, trimThread,
} from '../lib/mobile/thread.js'

// Review follow-up (performance) of the phone's chat: a poll that brings nothing new must not make the screen render again, so every function
// that merges messages keeps the objects it already has; a message is drawn again only when it changed; typing goes to a local buffer that
// reaches the global state late; polling backs off while nothing happens; a thread that was left is trimmed (docs/mobile.md "Chat thread").
const m = (id, role, text, extra = {}) => ({ id, role, text, time: 1_700_000_000_000 + id, ...extra })
const same = (list, other) => list.every((x, i) => x === other[i]) && list.length === other.length

// ---- the objects that are already shown are kept --------------------------------------------------------------------------------------------

test('mergeMessages keeps the object it already has when the incoming copy is equal', () => {
  const a = [m(1, 'user', 'a'), m(2, 'assistant', 'b')]
  const merged = mergeMessages(a, [m(1, 'user', 'a'), m(2, 'assistant', 'b'), m(3, 'user', 'c')])
  assert.equal(merged[0], a[0])
  assert.equal(merged[1], a[1])
  assert.equal(merged.length, 3)
})

test('mergeMessages takes the incoming copy when its text, truncated flag, role or time differ', () => {
  const a = [m(1, 'user', 'a'), m(2, 'assistant', 'b')]
  const merged = mergeMessages(a, [m(1, 'user', 'a edited'), m(2, 'assistant', 'b', { truncated: true })])
  assert.deepEqual(merged.map((x) => [x.text, !!x.truncated]), [['a edited', false], ['b', true]])
  assert.notEqual(merged[0], a[0])
  assert.equal(mergeMessages(a, [m(1, 'assistant', 'a')])[0].role, 'assistant')
  assert.equal(mergeMessages(a, [{ ...a[0], time: 5 }])[0].time, 5)
})

test('mergeMessages keeps a pending bubble as it is, and an equal merge of the same messages gives equal contents', () => {
  const p = markSent([pendingMessage('hello', 1)], 'p-x')[0]
  const bubble = { ...pendingMessage('x', 2), sent: true }
  const merged = mergeMessages([m(1, 'user', 'a'), bubble], [m(1, 'user', 'a')])
  assert.equal(merged.at(-1), bubble)
  assert.ok(p)
})

test('reconcile keeps the shown messages when the page repeats them, and drops the bubble that caught up with its message', () => {
  const shown = [m(1, 'assistant', 'done'), m(2, 'assistant', 'more'), { ...pendingMessage('go on', 5), sent: true }]
  const out = reconcile(shown, [m(1, 'assistant', 'done'), m(2, 'assistant', 'more'), m(3, 'user', 'go on')])
  assert.deepEqual(out.map((x) => x.id), [1, 2, 3])
  assert.equal(out[0], shown[0])
  assert.equal(out[1], shown[1])
})

test('applyNewest and applyEarlier keep the objects of messages that came again', () => {
  const shown = { messages: [m(5, 'user', 'e'), m(6, 'assistant', 'f')], hasMore: true, cursor: 5 }
  const newest = applyNewest(shown, { messages: [m(5, 'user', 'e'), m(6, 'assistant', 'f'), m(7, 'user', 'g')], hasMore: true, cursor: 5 })
  assert.equal(newest.messages[0], shown.messages[0])
  assert.equal(newest.messages[1], shown.messages[1])
  const earlier = applyEarlier(shown, { messages: [m(3, 'user', 'c'), m(4, 'assistant', 'd')], hasMore: false, cursor: 3 })
  assert.equal(earlier.messages[2], shown.messages[0])
  assert.equal(earlier.messages[3], shown.messages[1])
})

test('a poll that repeats what is shown gives back the same messages in the same order', () => {
  const shown = { messages: [m(1, 'user', 'a'), m(2, 'assistant', 'b')], hasMore: false, cursor: 1 }
  const next = applyNewest(shown, { messages: [m(1, 'user', 'a'), m(2, 'assistant', 'b')], hasMore: false, cursor: 1 })
  assert.ok(same(next.messages, shown.messages))
})

test('expirePending gives back the very same array when no bubble is given up', () => {
  const messages = [m(1, 'user', 'a'), { ...pendingMessage('x', 1000), sent: true }]
  assert.equal(expirePending(messages, 1000 + 60_000), messages)
  assert.notEqual(expirePending(messages, 1000 + 16 * 60_000), messages)
})

// ---- the same state is not set again ----------------------------------------------------------------------------------------------------------------

const thread = (over = {}) => ({ messages: [m(1, 'user', 'a')], hasMore: false, cursor: 1, loading: false, loadingEarlier: false, error: null, offline: false, ...over })

test('sameThread compares the fields the view uses: messages by reference, hasMore, cursor, loading flags, error flags', () => {
  const a = thread()
  assert.equal(sameThread(a, { ...a }), true)
  assert.equal(sameThread(a, { ...a, messages: [...a.messages] }), true, 'a new array of the same objects')
  assert.equal(sameThread(a, { ...a, messages: [{ ...a.messages[0] }] }), false, 'an equal copy is another message')
  assert.equal(sameThread(a, { ...a, messages: [] }), false)
  for (const change of [{ hasMore: true }, { cursor: 2 }, { loading: true }, { loadingEarlier: true }, { error: 'x' }, { offline: true }]) assert.equal(sameThread(a, { ...a, ...change }), false, JSON.stringify(change))
})

// ---- a bubble is drawn again only when it changed -------------------------------------------------------------------------------------------------------

test('bubbleChanged is true for another message object or another minute, false for the same message in the same minute', () => {
  const x = m(1, 'user', 'a')
  assert.equal(bubbleChanged({ m: x, minute: 10 }, { m: x, minute: 10 }), false)
  assert.equal(bubbleChanged({ m: x, minute: 10 }, { m: { ...x }, minute: 10 }), true)
  assert.equal(bubbleChanged({ m: x, minute: 10 }, { m: x, minute: 11 }), true, 'the age under the bubble moves on')
})

// ---- the composer draft ---------------------------------------------------------------------------------------------------------------------------

test('the draft is written to the state 250 ms after the last keystroke, once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  assert.equal(DRAFT_SAVE_MS, 250)
  const writes = []
  const buffer = createDraftBuffer({ read: () => '', write: (text) => writes.push(text) })
  buffer.set('h')
  t.mock.timers.tick(200)
  buffer.set('he')
  t.mock.timers.tick(200)
  buffer.set('hello')
  assert.deepEqual(writes, [], 'typing alone writes nothing')
  t.mock.timers.tick(249)
  assert.deepEqual(writes, [])
  t.mock.timers.tick(1)
  assert.deepEqual(writes, ['hello'])
  assert.equal(buffer.value(), 'hello')
})

test('flush writes at once what was typed and cancels the timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes = []
  const buffer = createDraftBuffer({ read: () => '', write: (text) => writes.push(text) })
  buffer.set('typed')
  buffer.flush()
  assert.deepEqual(writes, ['typed'])
  t.mock.timers.tick(1000)
  assert.deepEqual(writes, ['typed'], 'the timer was cancelled')
})

test('a flush of a draft that already is in the state writes nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes = []
  const buffer = createDraftBuffer({ read: () => 'saved', write: (text) => writes.push(text) })
  assert.equal(buffer.value(), 'saved', 'it starts from the stored draft')
  buffer.flush()
  buffer.set('saved')
  t.mock.timers.tick(300)
  assert.deepEqual(writes, [])
})

test('an emptied draft is written too (the text was deleted)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes = []
  const buffer = createDraftBuffer({ read: () => 'old', write: (text) => writes.push(text) })
  buffer.set('')
  buffer.flush()
  assert.deepEqual(writes, [''])
})

test('adopt takes a change that came from outside (the post cleared the draft) unless a write is waiting', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const buffer = createDraftBuffer({ read: () => '', write: () => {} })
  buffer.set('posted')
  buffer.flush()
  assert.equal(buffer.adopt(''), '', 'cleared from outside: the buffer follows')
  assert.equal(buffer.value(), '')
  assert.equal(buffer.adopt(''), undefined, 'nothing changed')
  buffer.set('typing')
  assert.equal(buffer.adopt('other'), undefined, 'a waiting write wins over an outside change')
  assert.equal(buffer.value(), 'typing')
})

test('dispose flushes the draft (the screen is left) and stops the timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes = []
  const buffer = createDraftBuffer({ read: () => '', write: (text) => writes.push(text) })
  buffer.set('half a thought')
  buffer.dispose()
  t.mock.timers.tick(1000)
  assert.deepEqual(writes, ['half a thought'])
})

// ---- the poll back-off ---------------------------------------------------------------------------------------------------------------------------------

test('pollDelay: 5 s, after 3 unchanged answers 10 s, after 6 20 s', () => {
  assert.deepEqual([0, 1, 2].map(pollDelay), [5000, 5000, 5000])
  assert.deepEqual([3, 4, 5].map(pollDelay), [10_000, 10_000, 10_000])
  assert.deepEqual([6, 7, 50].map(pollDelay), [20_000, 20_000, 20_000])
})

test('pollDelay answers 5 s for anything that is not a count', () => {
  for (const bad of [undefined, null, NaN, -3, 'x']) assert.equal(pollDelay(bad), 5000)
})

// ---- the thread payload and the timeout words -------------------------------------------------------------------------------------------------------------

test('threadPayload carries after when it is given (the newest page only), and not otherwise', () => {
  assert.deepEqual(threadPayload('i1', { after: 12 }), { id: 'i1', limit: 40, after: 12 })
  assert.deepEqual(threadPayload('i1', { after: 0 }), { id: 'i1', limit: 40, after: 0 })
  assert.deepEqual(threadPayload('i1', { after: undefined }), { id: 'i1', limit: 40 })
  assert.deepEqual(threadPayload('i1', { before: 5, after: 12 }), { id: 'i1', limit: 40, before: 5 }, 'a page before a cursor is never an unchanged check')
})

test('a timed out request has its own sentence', () => {
  assert.match(threadErrorText('timeout'), /in time|try again/i)
  assert.notEqual(threadErrorText('timeout'), threadErrorText('nonsense'))
})

// ---- trimming a thread that was left, and the thread limit ----------------------------------------------------------------------------------------

const many = (n, from = 1) => Array.from({ length: n }, (_, k) => m(from + k, k % 2 ? 'assistant' : 'user', 't' + (from + k)))

test('trimThread keeps the newest 40 messages and points Load earlier at the oldest of them', () => {
  assert.equal(PAGE_SIZE, 40)
  const t = thread({ messages: many(100), cursor: 1, hasMore: false })
  const out = trimThread(t)
  assert.deepEqual([out.messages.length, out.messages[0].id, out.messages.at(-1).id], [40, 61, 100])
  assert.deepEqual([out.hasMore, out.cursor], [true, 61])
  assert.equal(out.messages[0], t.messages[60], 'the same objects')
})

test('trimThread keeps pending bubbles after the 40 and leaves a short thread (the very same object) alone', () => {
  const bubble = { ...pendingMessage('later', 5), sent: true }
  const out = trimThread(thread({ messages: [...many(50), bubble] }))
  assert.deepEqual([out.messages.length, out.messages.at(-1)], [41, bubble])
  const short = thread({ messages: many(40), hasMore: true, cursor: 9 })
  assert.equal(trimThread(short), short)
  const bubbles = thread({ messages: [...many(3), bubble] })
  assert.equal(trimThread(bubbles), bubbles)
})

test('touchThreads puts the opened thread last and names what to forget beyond the limit', () => {
  assert.equal(MAX_THREADS, 10)
  assert.deepEqual(touchThreads(['a', 'b', 'c'], 'b', 10), { order: ['a', 'c', 'b'], evict: [] })
  assert.deepEqual(touchThreads(['a', 'b'], 'z', 10), { order: ['a', 'b', 'z'], evict: [] })
  const ten = Array.from({ length: 10 }, (_, k) => 't' + k)
  assert.deepEqual(touchThreads(ten, 'new'), { order: [...ten.slice(1), 'new'], evict: ['t0'] })
  assert.deepEqual(touchThreads(ten, 't0'), { order: [...ten.slice(1), 't0'], evict: [] })
  assert.deepEqual(touchThreads(['a', 'b', 'c', 'd'], 'e', 2), { order: ['d', 'e'], evict: ['a', 'b', 'c'] })
})
