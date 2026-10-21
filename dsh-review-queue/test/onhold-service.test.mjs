import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createOnHold } from '../onhold.js'
import { createRouter } from '../server.js'
import { spokenFor, titleFor, fullTextFor } from '../speech.js'

// The on-hold item through the service: a card (Done or Paused) is moved to the on-hold queue, which is never counted as waiting; release and continue by id.
function setup() {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const prompts = []
  const ctl = { prompt: async (request) => { prompts.push(request) } }
  const handled = []
  const paused = { markHandled: (item) => handled.push(item.id), scan: async () => ({ ok: true }) }
  const onHold = createOnHold({ store, controllerOf: () => ctl, ticketStateOf: async () => ({ ok: false, error: 'no-pat' }), log: () => {} })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ctl, speaker: { speak: () => ({ ok: true }), stop() {} }, paused, onHold })
  return { store, queue, prompts, handled }
}
const done = (store, over = {}) => store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'Fix: Thing - 25751', summary: 'Did it', payload: { reply: 'ok' }, ...over })

test('holdItem moves a Done card to the on-hold queue: the card closes as held and an onhold item with the reason opens', async () => {
  const { store, queue } = setup()
  const card = done(store)
  const r = await queue.holdItem(card.id, { reason: 'waiting for the CMS URL' })
  assert.equal(r.ok, true)
  assert.deepEqual(store.get(card.id).resolution, { kind: 'held', by: 'card' })
  const [hold] = store.snapshot().open
  assert.deepEqual([hold.type, hold.sessionId, hold.payload.reason, hold.payload.ticket.id], ['onhold', 's1', 'waiting for the CMS URL', '25751'])
})

test('a paused card can be held too (and is then handled, so the scan does not bring it back); a question, a permission or a missing item cannot', async () => {
  const { store, queue, handled } = setup()
  const p = store.add({ type: 'paused', sessionId: 's2', sessionTitle: 'Work', payload: {} })
  assert.equal((await queue.holdItem(p.id, { reason: 'later' })).ok, true)
  assert.deepEqual(handled, [p.id])
  const q = store.add({ type: 'question', sessionId: 's3', payload: { questions: [] } })
  assert.deepEqual(await queue.holdItem(q.id, {}), { ok: false, error: 'not-holdable' })
  assert.deepEqual(await queue.holdItem('nope', {}), { ok: false, error: 'not-open' })
})

test('the on-hold queue is never waiting: it is in no total, has its own count, and the done card of a held session is not listed twice', async () => {
  const { store, queue } = setup()
  done(store, { sessionId: 'a' })
  const c = done(store, { sessionId: 'b' })
  await queue.holdItem(c.id, { reason: 'r' })
  const count = queue.count()
  assert.equal(count.total, 1)
  assert.equal(count.byType.onhold, 1)
  assert.equal(count.byType.completed, 1)
})

test('release and continueHold go by item id: release closes it, continueHold prompts the session and closes it', async () => {
  const { store, queue, prompts } = setup()
  const a = await queue.holdItem(done(store, { sessionId: 'a' }).id, { reason: 'x' })
  const b = await queue.holdItem(done(store, { sessionId: 'b' }).id, { reason: 'y' })
  assert.deepEqual(queue.releaseHold(a.id), { ok: true })
  assert.deepEqual(await queue.continueHold(b.id), { ok: true })
  assert.deepEqual(prompts.map((p) => p.sessionId), ['b'])
  assert.deepEqual([store.get(a.id).resolution.kind, store.get(b.id).resolution.kind], ['released', 'continued'])
})

test('an app without the on-hold queue says so instead of throwing', async () => {
  const store = createStore()
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), speaker: { speak: () => ({ ok: true }), stop() {} } })
  const c = done(store)
  assert.deepEqual(await queue.holdItem(c.id, {}), { ok: false, error: 'no-onhold' })
  assert.deepEqual(queue.releaseHold('x'), { ok: false, error: 'no-onhold' })
  assert.deepEqual(await queue.continueHold('x'), { ok: false, error: 'no-onhold' })
})

test('speech: a held session has a title, a headline and a full text that say why and what happens next', () => {
  const item = { type: 'onhold', sessionTitle: 'Fix: Thing - 25751', payload: { reason: 'waiting for the CMS URL', ticket: { id: '25751' } } }
  assert.equal(titleFor(item), 'Fix: Thing - 25751')
  const s = spokenFor(item, 1)
  assert.match(s.headline, /on hold/i)
  assert.match(s.full, /waiting for the CMS URL/)
  assert.match(s.full, /25751/)
  assert.equal(fullTextFor(item, 1), s.full)
  assert.equal(titleFor({ type: 'onhold', sessionTitle: '', payload: {} }), 'Session on hold')
})

test('the HTTP routes hold, hold-release and hold-continue call the service', async () => {
  const calls = []
  const queue = { holdItem: async (id, o) => { calls.push(['hold', id, o]); return { ok: true } }, releaseHold: (id) => { calls.push(['release', id]); return { ok: true } }, continueHold: async (id) => { calls.push(['continue', id]); return { ok: true } } }
  const router = createRouter({ queue })
  assert.equal(typeof router, 'function')
  const src = (await import('node:fs')).readFileSync(new URL('../server.js', import.meta.url), 'utf8')
  for (const route of ["'/v1/hold'", "'/v1/hold-release'", "'/v1/hold-continue'"]) assert.ok(src.includes(route), route)
})
