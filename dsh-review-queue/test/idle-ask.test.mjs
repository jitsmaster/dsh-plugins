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

test('does not ask a session with a background job still running, nor one whose log cannot be read', async () => {
  const started = { type: 'tool/result', time: 5, data: { content: 'started background job job-1' } }
  const logs = { busy: [started], done: [started, { type: 'tool/ptc-dispatch', time: 6, data: { name: 'job_kill', arguments: { job_id: 'job-1' } } }], free: [] }
  const r = rig([S('busy', 1 * H), S('done', 1 * H), S('free', 1 * H), S('gone', 1 * H)], {
    readLog: async (id) => (logs[id] ? { records: logs[id] } : undefined),
  })
  const res = await r.asker.check()
  assert.deepEqual(res.asked.sort(), ['done', 'free'])
  assert.deepEqual(res.skipped.sort(), ['busy', 'gone'])
})

test('does not ask a session the PR guard protects (it created, waits for or polls an open PR), and still fills the pass with the others', async () => {
  const asked = []
  const prGuardOf = () => ({ check: async (id) => { asked.push(id); return id === 'p1' || id === 'p2' ? { protected: true, prId: '9', status: 'active' } : { protected: false } } })
  const r = rig([S('p1', 1 * H + 3), S('p2', 1 * H + 2), S('q', 1 * H + 1), S('r', 1 * H)], { prGuardOf, maxPerPass: 1 })
  assert.deepEqual((await r.asker.check()).asked, ['q'])
  assert.deepEqual(asked.slice(0, 3), ['p1', 'p2', 'q'], 'stops asking the guard once the pass is full')
})

test('a guard that throws or is missing does not stop the idle ask', async () => {
  const r = rig([S('a', 1 * H)], { prGuardOf: () => ({ check: async () => { throw new Error('boom') } }) })
  assert.deepEqual((await r.asker.check()).asked, ['a'])
})

// Review finding: the title skip was removed with the guard in front, so without the guard (dsh-hooks-tts missing, protectPrSessions off, or a guard that throws) a PR session was asked and an Archive answer archived it.
test('without a PR guard (missing or throwing) a session whose title names a PR is still never asked', async () => {
  const items = [S('t1', 1 * H, { title: 'PR 6554 - Fix cache' }), S('t2', 1 * H, { projections: { values: { title: 'Fix cache - after PR #6554' } } }), S('free', 1 * H, { title: 'Prepare the release' })]
  assert.deepEqual((await rig(items).asker.check()).asked, ['free'])
  const throwing = rig(items, { prGuardOf: () => ({ check: async () => { throw new Error('boom') } }) })
  assert.deepEqual((await throwing.asker.check()).asked, ['free'])
})

test('a working PR guard is the authority: it frees a PR-titled session it does not protect', async () => {
  const r = rig([S('t1', 1 * H, { title: 'PR 6554 - Fix cache' })], { prGuardOf: () => ({ check: async () => ({ protected: false }) }) })
  assert.deepEqual((await r.asker.check()).asked, ['t1'])
})

test('the open question and permission cards are listed once per pass, not once per session', async () => {
  const items = Array.from({ length: 20 }, (_, i) => S('s' + i, 1 * H + i))
  let openLists = 0
  const r = rig(items, {})
  const list = r.store.list.bind(r.store)
  r.store.list = (q) => { if (q?.status === 'open') openLists++; return list(q) }
  await r.asker.check()
  assert.ok(openLists <= 2, 'open-card lists in one pass: ' + openLists)
  openLists = 0
  await r.asker.sample()
  assert.ok(openLists <= 1, 'open-card lists in one sample: ' + openLists)
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

test('an Archive answer does not archive the poll session of a still-open PR (once per ask, logged)', async () => {
  const logs = []
  let open = false // asked while free; its PR is created before the user answers Archive
  const guard = { check: async (id) => (id === 'a' && open ? { protected: true, prId: '5', status: 'active' } : { protected: false }) }
  const r = rig([S('a', 1 * H), S('c', 1 * H)], { prGuardOf: () => guard, log: (line) => logs.push(line) })
  await r.asker.check()
  open = true
  r.setNow(10 * H + 5000)
  for (const session of ['a', 'c']) {
    const q = r.store.add({ type: 'question', sessionId: session, questions: [] })
    r.store.resolve(q.id ?? q, { kind: 'answered', by: 'card', answers: [{ id: 'q', selected: ['Archive'] }] })
  }
  assert.deepEqual(await r.asker.archiveAnswered(), ['c'])
  assert.deepEqual(r.archived, [['c', { stopActivity: true }]])
  assert.ok(logs.some((l) => /not archived a: PR 5 is still open/.test(l)))
  assert.deepEqual(await r.asker.archiveAnswered(), [], 'not asked about again')
  assert.equal(r.archived.length, 1)
})

test('an Archive answer for a session that is handing over a just-created PR is not archived and the log says hand-over', async () => {
  const logs = []
  let handover = false // asked while free; it creates a PR before the user answers Archive
  const guard = { check: async () => (handover ? { protected: true, prId: '7', status: 'handover' } : { protected: false }) }
  const r = rig([S('a', 1 * H)], { prGuardOf: () => guard, log: (line) => logs.push(line) })
  await r.asker.check()
  handover = true
  r.setNow(10 * H + 5000)
  const q = r.store.add({ type: 'question', sessionId: 'a', questions: [] })
  r.store.resolve(q.id ?? q, { kind: 'answered', by: 'card', answers: [{ id: 'q', selected: ['Archive'] }] })
  assert.deepEqual(await r.asker.archiveAnswered(), [])
  assert.equal(r.archived.length, 0)
  assert.ok(logs.some((l) => /not archived a: .*hand(ing)?[- ]?over.*PR 7/i.test(l)), logs.join(' | '))
  assert.ok(!logs.some((l) => /still open/.test(l)), 'no "still open" wording for a hand-over')
})

test('a guard that throws does not stop a requested archive from being handled', async () => {
  const r = rig([S('a', 1 * H)], { prGuardOf: () => ({ check: async () => { throw new Error('guard broke') } }) })
  await r.asker.check()
  r.setNow(10 * H + 5000)
  const q = r.store.add({ type: 'question', sessionId: 'a', questions: [] })
  r.store.resolve(q.id ?? q, { kind: 'answered', by: 'card', answers: [{ id: 'q', selected: ['Archive'] }] })
  assert.deepEqual(await r.asker.archiveAnswered(), ['a'])
})
