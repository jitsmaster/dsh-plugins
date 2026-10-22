import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createIdleAsker, createSleepTracker, ASK_PROMPT } from '../idle-ask.js'

const H = 3600_000
const memIo = () => { const io = { text: undefined, read: () => io.text, write: (t) => { io.text = t } }; return io }
const rig = (items, extra = {}) => {
  const prompts = []
  const archived = []
  let t = 10 * H
  const store = createStore()
  const asker = createIdleAsker({
    controllerOf: () => ({ list: async () => ({ items }), prompt: async (r) => { prompts.push(r) } }),
    registryOf: () => ({ archivedSessionIds: [], archiveSession: async (id, o) => { archived.push([id, o]) } }),
    store, now: () => t, io: memIo(), ...extra,
  })
  return { asker, prompts, archived, store, setNow: (n) => { t = n } }
}
const S = (id, updatedAt, more = {}) => ({ sessionId: id, updatedAt, running: false, ...more })

test('asks a session idle for over an hour, once per idle state', async () => {
  const r = rig([S('a', 10 * H - 61 * 60_000), S('b', 10 * H - 59 * 60_000)])
  assert.deepEqual((await r.asker.check()).asked, ['a'])
  assert.equal(r.prompts[0].mode, 'queue')
  assert.equal(r.prompts[0].content[0].text, ASK_PROMPT)
  assert.deepEqual((await r.asker.check()).asked, [])
})

test('never asks a working session, one with a running child, a blank, an archived or a held one', async () => {
  const old = 1 * H
  const r = rig([S('run', old, { running: true }), S('parent', old), S('child', old + 1, { running: true, parentSessionId: 'parent' }), S('blank', old, { blank: true }), S('arch', old), S('held', old)], {
    registryOf: () => ({ archivedSessionIds: ['arch'] }), heldIds: () => new Set(['held']),
  })
  assert.deepEqual((await r.asker.check()).asked, [])
})

test('does not ask a session that already has an open question or permission card', async () => {
  const r = rig([S('a', 1 * H)])
  r.store.add({ type: 'question', sessionId: 'a', questions: [] })
  assert.deepEqual((await r.asker.check()).asked, [])
})

test('laptop sleep time is not idle time', async () => {
  let t = 10 * H
  const sleep = createSleepTracker({ now: () => t })
  const updatedAt = 10 * H - 90 * 60_000 // 90 min ago
  t = updatedAt + 10 * 60_000; sleep.beat()
  t = updatedAt + 70 * 60_000; sleep.beat() // a 60 minute gap: slept
  assert.equal(sleep.sleptBetween(updatedAt, 10 * H), 60 * 60_000)
  const r = rig([S('a', updatedAt)], { sleep })
  r.setNow(10 * H)
  assert.deepEqual((await r.asker.check()).asked, []) // 30 min awake only
  r.setNow(10 * H + 31 * 60_000)
  assert.deepEqual((await r.asker.check()).asked, ['a'])
})

test('a short gap between beats is not sleep', () => {
  let t = 0
  const sleep = createSleepTracker({ now: () => t })
  sleep.beat(); t = 30_000; sleep.beat(); t = 60_000; sleep.beat()
  assert.equal(sleep.sleptBetween(0, 100_000), 0)
})

test('an Archive answer to the asked question archives the session, a Continue answer does not', async () => {
  const r = rig([S('a', 1 * H), S('c', 1 * H)])
  await r.asker.check()
  r.setNow(10 * H + 5000)
  const qa = r.store.add({ type: 'question', sessionId: 'a', questions: [] })
  const qc = r.store.add({ type: 'question', sessionId: 'c', questions: [] })
  r.store.resolve(qa.id ?? qa, { kind: 'answered', by: 'card', answers: [{ id: 'q', selected: ['Archive'] }] })
  r.store.resolve(qc.id ?? qc, { kind: 'answered', by: 'card', answers: [{ id: 'q', selected: ['Continue (Recommended)'] }] })
  assert.deepEqual(await r.asker.archiveAnswered(), ['a'])
  assert.deepEqual(r.archived, [['a', { stopActivity: true }]])
  assert.deepEqual(await r.asker.archiveAnswered(), [])
})

test('the prompt tells a model that wraps the question in run_code to raise that call\'s own timeout and to re-ask once when it still times out', () => {
  for (const needle of ['run_code', 'timeoutMs 600000', 'ask it once more']) assert.ok(ASK_PROMPT.includes(needle), needle)
})

test('the prompt asks with ask_user_question, recommends only for unfinished work, and waits forever otherwise', () => {
  for (const needle of ['ask_user_question', 'Continue', 'Archive', '(Recommended)', 'timeout 600', 'no timeout']) assert.ok(ASK_PROMPT.includes(needle), needle)
})
