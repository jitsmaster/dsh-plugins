import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeLlm, promptOf, setupFollowUp } from './follow-up-helpers.mjs'

// Item size of a follow-up: the candidate list is only needed while the card waits for a pick (and for a Retry); a resolved item keeps the suggestion and the session title, not 60 sessions.
// It is capped at 20 (the suggestion and its alternatives first), and the store is written as few times as the states allow.
const llm = () => fakeLlm({ answer: '{"select":"s-pr","reason":"the review"}' })
async function waitingItem(over = {}) {
  const ctx = setupFollowUp({ llm: llm(), ...over })
  const { id } = ctx.queue.addTodo('also the null case', { followUp: 'the PR review' })
  await ctx.queue.todoIdle()
  return { ...ctx, id }
}
// The suggested session of the fixtures is running: a model pick of a working session is only sent when the user picks it, so every confirm here picks it.
const PICK = { sessionId: 's-pr' }
const many = (n, make = () => ({})) => Array.from({ length: n }, (_, i) => ({ sessionId: 's' + i, title: 'Title ' + i, updatedAt: 1000 - i, ...make(i) }))

test('a follow-up that was sent drops its candidates and keeps the suggestion and the session title', async () => {
  const { queue, store, id } = await waitingItem()
  assert.equal(store.get(id).candidates.length, 3, 'while it waits the card needs the list')
  queue.confirmTodo(id, PICK)
  await queue.todoIdle()
  const item = store.get(id)
  assert.deepEqual([item.status, item.state], ['resolved', 'started'])
  assert.equal(item.candidates, undefined)
  assert.ok(!JSON.stringify(item).includes('candidates'), 'nothing of it is saved')
  assert.equal(item.suggested.sessionId, 's-pr')
  assert.equal(item.sessionTitle, 'PR 6556 review')
  assert.equal(item.sessionId, 's-pr')
})

test('a cancelled follow-up drops its candidates and keeps the suggestion; a workspace todo gets no candidates key', async () => {
  const { queue, store, id } = await waitingItem()
  assert.deepEqual(queue.cancelTodo(id), { ok: true })
  const item = store.get(id)
  assert.deepEqual([item.status, item.state, item.candidates], ['resolved', 'cancelled', undefined])
  assert.equal(item.suggested.sessionId, 's-pr')
  const plain = setupFollowUp({ llm: fakeLlm({ answer: '{"select":null}' }) })
  const todo = plain.queue.addTodo('fix the login')
  await plain.queue.todoIdle()
  plain.queue.cancelTodo(todo.id)
  assert.equal('candidates' in plain.store.get(todo.id), false)
})

test('a failed send keeps the candidates (Retry is a confirm again); the list goes once the retry is sent', async () => {
  const { queue, store, id, controller } = await waitingItem({ promptError: { message: 'no' } })
  queue.confirmTodo(id, PICK)
  await queue.todoIdle()
  assert.equal(store.get(id).state, 'failed')
  assert.equal(store.get(id).candidates.length, 3)
  controller.prompt = async () => ({})
  assert.deepEqual(queue.confirmTodo(id, PICK), { ok: true, state: 'starting' })
  await queue.todoIdle()
  assert.deepEqual([store.get(id).state, store.get(id).candidates], ['started', undefined])
})

test('at most 20 candidates are stored: the suggestion and its alternatives first, the rest newest first (the model still reads all of them)', async () => {
  const seen = {}
  const items = many(30).map((s) => ({ sessionId: s.sessionId, updatedAt: s.updatedAt, running: false, blank: false }))
  const { queue, store } = setupFollowUp({ items, titles: {}, llm: fakeLlm({ answer: '{"select":"s29","alternatives":["s28","s27","s26","s25"]}', seen }) })
  const { id } = queue.addTodo('msg', { followUp: 'words' })
  await queue.todoIdle()
  const item = store.get(id)
  assert.equal(item.candidates.length, 20)
  assert.deepEqual(item.candidates.slice(0, 5).map((c) => c.sessionId), ['s29', 's28', 's27', 's26', 's25'])
  assert.deepEqual(item.candidates.slice(5, 8).map((c) => c.sessionId), ['s0', 's1', 's2'])
  assert.equal(item.suggested.sessionId, 's29')
  const prompt = promptOf(seen)
  assert.ok(prompt.includes('s29') && prompt.includes('s19') && prompt.includes('s21'), 'the model saw sessions beyond the stored 20')
})

test('the first stored list (before the model answers) is capped too, and a session that is not suggested and not in the first 20 is not a candidate', async () => {
  const { queue, store } = setupFollowUp({ llm: fakeLlm({ answer: '{"select":null}' }) })
  const { id } = queue.addTodo('msg', { followUp: 'words', sessions: many(45) })
  assert.equal(store.get(id).candidates.length, 20, 'at once, while the model is asked')
  await queue.todoIdle()
  assert.equal(store.get(id).candidates.length, 20)
  assert.equal(store.get(id).candidates.some((c) => c.sessionId === 's30'), false)
})

test('a ticket number that decides a session beyond the first 20 puts it first among the stored 20', async () => {
  const sessions = many(45, (i) => (i === 40 ? { title: 'Fix: the thing - 25001' } : {}))
  const { queue, store } = setupFollowUp({ llm: llm() })
  const { id } = queue.addTodo('msg', { followUp: 'the one for ticket 25001', sessions })
  await queue.todoIdle()
  const item = store.get(id)
  assert.equal(item.candidates.length, 20)
  assert.equal(item.candidates[0].sessionId, 's40')
  assert.equal(item.suggested.sessionId, 's40')
})

// ---- fewer writes ------------------------------------------------------------------------------------------------------------------------

const changes = (store) => { const n = { count: 0 }; store.onChange(() => { n.count++ }); return n }

test('a ticket-number match with the hub\'s sessions is written once: the add itself carries the suggestion and the ordered list', async () => {
  const { queue, store } = setupFollowUp({ llm: llm() })
  const n = changes(store)
  const { id } = queue.addTodo('msg', { followUp: 'ticket 25001', sessions: many(5, (i) => (i === 3 ? { title: 'Fix - 25001' } : {})) })
  const right = store.get(id)
  assert.deepEqual([right.suggesting, right.suggested?.sessionId, right.suggested?.reason, right.candidates[0].sessionId], [false, 's3', 'ticket or PR number in the words', 's3'], 'complete as soon as add returns')
  await queue.todoIdle()
  assert.equal(n.count, 1)
})

test('a ticket-number match of this app\'s own sessions is written twice (the add, then the sessions and the suggestion together), not three times', async () => {
  const { queue, store } = setupFollowUp({ llm: llm() })
  const n = changes(store)
  const { id } = queue.addTodo('msg', { followUp: 'the one for ticket 25001' })
  assert.equal(store.get(id).suggesting, true)
  await queue.todoIdle()
  const item = store.get(id)
  assert.deepEqual([item.suggesting, item.suggested.sessionId, item.candidates[0].sessionId, item.candidates.length], [false, 's-old', 's-old', 3])
  assert.equal(n.count, 2)
})

test('a model pick is written as before: the add with the list, then the order and the suggestion', async () => {
  const hub = setupFollowUp({ llm: llm() })
  const n = changes(hub.store)
  const { id } = hub.queue.addTodo('msg', { followUp: 'the review', sessions: many(3) })
  assert.equal(hub.store.get(id).candidates.length, 3)
  assert.equal(hub.store.get(id).suggesting, true)
  await hub.queue.todoIdle()
  assert.equal(n.count, 2)
  const own = setupFollowUp({ llm: llm() })
  const m = changes(own.store)
  own.queue.addTodo('msg', { followUp: 'the review' })
  await own.queue.todoIdle()
  assert.equal(m.count, 3, 'add, the list that is shown while the model thinks, then the suggestion')
})

test('sending is the same three writes as before (starting, started with the list gone, resolved): the clean-up is part of the started write', async () => {
  const { queue, store, id } = await waitingItem()
  const n = changes(store)
  queue.confirmTodo(id, PICK)
  await queue.todoIdle()
  assert.equal(n.count, 3)
})
