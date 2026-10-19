import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { MAX_KEPT_MESSAGES, MAX_LIMIT, MAX_THREAD_DEPTH, createThreadCache, messagesFromRecords, readThread } from '../thread.js'
import { log, logBytes, tmpRoot, writeLog } from './paused-helpers.mjs'

// Review follow-up (memory): the parsed cache holds one entry per log FILE (replaced when the file changes, never a stale version next to the
// new one) and only the newest MAX_THREAD_DEPTH + MAX_LIMIT + 1 messages of it plus their total count: no page a device may ask for reaches
// further back, so the answers are the ones the whole list would give (docs/mobile.md "Chat thread", "Cost on the PC").
const talk = (n, from = 0) => Array.from({ length: n }, (_, k) => ((from + k) % 2 === 0 ? log.user('u' + (from + k)) : log.assistant('a' + (from + k))))

test('the window is the deepest page a device may ask for plus one more message', () => {
  assert.equal(MAX_KEPT_MESSAGES, MAX_THREAD_DEPTH + MAX_LIMIT + 1)
  assert.equal(MAX_KEPT_MESSAGES, 501)
})

test('the cache keeps one entry per log file: a changed log replaces its entry, it does not add a version', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', [[log.head(), ...talk(4)]])
  const cache = createThreadCache({ throttleMs: 0 })
  await readThread({ root, sessionId: 's1', cache })
  assert.equal(cache.size, 1)
  for (let i = 0; i < 4; i++) {
    appendFileSync(file, logBytes([talk(2, 10 + i * 2)]))
    await readThread({ root, sessionId: 's1', cache })
    assert.equal(cache.size, 1, 'growth ' + i)
  }
  writeLog(root, 's1', [[log.head(), ...talk(3)]]) // a rewrite
  await readThread({ root, sessionId: 's1', cache })
  assert.equal(cache.size, 1)
  const entry = cache.get(file)
  assert.equal(entry.messages.length, 3, 'the entry is the newest version of the file')
})

test('the entry holds at most the newest 501 messages and the total count of the log', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', [[log.head(), ...talk(700)]])
  const cache = createThreadCache({ throttleMs: 0 })
  await readThread({ root, sessionId: 's1', cache })
  const entry = cache.get(file)
  assert.equal(entry.messages.length, 501)
  assert.equal(entry.count, 700)
  assert.deepEqual([entry.messages[0].id, entry.messages.at(-1).id], [200, 700])
})

test('growth keeps the window moving and the count running', async (t) => {
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', [[log.head(), ...talk(600)]])
  const cache = createThreadCache({ throttleMs: 0 })
  await readThread({ root, sessionId: 's1', cache })
  appendFileSync(file, logBytes([talk(50, 600)]))
  await readThread({ root, sessionId: 's1', cache })
  const entry = cache.get(file)
  assert.equal(entry.count, 650)
  assert.deepEqual([entry.messages.length, entry.messages[0].id, entry.messages.at(-1).id], [501, 150, 650])
})

test('every page gives what the whole list gives: newest page, every before, every limit, the deepest page and beyond', async (t) => {
  const records = [log.head(), ...talk(700)]
  const root = tmpRoot(t)
  writeLog(root, 's1', [records])
  const cache = createThreadCache({ throttleMs: 0 })
  const same = async (page) => assert.deepEqual(await readThread({ root, sessionId: 's1', cache, ...page }), { ok: true, ...messagesFromRecords(records, page) }, JSON.stringify(page))
  await same({})
  for (const limit of [1, 2, 40, 99, 100, 101, 1000]) await same({ limit })
  for (const before of [undefined, 701, 700, 699, 400, 301, 300, 299, 250, 201, 200, 199, 101, 100, 50, 2, 1, 0]) {
    for (const limit of [1, 40, 100]) await same({ before, limit })
  }
})

test('the page at the deepest allowed place is full and has an earlier page; the one behind it is empty with no earlier page', async (t) => {
  const root = tmpRoot(t)
  writeLog(root, 's1', [[log.head(), ...talk(700)]])
  const cache = createThreadCache({ throttleMs: 0 })
  const deepest = await readThread({ root, sessionId: 's1', cache, before: 301, limit: 100 }) // 400 messages (301..700) are newer
  assert.deepEqual([deepest.messages.length, deepest.messages[0].id, deepest.hasMore], [100, 201, true])
  assert.deepEqual(await readThread({ root, sessionId: 's1', cache, before: 300, limit: 100 }), { ok: true, messages: [], hasMore: false })
})

test('a window that fills up through growth gives the same pages as a log read in one go', async (t) => {
  const records = [log.head(), ...talk(900)]
  const root = tmpRoot(t)
  const file = writeLog(root, 's1', [records.slice(0, 301)])
  const cache = createThreadCache({ throttleMs: 0 })
  for (const to of [301, 520, 777, 901]) {
    if (to > 301) appendFileSync(file, logBytes([records.slice(Math.min(to === 520 ? 301 : to === 777 ? 520 : 777, to), to)]))
    for (const page of [{}, { before: 600, limit: 100 }, { before: 400, limit: 40 }, { before: 5, limit: 100 }]) {
      assert.deepEqual(await readThread({ root, sessionId: 's1', cache, ...page }), { ok: true, ...messagesFromRecords(records.slice(0, to), page) }, 'to ' + to + ' ' + JSON.stringify(page))
    }
  }
})
