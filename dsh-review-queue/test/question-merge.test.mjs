// Group card redesign: a new question that repeats an older open question of the same session supersedes it (the AI judges "same question").
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createQuestionMerge, questionTextOf, parseSame } from '../question-merge.js'

const q = (text, sessionId = 's1', extra = {}) => ({ type: 'question', sessionId, workspace: 'D:/w', payload: { questions: [{ question: text, options: [] }] }, ...extra })

function setup({ same = async () => true } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000 + n * 10, uuid: () => 'i' + ++n })
  const calls = []
  const merge = createQuestionMerge({ store, same: async (a, b) => { calls.push([a, b]); return same(a, b) }, log: () => {}, now: () => 5000 })
  assert.equal(merge.start(), true)
  return { store, merge, calls }
}

test('questionTextOf joins the question texts', () => {
  assert.equal(questionTextOf({ payload: { questions: [{ question: 'A?' }, { question: 'B?' }] } }), 'A? B?')
  assert.equal(questionTextOf({ payload: {} }), '')
})

test('parseSame reads the model JSON and rejects anything else', () => {
  assert.deepEqual(parseSame('{"same": true}'), { same: true })
  assert.deepEqual(parseSame('noise {"same": false} noise'), { same: false })
  assert.ok(parseSame('nope').note)
  assert.ok(parseSame('{"same":"yes"}').note)
})

test('a repeated question supersedes the older one and carries the merge count and update time', async () => {
  const { store, merge } = setup()
  const old = store.add(q('Which database should I use?'))
  const fresh = store.add(q('Which DB do you want?'))
  await merge.idle()
  assert.equal(store.get(old.id).status, 'resolved')
  assert.deepEqual(store.get(old.id).resolution, { kind: 'superseded', by: 'merge', into: fresh.id })
  const kept = store.get(fresh.id)
  assert.equal(kept.status, 'open')
  assert.equal(kept.merged.count, 2)
  assert.equal(kept.updatedAt, 5000)
})

test('a different question stays open', async () => {
  const { store, merge } = setup({ same: async () => false })
  const old = store.add(q('Which database?'))
  store.add(q('Delete the folder?'))
  await merge.idle()
  assert.equal(store.get(old.id).status, 'open')
})

test('only open questions of the same session are compared', async () => {
  const { store, merge, calls } = setup()
  store.add(q('Same text?', 's2'))
  store.add({ type: 'completed', sessionId: 's1', payload: { reply: 'Same text?' } })
  store.add(q('Same text?', 's1'))
  await merge.idle()
  assert.equal(calls.length, 0)
})

test('identical normalized text merges without calling the model', async () => {
  const { store, merge, calls } = setup({ same: async () => false })
  const old = store.add(q('Use  Postgres?'))
  store.add(q('use postgres'))
  await merge.idle()
  assert.equal(calls.length, 0)
  assert.equal(store.get(old.id).status, 'resolved')
})

test('a failing model changes nothing', async () => {
  const { store, merge } = setup({ same: async () => { throw new Error('boom') } })
  const old = store.add(q('A?'))
  store.add(q('B?'))
  await merge.idle()
  assert.equal(store.get(old.id).status, 'open')
})

test('every older open question of the session is compared, no cap', async () => {
  const { store, merge, calls } = setup({ same: async () => false })
  for (let i = 0; i < 8; i++) store.add(q('old ' + i))
  await merge.idle()
  calls.length = 0
  store.add(q('brand new'))
  await merge.idle()
  assert.equal(calls.length, 8)
})
