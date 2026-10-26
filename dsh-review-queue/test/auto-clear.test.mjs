import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createAutoClear, hasActionItem, DONE_NO_ACTION_MS } from '../auto-clear.js'

const rig = () => {
  let t = 1_000_000
  const store = createStore({ now: () => t })
  const clear = createAutoClear({ store, now: () => t })
  return { store, clear, at: (n) => { t = n }, tick: (ms) => { t += ms } }
}
const done = (store, summary, more = {}) => store.add({ type: 'completed', sessionId: 's', summary, summarySource: 'llm', payload: { reply: 'All done.' }, ...more })

test('an open question whose wait has run out leaves the list at once, resolved as expired with the recommended option', () => {
  const r = rig()
  const q = r.store.add({ type: 'question', sessionId: 's', expiresAt: 1_000_000 + 5000, payload: { questions: [{ question: 'Go?', options: [{ label: 'Yes (Recommended)' }, { label: 'No' }] }] } })
  r.tick(4999)
  assert.deepEqual(r.clear.sweep(), { questions: 0, done: 0 })
  r.tick(1)
  assert.deepEqual(r.clear.sweep(), { questions: 1, done: 0 })
  const got = r.store.get(q.id)
  assert.equal(got.status, 'resolved')
  assert.equal(got.resolution.kind, 'expired')
})

test('a question without an expiry, or one still waiting, stays', () => {
  const r = rig()
  r.store.add({ type: 'question', sessionId: 's', payload: { questions: [] } })
  r.store.add({ type: 'question', sessionId: 's', expiresAt: 1_000_000 + 60_000, payload: { questions: [] } })
  r.tick(30_000)
  assert.deepEqual(r.clear.sweep(), { questions: 0, done: 0 })
  assert.equal(r.store.list({ status: 'open' }).length, 2)
})

test('a done message with no bold action item is removed 30 seconds after it arrived', () => {
  const r = rig()
  const d = done(r.store, 'The migration ran and the tests pass.')
  r.tick(DONE_NO_ACTION_MS - 1)
  assert.equal(r.clear.sweep().done, 0)
  r.tick(1)
  assert.equal(r.clear.sweep().done, 1)
  assert.deepEqual(r.store.get(d.id).resolution, { kind: 'no-action', by: 'auto' })
})

test('a done message with a bold action item stays', () => {
  const r = rig()
  done(r.store, 'Fixed. <u>**Please restart the service.**</u>')
  r.tick(10 * 60_000)
  assert.equal(r.clear.sweep().done, 0)
  assert.equal(r.store.list({ status: 'open' }).length, 1)
})

test('a done message the summary model or the guard says needs the user stays, even without bold', () => {
  const r = rig()
  done(r.store, 'Waiting on you.', { actionable: true })
  done(r.store, 'Ready.', { payload: { reply: 'Which approach do you prefer, A or B? Let me know.' } })
  r.tick(10 * 60_000)
  assert.equal(r.clear.sweep().done, 0)
})

test('only open done messages and questions are touched', () => {
  const r = rig()
  const a = done(r.store, 'Nothing to do.')
  r.store.resolve(a.id, { kind: 'reviewed', by: 'card' })
  r.store.add({ type: 'todo', sessionId: 's', summary: 'x' })
  r.store.add({ type: 'permission', sessionId: 's', summary: 'x' })
  r.tick(10 * 60_000)
  assert.deepEqual(r.clear.sweep(), { questions: 0, done: 0 })
  assert.equal(r.store.get(a.id).resolution.kind, 'reviewed')
})

test('hasActionItem finds the bold marker only', () => {
  assert.equal(hasActionItem('<u>**x**</u>'), true)
  assert.equal(hasActionItem('plain text'), false)
  assert.equal(hasActionItem(undefined), false)
})
