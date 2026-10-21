import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './client-todo-helpers.mjs'
import { setupFollowUp } from './follow-up-helpers.mjs'

// Small input and wording rules of the Follow-up todo.

test('errorText: a follow-up confirm with no session (HTTP 400 no-session) says to pick one; the 409 of a reply or an archive keeps its words', () => {
  const { T } = loadClient()
  assert.equal(T.errorText(400, { error: 'no-session' }), 'Pick a session first.')
  assert.match(T.errorText(409, { error: 'no-session' }), /session is not running any more/)
  assert.equal(T.errorText(400, { error: 'no-workspace' }), 'Pick a workspace first.', 'the workspace todo wording is unchanged')
})

test('todo add: a followUp that is present but not a string (false, 0, an object, an array) is empty-query, never an ordinary todo', () => {
  const { queue, store } = setupFollowUp()
  for (const followUp of [false, 0, 5, {}, [], true, '', '   ']) {
    assert.deepEqual(queue.addTodo('msg', { followUp }), { ok: false, error: 'empty-query' }, JSON.stringify(followUp))
  }
  assert.equal(store.list().length, 0, 'nothing was added')
  assert.equal(queue.addTodo('msg', { followUp: undefined, workspaceId: undefined }).ok, true, 'an absent followUp is an ordinary todo')
  assert.equal(queue.addTodo('msg', { followUp: null }).ok, true, 'and so is null')
})
