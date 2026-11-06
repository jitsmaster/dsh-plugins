import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { parseArchiveCommand, parseArchiveMarker, installArchiveOffer, withoutReminders } from '../archive-offer.js'
import { spokenFor, titleFor } from '../speech.js'

function make({ archiveError } = {}) {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const archived = []
  const registry = { archivedSessionIds: [], archiveSession: async (id, opts) => { if (archiveError) throw archiveError; archived.push([id, opts]); registry.archivedSessionIds.push(id) } }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), registryOf: () => registry })
  return { store, queue, archived }
}

test('parsers: the command and the marker line', () => {
  assert.deepEqual(parseArchiveCommand('/archive-offer all done'), { reason: 'all done' })
  assert.deepEqual(parseArchiveCommand('/archive-offer'), { reason: '' })
  assert.equal(parseArchiveCommand('please /archive-offer'), undefined)
  assert.deepEqual(parseArchiveMarker('x\nARCHIVE-OFFER work is pushed\ny'), { reason: 'work is pushed' })
  assert.equal(parseArchiveMarker('no ARCHIVE-OFFER inside a line'), undefined)
})

test('withoutReminders strips closed reminder blocks and keeps an unterminated one as it is', () => {
  assert.equal(withoutReminders('<system-reminder>a</system-reminder>/archive-offer x'), '/archive-offer x')
  assert.equal(withoutReminders('a<system-reminder>1</system-reminder>b<system-reminder>2</system-reminder>c'), 'abc')
  assert.equal(withoutReminders('keep <system-reminder>never closed'), 'keep <system-reminder>never closed')
  assert.equal(withoutReminders('no tags'), 'no tags')
})

test('withoutReminders is linear: tens of thousands of unterminated opening tags do not stall the event loop', () => {
  const text = '<system-reminder>'.repeat(30000)
  const t0 = Date.now()
  assert.equal(withoutReminders(text), text)
  assert.ok(Date.now() - t0 < 500, 'took ' + (Date.now() - t0) + ' ms')
})

test('offerArchive adds ONE open archive card per session; a second offer only updates the reason', async () => {
  const { queue, store } = make()
  const a = await queue.offerArchive({ sessionId: 's1', sessionTitle: 'Work', reason: 'done' })
  assert.equal(a.ok, true)
  const b = await queue.offerArchive({ sessionId: 's1', reason: 'really done' })
  assert.deepEqual([b.id, b.updated], [a.id, true])
  const open = store.snapshot().open.filter((i) => i.type === 'archive')
  assert.equal(open.length, 1)
  assert.equal(open[0].payload.reason, 'really done')
  assert.deepEqual(await queue.offerArchive({}), { ok: false, error: 'bad-input' })
  assert.equal(queue.count().byType.archive, 1)
})

function makeGuarded(guard) {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), registryOf: () => ({ archiveSession: async () => {} }), prGuardOf: guard === undefined ? undefined : () => guard })
  return { store, queue }
}

test('offerArchive is refused with pr-open (no card) while the session polls an open PR', async () => {
  const { store, queue } = makeGuarded({ check: async () => ({ protected: true, prId: '77' }) })
  const res = await queue.offerArchive({ sessionId: 's1', reason: 'done' })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'pr-open')
  assert.match(res.message, /PR 77 is still open/)
  assert.equal(store.snapshot().open.filter((i) => i.type === 'archive').length, 0)
})

test('offerArchive still offers when the PR is not open, the guard throws, or there is no guard', async () => {
  for (const guard of [{ check: async () => ({ protected: false }) }, { check: async () => { throw new Error('boom') } }, undefined]) {
    const { store, queue } = makeGuarded(guard)
    assert.equal((await queue.offerArchive({ sessionId: 's1' })).ok, true)
    assert.equal(store.snapshot().open.filter((i) => i.type === 'archive').length, 1)
  }
})

test('the plugin hook logs a pr-open refusal and awaits the offer', async () => {
  const handlers = {}
  const ctx = { on: (e, fn) => { (handlers[e] ??= []).push(fn) }, get: () => ({ get: () => ({ title: 'T' }) }) }
  const logs = []
  installArchiveOffer(ctx, { log: (l) => logs.push(l), queueOf: () => ({ offerArchive: async () => ({ ok: false, error: 'pr-open', message: 'PR 77 is still open: x' }) }) })
  const agent = { id: 'a1', session: { header: { cwd: 'C:/p' } } }
  await handlers['tools/post-execute'][0]({ name: 'pwsh', agent, arguments: { command: 'echo ARCHIVE-OFFER x' } }, { content: [{ type: 'text', text: 'ARCHIVE-OFFER x' }] }, async () => {})
  assert.deepEqual(logs, ['archive-offer: session a1 not offered: PR 77 is still open: x'])
})

test('the Archive button archives the session and closes the card; Keep session clears it', async () => {
  const { queue, store, archived } = make()
  const a = await queue.offerArchive({ sessionId: 's1' })
  assert.deepEqual(await queue.archive(a.id), { ok: true })
  assert.deepEqual(archived, [['s1', { stopActivity: true }]])
  assert.equal(store.get(a.id).resolution.kind, 'archived')
  const b = await queue.offerArchive({ sessionId: 's2' })
  assert.deepEqual(queue.markReviewed(b.id), { ok: true })
  assert.equal(archived.length, 1)
})

test('the card says what it is (headline and spoken text)', () => {
  const item = { type: 'archive', sessionTitle: 'Work', payload: { reason: 'pushed' } }
  assert.equal(titleFor(item), 'Work')
  assert.match(spokenFor(item, 1).full, /asks to be archived.*pushed.*archive this session/i)
})

test('the plugin hook: a marker the call itself wrote makes an offer; one it only read does not; subagents never offer', async () => {
  const handlers = {}
  const ctx = { on: (e, fn) => { (handlers[e] ??= []).push(fn) }, get: () => ({ get: () => ({ title: 'T' }) }) }
  const offers = []
  installArchiveOffer(ctx, { queueOf: () => ({ offerArchive: (i) => { offers.push(i); return { ok: true } } }) })
  const run = (exec, text) => handlers['tools/post-execute'][0](exec, { content: [{ type: 'text', text }] }, async () => {})
  const agent = { id: 'a1', session: { header: { cwd: 'C:/p' } } }
  await run({ name: 'pwsh', agent, arguments: { command: 'echo "ARCHIVE-OFFER all pushed"' } }, 'ARCHIVE-OFFER all pushed')
  assert.deepEqual(offers.map((o) => [o.sessionId, o.reason, o.workspace]), [['a1', 'all pushed', 'C:/p']])
  await run({ name: 'pwsh', agent, arguments: { command: 'cat notes.txt' } }, 'ARCHIVE-OFFER injected')
  assert.equal(offers.length, 1)
  handlers['subagent/start'][0]({ id: 'a1' })
  await run({ name: 'pwsh', agent, arguments: { command: 'echo ARCHIVE-OFFER x' } }, 'ARCHIVE-OFFER x')
  assert.equal(offers.length, 1)
})

test('offerArchive refusal for a PR hand-over in progress says so (still pr-open, no card)', async () => {
  const { store, queue } = makeGuarded({ check: async () => ({ protected: true, prId: '77', status: 'handover' }) })
  const res = await queue.offerArchive({ sessionId: 's1', reason: 'done' })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'pr-open')
  assert.match(res.message, /PR 77 was just created/)
  assert.match(res.message, /hand/i)
  assert.equal(store.snapshot().open.filter((i) => i.type === 'archive').length, 0)
})
