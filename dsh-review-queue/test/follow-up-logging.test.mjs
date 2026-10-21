import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { listFollowUpSessions, snippetsFromThread } from '../follow-up.js'
import { createFollowUps } from '../todo-follow-up.js'

// The silent catches of the follow-up path leave a trace in the log (the injected log, so review-queue.log): the code or name of the error only, never its message,
// which can carry a path or content. A pass that loses several snippets logs once.

const fail = (code, message = 'secret D:\\users\\x\\token') => Object.assign(new Error(message), { code })
const allText = (lines) => lines.join('\n')

test('service: a controller or a registry that throws when asked is logged by code, and the list is still given (empty without a controller)', async () => {
  const logs = []
  const queue = createReviewQueue({
    store: createStore(), capture: {}, log: (line) => logs.push(line),
    controllerOf: () => { throw fail('EDEAD') },
    registryOf: () => { throw fail('EREG') },
  })
  assert.deepEqual(await queue.followUpSessions(), [])
  assert.equal(logs.filter((l) => /controller/.test(l) && /EDEAD/.test(l)).length, 1, allText(logs))
  assert.equal(logs.filter((l) => /registry/.test(l) && /EREG/.test(l)).length, 1, allText(logs))
  assert.doesNotMatch(allText(logs), /secret|token/)
})

test('service: a healthy controller and registry log nothing', async () => {
  const logs = []
  const queue = createReviewQueue({ store: createStore(), capture: {}, log: (line) => logs.push(line), controllerOf: () => ({ list: async () => ({ items: [] }) }), registryOf: () => ({ list: () => [], archivedSessionIds: [] }) })
  await queue.followUpSessions()
  assert.deepEqual(logs, [])
})

test('service: without a log nothing throws', async () => {
  const queue = createReviewQueue({ store: createStore(), capture: {}, controllerOf: () => { throw fail('EDEAD') } })
  assert.deepEqual(await queue.followUpSessions(), [])
})

test('listFollowUpSessions: an archived-session list that throws when read is logged by code, once, and the sessions are still given', async () => {
  const logs = []
  const registry = { list: () => [], get archivedSessionIds() { throw fail('EARCH') } }
  const controller = { list: async () => ({ items: [{ sessionId: 's1', updatedAt: 5, running: false, blank: false }] }) }
  const out = await listFollowUpSessions({ controller, registry, log: (line) => logs.push(line) })
  assert.deepEqual(out.map((c) => c.sessionId), ['s1'])
  assert.equal(logs.length, 1, allText(logs))
  assert.match(logs[0], /^follow-up: .*archived.*EARCH/)
  assert.doesNotMatch(allText(logs), /secret|token/)
})

test('snippetsFromThread: sessions that cannot be read log ONE line for the pass (how many, the first code), and a new pass logs again', async () => {
  const logs = []
  const read = snippetsFromThread(async ({ sessionId }) => { if (sessionId === 'ok') return { ok: true, messages: [{ text: 'hi' }] }; throw fail('ENOENT') }, { log: (line) => logs.push(line) })
  const out = await read(['a', 'ok', 'b', 'c'])
  assert.deepEqual([...out.keys()], ['ok'])
  assert.equal(logs.length, 1, allText(logs))
  assert.match(logs[0], /^follow-up: snippets: 3 of 4 session\(s\) could not be read \(ENOENT\)$/)
  assert.doesNotMatch(allText(logs), /secret|token/)
  await read(['d'])
  assert.equal(logs.length, 2)
})

test('snippetsFromThread: a pass without failures, or one that reads nothing because the session has no messages, logs nothing', async () => {
  const logs = []
  const read = snippetsFromThread(async () => ({ ok: true, messages: [] }), { log: (line) => logs.push(line) })
  await read(['a', 'b'])
  assert.deepEqual(logs, [])
})

test('listFollowUpSessions hands its log to the snippet reader: the reader built without one still reports through the caller\'s', async () => {
  const logs = []
  const controller = { list: async () => ({ items: [{ sessionId: 's1', updatedAt: 5, running: false, blank: false }] }) }
  const snippetsOf = snippetsFromThread(async () => { throw fail('EBUSY') })
  await listFollowUpSessions({ controller, registry: { list: () => [], archivedSessionIds: [] }, snippetsOf, log: (line) => logs.push(line) })
  assert.equal(logs.filter((l) => /snippets/.test(l) && /EBUSY/.test(l)).length, 1, allText(logs))
})

// ---- a secret-looking error message never reaches the log of the follow-up path: the code or the name, nothing else ----

const SECRET = 'C:\\Users\\arnold\\.secrets\\token-ABC123 refused'

test('listFollowUpSessions: a titles reader, a snippet reader or a session list that fails with a secret-looking message logs the code or name only', async () => {
  for (const [what, make, label] of [
    ['titles', (log) => ({ controller: { list: async () => ({ items: [{ sessionId: 's1', updatedAt: 5, running: false, blank: false }] }) }, titlesOf: async () => { throw fail('ETITLES', SECRET) }, log }), 'ETITLES'],
    ['snippets', (log) => ({ controller: { list: async () => ({ items: [{ sessionId: 's1', updatedAt: 5, running: false, blank: false }] }) }, snippetsOf: async () => { throw new TypeError(SECRET) }, log }), 'TypeError'],
    ['list', (log) => ({ controller: { list: async () => { throw fail('ELIST', SECRET) } }, log }), 'ELIST'],
  ]) {
    const logs = []
    await listFollowUpSessions(make((line) => logs.push(line)))
    assert.ok(logs.some((l) => l.includes(label)), what + ': ' + allText(logs))
    assert.doesNotMatch(allText(logs), /secret|token|ABC123|arnold/i, what)
  }
})

test('todo-follow-up: the sessions of this app that cannot be read are logged by code or name only', async () => {
  for (const [error, label] of [[fail('EREAD', SECRET), 'EREAD'], [new RangeError(SECRET), 'RangeError']]) {
    const logs = []
    const store = createStore()
    const tracked = []
    const followUps = createFollowUps({ store, controllerOf: () => undefined, sessionsOf: async () => { throw error }, timeoutMs: 40, track: (p) => tracked.push(p), log: (line) => logs.push(line) })
    followUps.add('message', 'the words')
    await Promise.all(tracked)
    assert.ok(logs.some((l) => l.includes(label)), allText(logs))
    assert.doesNotMatch(allText(logs), /secret|token|ABC123|arnold/i)
  }
})
