// The question merge never closes an item whose card answer is in flight, and expires unrelated older detached questions at once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createQuestionMerge } from '../question-merge.js'

const q = (text, extra = {}) => ({ type: 'question', sessionId: 's1', workspace: 'D:/w', detached: true, payload: { questions: [{ question: text, options: [] }] }, ...extra })

function setup({ same = async () => true, isBusy } = {}) {
  let n = 0
  const store = createStore({ now: () => 1000 + n * 10, uuid: () => 'i' + ++n })
  const merge = createQuestionMerge({ store, same, isBusy, log: () => {}, now: () => 5000 })
  merge.start()
  return { store, merge }
}

test('an in-flight older question is neither merged nor expired', async () => {
  let busy
  const { store, merge } = setup({ isBusy: (id) => id === busy })
  const old = store.add(q('Which database should I use?'))
  busy = old.id
  store.add(q('Which database do you want?'))
  await merge.idle()
  assert.equal(store.get(old.id).status, 'open')
})

test('an in-flight older question is not expired when the new one is unrelated', async () => {
  let busy
  const { store, merge } = setup({ same: async () => false, isBusy: (id) => id === busy })
  const old = store.add(q('Which database?'))
  busy = old.id
  store.add(q('Should I use tabs?'))
  await merge.idle()
  assert.equal(store.get(old.id).status, 'open')
})

test('an unrelated older detached question expires at once, without waiting for the model chain', () => {
  const { store } = setup({ same: () => new Promise(() => {}) }) // a model call that never ends
  const old = store.add(q('Which database?'))
  store.add(q('Should I use tabs?'))
  assert.equal(store.get(old.id).resolution?.kind, 'expired')
})

test('a merge candidate is not expired before the merge attempt', () => {
  const { store } = setup({ same: () => new Promise(() => {}) })
  const old = store.add(q('Which database should I use?'))
  store.add(q('Which database do you want?'))
  assert.equal(store.get(old.id).status, 'open')
})
