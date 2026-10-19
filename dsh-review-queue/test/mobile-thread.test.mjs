import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAGE_SIZE, POLL_MS, SENT_BUBBLE_MS, applyEarlier, applyNewest, canPost, expirePending, hasThread, isNearBottom, markSent, mergeMessages, pendingMessage, postErrorText,
  newPostKey, postKeyFor, postPayload, reconcile, removeMessage, scrollPlan, shouldPoll, threadErrorText, threadPayload,
} from '../lib/mobile/thread.js'

// The pure part of the phone's chat view (docs/mobile.md "Chat thread"): merging pages and polls, the optimistic bubble, the words of the
// errors, the rules for polling and scrolling. No DOM, no state, no network.
const m = (id, role = 'assistant', text = 't' + id, extra = {}) => ({ id, role, text, ...extra })

// ---- constants --------------------------------------------------------------------------------------------------------------------

test('the page is 40 messages and the chat refreshes every 5 seconds', () => {
  assert.equal(PAGE_SIZE, 40)
  assert.equal(POLL_MS, 5000)
})

// ---- mergeMessages ----------------------------------------------------------------------------------------------------------------

test('merging keeps the messages ascending by id and drops duplicates (the newer copy wins)', () => {
  const merged = mergeMessages([m(3), m(5), m(7)], [m(1), m(5, 'assistant', 'edited'), m(9)])
  assert.deepEqual(merged.map((x) => x.id), [1, 3, 5, 7, 9])
  assert.equal(merged.find((x) => x.id === 5).text, 'edited')
})

test('merging into nothing, or with nothing, gives the other list', () => {
  assert.deepEqual(mergeMessages(undefined, [m(2), m(1)]).map((x) => x.id), [1, 2])
  assert.deepEqual(mergeMessages([m(1)], undefined).map((x) => x.id), [1])
  assert.deepEqual(mergeMessages(undefined, undefined), [])
})

test('pending local messages stay last, in the order they were typed, whatever the ids around them', () => {
  const p1 = pendingMessage('one', 10)
  const p2 = pendingMessage('two', 11)
  const merged = mergeMessages([m(4), p1, p2], [m(2), m(6)])
  assert.deepEqual(merged.map((x) => x.id), [2, 4, 6, p1.id, p2.id])
})

test('merging does not change its inputs', () => {
  const a = [m(2), m(1)]
  const b = [m(3)]
  mergeMessages(a, b)
  assert.deepEqual(a.map((x) => x.id), [2, 1])
  assert.deepEqual(b.map((x) => x.id), [3])
})

// ---- pendingMessage / reconcile ---------------------------------------------------------------------------------------------------

test('a pending message is a local user bubble with an id that cannot clash with the log ids', () => {
  const p = pendingMessage('hello', 1234)
  assert.match(p.id, /^p-\d+$/)
  assert.deepEqual([p.role, p.text, p.pending, p.time], ['user', 'hello', true, 1234])
  assert.notEqual(pendingMessage('hello', 1234).id, p.id, 'every one has its own id')
})

test('when the sent text arrives from the log, its pending bubble is dropped', () => {
  const p = pendingMessage('please fix it', 5)
  const out = reconcile([m(1), p], [m(1), m(2, 'assistant'), m(3, 'user', 'please fix it')])
  assert.deepEqual(out.map((x) => x.id), [1, 2, 3])
  assert.equal(out.some((x) => x.pending), false)
})

test('a pending bubble stays until a NEW user message with the same text shows up: an old identical message does not count, nor does an assistant one', () => {
  const p = pendingMessage('ok', 5)
  const existing = [m(1, 'user', 'ok'), p]
  assert.deepEqual(reconcile(existing, [m(1, 'user', 'ok'), m(2, 'assistant', 'ok')]).map((x) => x.id), [1, 2, p.id])
})

test('the same text sent twice: each arrival drops one pending bubble, no more', () => {
  const a = pendingMessage('again', 1)
  const b = pendingMessage('again', 2)
  const out = reconcile([a, b], [m(7, 'user', 'again')])
  assert.deepEqual(out.map((x) => x.id), [7, b.id])
})

test('reconcile compares trimmed text and keeps other pending bubbles', () => {
  const a = pendingMessage('  hi there ', 1)
  const b = pendingMessage('other', 2)
  assert.deepEqual(reconcile([a, b], [m(4, 'user', 'hi there')]).map((x) => x.id), [4, b.id])
})

test('removeMessage takes one message out by id (a failed post removes its bubble)', () => {
  const p = pendingMessage('x', 1)
  assert.deepEqual(removeMessage([m(1), p], p.id).map((x) => x.id), [1])
  assert.deepEqual(removeMessage([m(1)], 'nope').map((x) => x.id), [1])
  assert.deepEqual(removeMessage(undefined, 'nope'), [])
})

// ---- payloads ---------------------------------------------------------------------------------------------------------------------

test('threadPayload asks for a page of 40, and for the page before a cursor when there is one', () => {
  assert.deepEqual(threadPayload('i1'), { id: 'i1', limit: 40 })
  assert.deepEqual(threadPayload('i1', { before: 12 }), { id: 'i1', limit: 40, before: 12 })
  assert.deepEqual(threadPayload('i1', { before: 0 }), { id: 'i1', limit: 40, before: 0 })
  assert.deepEqual(threadPayload('i1', { before: undefined }), { id: 'i1', limit: 40 })
})

test('postPayload sends the trimmed text, and the key when one is given', () => {
  assert.deepEqual(postPayload('i1', '  hello  \n'), { id: 'i1', text: 'hello' })
  assert.deepEqual(postPayload('i1', '  hello  \n', 'k-1'), { id: 'i1', text: 'hello', key: 'k-1' })
})

test('newPostKey makes a key the server accepts (1 to 64 of letters, digits, _ and -), a different one every time, with or without crypto.randomUUID', (t) => {
  const ok = /^[A-Za-z0-9_-]{1,64}$/
  const a = newPostKey()
  assert.match(a, ok)
  assert.notEqual(a, newPostKey())
  t.mock.method(globalThis.crypto, 'randomUUID', () => { throw new Error('unavailable') })
  const b = newPostKey()
  assert.match(b, ok)
  assert.notEqual(b, newPostKey())
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
  try { assert.match(newPostKey(), ok) } finally { Object.defineProperty(globalThis, 'crypto', saved) }
})

test('postKeyFor keeps the key of the same text and makes a new one when the text changed or nothing was kept', () => {
  let n = 0
  const make = () => 'key' + ++n
  const first = postKeyFor(undefined, 'hello', make)
  assert.deepEqual(first, { text: 'hello', key: 'key1' })
  assert.equal(postKeyFor(first, 'hello', make), first, 'a retry of the same text reuses the entry')
  assert.deepEqual(postKeyFor(first, 'hello!', make), { text: 'hello!', key: 'key2' })
})

// ---- error words ------------------------------------------------------------------------------------------------------------------

test('every thread error code of the server has its own sentence; an unknown code gets the generic one', () => {
  const codes = ['not-found', 'no-session', 'no-log', 'too-large', 'no-zstd', 'unreadable', 'no-reader', 'owner-offline', 'owner-away', 'owner-timeout', 'unknown-outcome', 'session-unavailable', 'offline']
  const texts = codes.map((c) => threadErrorText(c))
  for (const t of texts) assert.match(t, /^[A-Z].*[.!?]$/, t)
  assert.equal(new Set(texts).size, codes.length, 'all different')
  const generic = threadErrorText('something-new')
  assert.match(generic, /could not load/i)
  assert.equal(threadErrorText(undefined), generic)
  assert.equal(threadErrorText(null), generic)
  assert.ok(!texts.includes(generic))
})

test('the sentences name the real cause: the log is not on this PC, too big, the app is not running', () => {
  assert.match(threadErrorText('no-log'), /log/i)
  assert.match(threadErrorText('too-large'), /too (big|large|long)/i)
  assert.match(threadErrorText('owner-offline'), /not running/i)
  assert.match(threadErrorText('owner-timeout'), /try again/i)
  assert.match(threadErrorText('offline'), /offline|connection/i)
})

test('postErrorText words the codes of a failed post and leaves the rest to the shared errorText', () => {
  assert.match(postErrorText('not-a-session'), /not a session|no session|cannot/i)
  assert.match(postErrorText('no-session'), /not running|not available|no longer/i)
  assert.match(postErrorText('session-unavailable'), /not available|not running/i)
  assert.match(postErrorText('post-failed'), /could not be sent|try again/i, 'the fixed code the server gives for any other failure of the controller')
  assert.match(threadErrorText('session-unavailable'), /not available|not running/i)
  assert.equal(postErrorText('empty'), undefined)
  assert.equal(postErrorText('owner-offline'), undefined)
  assert.equal(postErrorText(undefined), undefined)
})

test('postErrorText words paused (resume it at the PC) and busy (a post is already on its way)', () => {
  assert.match(postErrorText('paused'), /Resume it at the PC first\./)
  assert.match(postErrorText('busy'), /already|wait|try again/i)
})

test('threadErrorText words busy for a thread read the PC could not take on at the moment', () => {
  assert.match(threadErrorText('busy'), /busy|try again/i)
})

test('every item with a session has a conversation to read, a paused one too, except a todo', () => {
  for (const type of ['question', 'permission', 'completed', 'pr-merged', 'paused']) assert.equal(hasThread({ type, sessionId: 's' }), true, type)
  assert.equal(hasThread({ type: 'todo', sessionId: 's' }), false)
  assert.equal(hasThread({ type: 'completed' }), false)
  assert.equal(hasThread({ type: 'completed', sessionId: '' }), false)
  assert.equal(hasThread({ type: 'completed', sessionId: 7 }), false)
  assert.equal(hasThread(undefined), false)
  assert.equal(hasThread(null), false)
})

// ---- canPost / shouldPoll ---------------------------------------------------------------------------------------------------------

test('every item with a session can be written to, except a todo and a paused one (resuming that is done at the PC)', () => {
  for (const type of ['question', 'permission', 'completed', 'pr-merged']) assert.equal(canPost({ type, sessionId: 's' }), true, type)
  assert.equal(canPost({ type: 'paused', sessionId: 's' }), false)
  assert.equal(canPost({ type: 'todo', sessionId: 's' }), false)
  assert.equal(canPost({ type: 'completed' }), false)
  assert.equal(canPost({ type: 'completed', sessionId: '' }), false)
  assert.equal(canPost({ type: 'completed', sessionId: 7 }), false)
  assert.equal(canPost(undefined), false)
  assert.equal(canPost(null), false)
})

test('the chat polls only on the screen of a session item, while the page is visible and nothing pauses it', () => {
  const base = { route: '/item/abc', visible: true, item: { type: 'completed', sessionId: 's' }, paused: false }
  assert.equal(shouldPoll(base), true)
  assert.equal(shouldPoll({ ...base, visible: false }), false)
  assert.equal(shouldPoll({ ...base, paused: true }), false)
  assert.equal(shouldPoll({ ...base, route: '/' }), false)
  assert.equal(shouldPoll({ ...base, route: '/resolved' }), false)
  assert.equal(shouldPoll({ ...base, route: '/new' }), false)
  assert.equal(shouldPoll({ ...base, item: undefined }), false)
  assert.equal(shouldPoll({ ...base, item: { type: 'todo', sessionId: 's' } }), false)
  assert.equal(shouldPoll({ ...base, item: { type: 'completed' } }), false)
})

test('the chat of a paused item is read and polled even though it takes no post', () => {
  assert.equal(shouldPoll({ route: '/item/abc', visible: true, item: { type: 'paused', sessionId: 's' }, paused: false }), true)
})

// ---- scrolling --------------------------------------------------------------------------------------------------------------------

test('near the bottom means within 80 px of the end', () => {
  assert.equal(isNearBottom({ scrollTop: 920, clientHeight: 500, scrollHeight: 1500 }), true) // 80 px left
  assert.equal(isNearBottom({ scrollTop: 919, clientHeight: 500, scrollHeight: 1500 }), false)
  assert.equal(isNearBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 400 }), true, 'nothing to scroll')
})

test('new messages scroll to the bottom when the reader was near it or just posted, else a pill offers them', () => {
  assert.deepEqual(scrollPlan({ wasNearBottom: true, added: 2 }), { stick: true, pill: 0 })
  assert.deepEqual(scrollPlan({ wasNearBottom: false, added: 2, posted: true }), { stick: true, pill: 0 })
  assert.deepEqual(scrollPlan({ wasNearBottom: false, added: 3 }), { stick: false, pill: 3 })
  assert.deepEqual(scrollPlan({ wasNearBottom: false, added: 0 }), { stick: false, pill: 0 })
  assert.deepEqual(scrollPlan({ wasNearBottom: true, added: 0 }), { stick: false, pill: 0 }, 'nothing new: nothing to do')
})

// ---- applying a page or a poll to what is shown --------------------------------------------------------------------------------------

const view = (messages, hasMore = false, cursor) => ({ messages, hasMore, cursor })
const page = (messages, hasMore = false, cursor) => ({ messages, hasMore, ...(cursor === undefined ? {} : { cursor }) })

test('the first page of an empty chat is shown as it came, with its hasMore and cursor', () => {
  assert.deepEqual(applyNewest(view([]), page([m(8), m(9)], true, 8)), view([m(8), m(9)], true, 8))
})

test('a poll adds the new messages and keeps the older pages and the cursor the reader already has', () => {
  const shown = view([m(1), m(2), m(3)], true, 1)
  const out = applyNewest(shown, page([m(2), m(3), m(4)], true, 2))
  assert.deepEqual(out.messages.map((x) => x.id), [1, 2, 3, 4])
  assert.deepEqual([out.hasMore, out.cursor], [true, 1])
})

test('a poll that finds more than a page of new messages shows only that page (no hole in the middle) and offers Load earlier', () => {
  const shown = view([m(1), m(2), m(3)], false, 1)
  const out = applyNewest(shown, page([m(50), m(51)], true, 50))
  assert.deepEqual(out.messages.map((x) => x.id), [50, 51])
  assert.deepEqual([out.hasMore, out.cursor], [true, 50])
})

test('a poll keeps the pending bubbles and settles the ones that arrived', () => {
  const p = pendingMessage('hello', 1)
  const q = pendingMessage('later', 2)
  const out = applyNewest(view([m(1), p, q], false, 1), page([m(1), m(2, 'user', 'hello')], false, 1))
  assert.deepEqual(out.messages.map((x) => x.id), [1, 2, q.id])
})

test('an empty poll changes nothing', () => {
  const shown = view([m(1)], true, 1)
  assert.deepEqual(applyNewest(shown, page([])), shown)
})

test('an earlier page goes in front; hasMore and the cursor follow the page', () => {
  const out = applyEarlier(view([m(5), m(6)], true, 5), page([m(3), m(4)], true, 3))
  assert.deepEqual(out.messages.map((x) => x.id), [3, 4, 5, 6])
  assert.deepEqual([out.hasMore, out.cursor], [true, 3])
  const last = applyEarlier(out, page([m(1), m(2)], false, 1))
  assert.deepEqual([last.messages.length, last.hasMore, last.cursor], [6, false, 1])
})

test('an empty earlier page ends the paging and keeps the cursor', () => {
  assert.deepEqual(applyEarlier(view([m(5)], true, 5), page([], false)), view([m(5)], false, 5))
})

test('a pending bubble that was sent is marked, and is dropped when it is old and the log never showed it', () => {
  const p = pendingMessage('x', 1000)
  const sent = markSent([m(1), p], p.id)
  assert.equal(sent.find((x) => x.id === p.id).sent, true)
  assert.equal(markSent([m(1)], 'nope').length, 1)
  assert.equal(expirePending(sent, 1000 + 121_000).length, 2, 'a queued prompt can take longer than two minutes to reach the log')
  assert.equal(expirePending(sent, 1000 + 14 * 60_000 + 59_000).length, 2, 'fifteen minutes are not over yet')
  assert.deepEqual(expirePending(sent, 1000 + 15 * 60_000 + 1).map((x) => x.id), [1])
})

test('a sent bubble is kept for 15 minutes (SENT_BUBBLE_MS)', () => {
  assert.equal(SENT_BUBBLE_MS, 15 * 60_000)
})

test('a pending bubble that was not sent yet is never expired', () => {
  const p = pendingMessage('x', 1000)
  assert.equal(expirePending([p], 1000 + 10 * 60_000).length, 1)
})
