import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_THREAD_DEPTH, findSessionLog, isSessionId, messagesFromRecords, readThread, createThreadCache } from '../thread.js'
import { log, tmpRoot, writeLog } from './paused-helpers.mjs'

// The thread of a session as a chat: the text of user and assistant messages, read from the session log (docs/mobile.md "Chat thread").
const asst = (parts, time) => ({ type: 'assistant/message', time, data: { message: { role: 'assistant', content: parts } } })
const text = (t) => ({ type: 'text', text: t })
/** n alternating user / assistant text records after a head: the id of message k is k + 1. */
const talk = (n) => [log.head(), ...Array.from({ length: n }, (_, k) => (k % 2 === 0 ? log.user('u' + k) : log.assistant('a' + k)))]

// ---- messagesFromRecords ----------------------------------------------------------------------------------------------------------

test('user and assistant text become messages whose id is the index of the record in the log, with the record time', () => {
  const user = { ...log.user('Fix the build'), time: 111 }
  const reply = { ...log.assistant('Done.'), time: 222 }
  const r = messagesFromRecords([log.head(), user, reply])
  assert.deepEqual(r, { messages: [{ id: 1, role: 'user', text: 'Fix the build', time: 111 }, { id: 2, role: 'assistant', text: 'Done.', time: 222 }], hasMore: false, cursor: 1 })
})

test('a record without a time gives a message without a time field', () => {
  const r = messagesFromRecords([{ type: 'user/message', data: { content: [text('hi')] } }])
  assert.deepEqual(r.messages, [{ id: 0, role: 'user', text: 'hi' }])
})

test('hook, system and other non-user sources are not part of the chat; a user message without a source is', () => {
  const records = [
    log.user('from the user', { kind: 'user' }),
    { type: 'user/message', data: { content: [text('no source')] } },
    log.user('hook says', { kind: 'plugin:hooks-tts' }),
    log.user('cwd changed', { kind: 'working-directory' }),
  ]
  assert.deepEqual(messagesFromRecords(records).messages.map((m) => m.text), ['from the user', 'no source'])
})

test('a surface replacement is not a message: the record that stands in for older ones (surfaceOp replace) gives no bubble, an append does', () => {
  // The shape DSH logs: the envelope of the record carries surfaceOp (the string 'append', or { op: 'replace', startSeq, endSeq } for a replacement).
  const replace = { op: 'replace', startSeq: 3, endSeq: 9 }
  const inData = (r) => ({ ...r, data: { ...r.data, surfaceOp: replace } })
  const records = [
    { ...log.user('kept user'), surfaceOp: 'append' },
    { ...log.user('replaced user'), surfaceOp: replace },
    { ...log.assistant('replaced assistant'), surfaceOp: replace },
    inData(log.user('replaced in data')),
    inData(log.assistant('replaced assistant in data')),
    { ...log.assistant('kept assistant'), surfaceOp: 'append' },
    log.user('no surfaceOp at all'),
  ]
  assert.deepEqual(messagesFromRecords(records).messages.map((m) => m.text), ['kept user', 'kept assistant', 'no surfaceOp at all'])
})

test('tool calls, tool results and thinking are skipped; text parts of one assistant message are joined with a blank line', () => {
  const records = [
    asst([{ type: 'thinking', text: 'secret thoughts' }, text('First.'), { type: 'tool-call', id: 'c1', name: 'shell', arguments: '{}' }, text('Second.')]),
    log.result('c1'),
    asst([{ type: 'tool-call', id: 'c2', name: 'shell', arguments: '{}' }]),
    log.stepEnd(),
  ]
  const r = messagesFromRecords(records)
  assert.deepEqual(r.messages.map((m) => [m.id, m.role, m.text]), [[0, 'assistant', 'First.\n\nSecond.']])
})

test('empty and whitespace-only text is skipped, malformed records are ignored', () => {
  const records = [null, 'x', {}, { type: 'user/message' }, { type: 'user/message', data: { content: 'plain string' } }, log.user('   '), asst([text('')]), asst('nope'), log.user('real')]
  assert.deepEqual(messagesFromRecords(records).messages.map((m) => m.text), ['real'])
})

test('a text over 4000 characters is cut and marked truncated; exactly 4000 is kept whole', () => {
  const r = messagesFromRecords([log.user('x'.repeat(4000)), log.assistant('y'.repeat(4001))])
  assert.deepEqual([r.messages[0].text.length, r.messages[0].truncated], [4000, undefined])
  assert.deepEqual([r.messages[1].text.length, r.messages[1].truncated], [4000, true])
})

test('no records, or none with text, is an empty thread without a cursor', () => {
  assert.deepEqual(messagesFromRecords([]), { messages: [], hasMore: false })
  assert.deepEqual(messagesFromRecords([log.head(), log.turnStart(1)]), { messages: [], hasMore: false })
})

test('only the newest 40 messages are returned, ascending, with hasMore and the id of the oldest as the cursor', () => {
  const r = messagesFromRecords(talk(50))
  assert.equal(r.messages.length, 40)
  assert.deepEqual([r.messages[0].id, r.messages.at(-1).id], [11, 50])
  assert.deepEqual([r.hasMore, r.cursor], [true, 11])
  assert.ok(r.messages.every((m, i, all) => i === 0 || m.id > all[i - 1].id), 'ascending')
})

test('exactly 40 messages have no earlier page', () => {
  const r = messagesFromRecords(talk(40))
  assert.deepEqual([r.messages.length, r.hasMore, r.cursor], [40, false, 1])
})

test('before pages back without overlap: the cursor of one page is the before of the next, until the start', () => {
  const records = talk(50)
  const first = messagesFromRecords(records)
  const second = messagesFromRecords(records, { before: first.cursor })
  assert.deepEqual([second.messages.map((m) => m.id), second.hasMore, second.cursor], [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], false, 1])
  assert.deepEqual(messagesFromRecords(records, { before: 1 }), { messages: [], hasMore: false })
})

test('limit is clamped to 1..100 and falls back to 40 when it is not a finite number', () => {
  const records = talk(150)
  const n = (limit) => messagesFromRecords(records, { limit }).messages.length
  assert.deepEqual([n(0), n(-5), n(1), n(500), n(100)], [1, 1, 1, 100, 100])
  assert.deepEqual([n(undefined), n(NaN), n(Infinity), n('5'), n(null)], [40, 40, 40, 40, 40])
  assert.equal(n(2.9), 2)
})

test('before is ignored unless it is a finite number', () => {
  const records = talk(50)
  for (const before of ['10', NaN, Infinity, null, undefined, {}]) assert.equal(messagesFromRecords(records, { before }).messages.at(-1).id, 50, String(before))
})

// ---- findSessionLog ---------------------------------------------------------------------------------------------------------------

test('the log of a session is found in whichever project folder holds it', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 'abc-1', [[log.head()]], { cwdDir: '--D-one--' })
  const file = writeLog(root, 'abc-2', [[log.head()]], { cwdDir: '--D-two--' })
  assert.equal(await findSessionLog(root, 'abc-2'), file)
  assert.equal(await findSessionLog(root, 'nope'), undefined)
})

test('a session id in several project folders gives the most recently written log', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', [[log.head()]], { cwdDir: '--old--', mtimeMs: 1_000_000 })
  const newer = writeLog(root, 's1', [[log.head()]], { cwdDir: '--new--', mtimeMs: 9_000_000 })
  assert.equal(await findSessionLog(root, 's1'), newer)
})

test('a session id that could leave the sessions folder is refused without touching the disk', async () => {
  const touched = []
  const io = { readdir: async (...a) => { touched.push(a); return [] }, stat: async (...a) => { touched.push(a); return {} } }
  for (const bad of ['../x', 'a/b', 'a\\b', '', '.', '..', 'x'.repeat(129), 'a b', 'a\u0000b', undefined, 42, null]) {
    assert.equal(await findSessionLog('/root', bad, io), undefined, JSON.stringify(bad))
  }
  assert.deepEqual(touched, [])
})

test('ids start with a letter or digit and go on with letters, digits, dash and underscore, up to 128 characters', async () => {
  const io = { readdir: async () => [{ name: 'p', isDirectory: () => true }], stat: async () => ({ mtimeMs: 1, size: 1 }) }
  for (const ok of ['a', 'A_b-c9', '9abc', 'x'.repeat(128)]) assert.ok(await findSessionLog('/root', ok, io), ok)
  for (const bad of ['.hidden', 'a.b', 'a..b', 'a.', 'a ', '-x', '_x', 'x'.repeat(129)]) assert.equal(await findSessionLog('/root', bad, io), undefined, JSON.stringify(bad))
})

test('isSessionId is the one validator of a session id (thread.js and the service fallback share it)', () => {
  for (const ok of ['a', 'abc-123_X', '0f8fad5b-d9cb-469f-a165-70867728950e']) assert.equal(isSessionId(ok), true, ok)
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a.', 'a ', 'a\u0000b', 'x'.repeat(129), undefined, null, 42, {}, ['s']]) assert.equal(isSessionId(bad), false, JSON.stringify(bad))
})

test('a sessions folder that cannot be read has no log', async () => {
  const io = { readdir: async () => { throw new Error('ENOENT') }, stat: async () => ({}) }
  assert.equal(await findSessionLog('/root', 's1', io), undefined)
})

// ---- readThread -------------------------------------------------------------------------------------------------------------------

const session = () => [[log.head(), log.turnStart(1), log.user('hello'), log.assistant('hi there', [['c1', 'shell']]), log.result('c1')], [log.user('thanks'), log.assistant('welcome'), log.turnEnd(1)]]

test('a session log on disk is read into the chat messages, across zstd frames', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', session())
  const r = await readThread({ root, sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.messages.map((m) => [m.role, m.text]), [['user', 'hello'], ['assistant', 'hi there'], ['user', 'thanks'], ['assistant', 'welcome']])
  assert.deepEqual([r.hasMore, r.cursor], [false, r.messages[0].id])
})

test('before and limit page the thread read from disk', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', session())
  const last = await readThread({ root, sessionId: 's1', limit: 2 })
  assert.deepEqual([last.messages.map((m) => m.text), last.hasMore], [['thanks', 'welcome'], true])
  const earlier = await readThread({ root, sessionId: 's1', limit: 2, before: last.cursor })
  assert.deepEqual([earlier.messages.map((m) => m.text), earlier.hasMore], [['hello', 'hi there'], false])
})

test('a log whose last frame is half written still gives what was read', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', session(), { tornTail: 6 })
  const r = await readThread({ root, sessionId: 's1' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.messages.map((m) => m.text), ['hello', 'hi there'])
})

test('failures are named: no-log, too-large, no-zstd, unreadable', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', session())
  assert.deepEqual(await readThread({ root, sessionId: 'missing' }), { ok: false, error: 'no-log' })
  assert.deepEqual(await readThread({ root, sessionId: '../s1' }), { ok: false, error: 'no-log' })
  assert.deepEqual(await readThread({ root, sessionId: 's1', maxLogBytes: 10 }), { ok: false, error: 'too-large' })
  assert.deepEqual(await readThread({ root, sessionId: 's1', unzip: null }), { ok: false, error: 'no-zstd' })
  const broken = { readFile: async () => { throw new Error('EBUSY') } }
  assert.deepEqual(await readThread({ root, sessionId: 's1', fs: broken }), { ok: false, error: 'unreadable' })
  const boom = () => { throw new Error('bad frame') }
  assert.deepEqual(await readThread({ root, sessionId: 's1', unzip: boom }), { ok: true, messages: [], hasMore: false }, 'frames that cannot be decoded are a torn log with nothing in it')
})

test('the default size limit is 8 MiB (the thread is refreshed often; thread-cache.test.mjs covers the cache)', async () => {
  const fs = { readdir: async () => [{ name: 'p', isDirectory: () => true }], stat: async () => ({ mtimeMs: 1, size: 8 * 1024 * 1024 + 1 }), readFile: async () => Buffer.alloc(0) }
  assert.deepEqual(await readThread({ root: '/r', sessionId: 's', fs }), { ok: false, error: 'too-large' })
  const small = { ...fs, stat: async () => ({ mtimeMs: 1, size: 8 * 1024 * 1024 }) }
  assert.equal((await readThread({ root: '/r', sessionId: 's', fs: small })).ok, true)
})

// ---- the paging depth: a device cannot dump a whole transcript --------------------------------------------------------------------------

test('MAX_THREAD_DEPTH is 400', () => {
  assert.equal(MAX_THREAD_DEPTH, 400)
})

test('a before cursor more than 400 messages behind the newest gives an empty, error-free page; 400 behind is still served', () => {
  const records = talk(500) // message ids 1..500
  const edge = messagesFromRecords(records, { before: 101, limit: 10 }) // 400 messages (101..500) are newer than the page
  assert.deepEqual(edge.messages.map((m) => m.id), [91, 92, 93, 94, 95, 96, 97, 98, 99, 100])
  assert.equal(edge.hasMore, true)
  assert.deepEqual(messagesFromRecords(records, { before: 100, limit: 10 }), { messages: [], hasMore: false })
  assert.deepEqual(messagesFromRecords(records, { before: 2, limit: 100 }), { messages: [], hasMore: false })
})

test('the depth cap does not touch the newest page, a short thread or a missing before', () => {
  assert.equal(messagesFromRecords(talk(500)).messages.at(-1).id, 500)
  assert.equal(messagesFromRecords(talk(500), { before: undefined, limit: 100 }).messages.length, 100)
  assert.equal(messagesFromRecords(talk(300), { before: 5, limit: 100 }).messages.length, 4)
})

test('a thread read from disk stops paging back 400 messages behind the newest, and answers ok, not an error', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', [talk(500)])
  const cache = createThreadCache({ throttleMs: 0 })
  assert.equal((await readThread({ root, sessionId: 's1', before: 101, limit: 10, cache })).messages.length, 10)
  assert.deepEqual(await readThread({ root, sessionId: 's1', before: 100, limit: 10, cache }), { ok: true, messages: [], hasMore: false })
})
