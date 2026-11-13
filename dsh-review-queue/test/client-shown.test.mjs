// Slice 2: the desktop overlay reports the card in view once per item (POST /v1/shown); a closed overlay reports nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, tick, okJson } from './client-todo-helpers.mjs'

function setup(overlay) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push([(init && init.method) || 'GET', String(url), init && init.body ? JSON.parse(init.body) : undefined])
    return okJson({ ok: true })
  }
  const { T } = loadClient({ fetchImpl, react: { createElement: el } })
  T.state.overlay = overlay
  return { T, calls }
}
const snap = (ids) => ({ snapshotId: 'e:1', open: ids.map((id, n) => ({ id, type: 'completed', status: 'open', sessionId: 's' + id, createdAt: n, seq: n, position: n + 1, payload: {} })), resolved: [] })
const shownPosts = (calls) => calls.filter((c) => c[0] === 'POST' && /\/v1\/shown$/.test(c[1])).map((c) => c[2].id)

test('overlay open: the card in view is reported once, a new one when it takes over', async () => {
  const { T, calls } = setup(true)
  T.applySnapshot(snap(['a', 'b']))
  await tick()
  assert.deepEqual(shownPosts(calls), ['a'])
  T.applySnapshot(snap(['a', 'b']))
  await tick()
  assert.deepEqual(shownPosts(calls), ['a'])
  T.applySnapshot(snap(['b']))
  await tick()
  assert.deepEqual(shownPosts(calls), ['a', 'b'])
})

test('overlay closed: nothing is reported', async () => {
  const { T, calls } = setup(false)
  T.applySnapshot(snap(['a']))
  await tick()
  assert.deepEqual(shownPosts(calls), [])
})

test('an item that left the open list is forgotten: it is reported again if it returns', async () => {
  const { T, calls } = setup(true)
  T.applySnapshot(snap(['a']))
  await tick()
  T.applySnapshot(snap(['b']))
  await tick()
  T.applySnapshot(snap(['a']))
  await tick()
  assert.deepEqual(shownPosts(calls), ['a', 'b', 'a'])
})

test('selecting another card reports it as shown without a new snapshot', async () => {
  const { T, calls } = setup(true)
  T.applySnapshot(snap(['a', 'b']))
  await tick()
  T.set({ selected: 'b' })
  await tick()
  assert.deepEqual(shownPosts(calls), ['a', 'b'])
})
