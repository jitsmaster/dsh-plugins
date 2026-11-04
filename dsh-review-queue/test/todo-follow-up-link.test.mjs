import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupFollowUp, prompts } from './follow-up-helpers.mjs'
import { stripLinkOptions, LINK_OPTIONS, checkLinkOptions } from '../follow-up-shared.js'

const MSG = '[Message from session s9 ("Me")] hello'
const sessions = [{ sessionId: 's1', title: 'Engine one', updatedAt: 3 }, { sessionId: 'me', title: 'Me', updatedAt: 9 }, { sessionId: 's2', title: 'Engine two', updatedAt: 2 }]

test('stripLinkOptions removes exactly mode, excludeSessionIds and source', () => {
  assert.deepEqual(LINK_OPTIONS.slice().sort(), ['excludeSessionIds', 'mode', 'source'])
  assert.deepEqual(stripLinkOptions({ text: 'x', followUp: 'y', mode: 'steer', excludeSessionIds: ['a'], source: { sessionId: 'a' } }), { text: 'x', followUp: 'y' })
  assert.equal(stripLinkOptions(7), 7)
  assert.equal(stripLinkOptions(null), null)
})

test('checkLinkOptions validates and cleans the three options', () => {
  assert.deepEqual(checkLinkOptions({}), { ok: true, mode: undefined, source: undefined, exclude: [] })
  assert.deepEqual(checkLinkOptions({ mode: 'queue' }), { ok: true, mode: undefined, source: undefined, exclude: [] })
  assert.equal(checkLinkOptions({ mode: 'steer' }).mode, 'steer')
  assert.deepEqual(checkLinkOptions({ mode: 'interrupt' }), { ok: false, error: 'bad-mode' })
  assert.deepEqual(checkLinkOptions({ source: null }), { ok: false, error: 'bad-source' })
  assert.deepEqual(checkLinkOptions({ source: { sessionId: 'a b' } }), { ok: false, error: 'bad-source' })
  assert.deepEqual(checkLinkOptions({ source: { sessionId: 'a1', title: '  x\ny\u0000 z ' } }).source, { sessionId: 'a1', title: 'x y z' })
  assert.equal(checkLinkOptions({ source: { sessionId: 'a1', title: 'x'.repeat(200) } }).source.title.length, 80)
  const many = Array.from({ length: 30 }, (_, i) => 'id' + i)
  assert.deepEqual(checkLinkOptions({ excludeSessionIds: ['a', 'a', 7, 'b', ...many] }).exclude, ['a', 'b', ...many].slice(0, 20))
  assert.deepEqual(checkLinkOptions({ excludeSessionIds: 'a' }).exclude, [])
})

test('addTodo stores source, steer mode and excluded ids; queue mode is not stored', () => {
  const f = setupFollowUp()
  const r = f.queue.addTodo(MSG, { followUp: 'engine', sessions, mode: 'steer', source: { sessionId: 'me', title: 'Me' }, excludeSessionIds: ['me'] })
  assert.equal(r.ok, true)
  const item = f.store.get(r.id)
  assert.equal(item.mode, 'steer')
  assert.deepEqual(item.source, { sessionId: 'me', title: 'Me' })
  assert.deepEqual(item.excludeIds, ['me'])
  const q = f.queue.addTodo(MSG + '2', { followUp: 'engine', sessions, mode: 'queue' })
  assert.equal(f.store.get(q.id).mode, undefined)
})

test('a bad mode or source is refused', () => {
  const f = setupFollowUp()
  assert.deepEqual(f.queue.addTodo(MSG, { followUp: 'engine', sessions, mode: 'interrupt' }), { ok: false, error: 'bad-mode' })
  assert.deepEqual(f.queue.addTodo(MSG, { followUp: 'engine', sessions, source: { sessionId: 'not valid', title: 'x' } }), { ok: false, error: 'bad-source' })
  assert.deepEqual(f.queue.addTodo(MSG, { followUp: 'engine', sessions, source: 'me' }), { ok: false, error: 'bad-source' })
})

test('excluded sessions are never candidates nor suggested', () => {
  const f = setupFollowUp()
  const r = f.queue.addTodo(MSG, { followUp: 'me', sessions, excludeSessionIds: ['me'] })
  const item = f.store.get(r.id)
  assert.ok(!(item.candidates ?? []).some((c) => c.sessionId === 'me'))
  assert.notEqual(item.suggested?.sessionId, 'me')
})

test('an exact-id follow-up of an excluded session finds no session and never sends', async () => {
  const f = setupFollowUp()
  const r = f.queue.addTodo(MSG, { followUp: 'me', sessions, excludeSessionIds: ['me'] })
  assert.deepEqual(await f.queue.confirmTodo(r.id, { sessionId: 'me' }), { ok: false, error: 'excluded-session' })
  assert.equal(prompts(f.calls).length, 0)
})

test('the steer mode reaches the prompt on confirm; the default is queue; the request id is unchanged', async () => {
  const f = setupFollowUp()
  const a = f.queue.addTodo(MSG, { followUp: 's1', sessions, mode: 'steer' })
  await f.queue.confirmTodo(a.id, { sessionId: 's1' }); await f.queue.todoIdle()
  assert.equal(prompts(f.calls).at(-1)[1].mode, 'steer')
  assert.equal(prompts(f.calls).at(-1)[1].requestId, 'todo-' + a.id + '-s1')
  const b = f.queue.addTodo(MSG + 'b', { followUp: 's2', sessions })
  await f.queue.confirmTodo(b.id, { sessionId: 's2' }); await f.queue.todoIdle()
  assert.equal(prompts(f.calls).at(-1)[1].mode, 'queue')
})
