import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { loadClient } from './client-todo-helpers.mjs'

// A done card trimmed by the per-session cap (resolution kind 'trimmed') is named in Resolved, in the desktop and, through the shared
// resolutionText / isReopenable, on the phone, and it can be reopened like a hidden one.
const { T } = loadClient()

test('resolutionText says a trimmed card was hidden because the session had too many open done results', () => {
  const withLimit = T.resolutionText({ type: 'completed', resolution: { kind: 'trimmed', by: 'auto', limit: 20 } })
  assert.match(withLimit, /^Hidden: the session had more than 20 open done results/)
  const without = T.resolutionText({ type: 'completed', resolution: { kind: 'trimmed', by: 'auto' } })
  assert.match(without, /^Hidden: /)
  assert.doesNotMatch(without, /undefined|NaN|\bnull\b/)
  assert.ok(without.length < 100, without)
  assert.notEqual(without, 'Resolved')
})

test('a trimmed done card is reopenable; a trimmed non-done item is not', () => {
  assert.equal(T.isReopenable({ type: 'completed', resolution: { kind: 'trimmed' } }), true)
  assert.equal(T.isReopenable({ type: 'question', resolution: { kind: 'trimmed' } }), false)
  assert.equal(T.isReopenable({ type: 'completed', resolution: { kind: 'replied' } }), false)
})

test('the phone has no label table of its own: it uses the shared resolutionText and isReopenable', async () => {
  const { readFileSync } = await import('node:fs')
  const views = readFileSync(new URL('../lib/mobile/views.js', import.meta.url), 'utf8')
  assert.match(views, /c\.resolutionText\(/)
  assert.match(views, /c\.isReopenable\(/)
  assert.doesNotMatch(views, /trimmed|no-action/)
})

test('service.reopen brings a trimmed done card back into the queue', () => {
  const store = createStore({ now: (() => { let t = 1000; return () => ++t })(), uuid: (() => { let n = 0; return () => 'i' + ++n })() })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({}) })
  const a = store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'One', payload: { reply: 'r' } })
  const b = store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'One', payload: { reply: 'r' } })
  store.resolve(a.id, { kind: 'trimmed', by: 'auto', limit: 20 })
  store.resolve(b.id, { kind: 'replied', by: 'card' })
  assert.deepEqual(queue.reopen(a.id), { ok: true })
  assert.equal(store.get(a.id).status, 'open')
  assert.equal(queue.count().total, 1)
  assert.deepEqual(queue.reopen(b.id), { ok: false, error: 'not-reopenable' })
})
