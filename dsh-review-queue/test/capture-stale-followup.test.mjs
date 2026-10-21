import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { cancelStalePending } from '../capture.js'
import { MAY_HAVE_BEEN_SENT } from '../follow-up-shared.js'

// A follow-up whose send was on its way when the server restarted: the prompt may have been queued already, so it must not read "Retry to start it" (a retry could send the message twice).
const followUp = (over = {}) => ({ type: 'todo', kind: 'followup', text: 'also the null case', query: 'the PR review', state: 'starting', targetSessionId: 's1', candidates: [{ sessionId: 's1', title: 'T' }], ...over })

test('the warning text is one shared constant', () => {
  assert.equal(MAY_HAVE_BEEN_SENT, 'May have been sent: check the session before retrying.')
})

test('a follow-up in state starting becomes failed with the may-have-been-sent warning, and stays open (Retry is a confirm again)', () => {
  const store = createStore()
  const item = store.add(followUp())
  cancelStalePending(store)
  const after = store.get(item.id)
  assert.deepEqual([after.status, after.state, after.error], ['open', 'failed', MAY_HAVE_BEEN_SENT])
  assert.deepEqual(after.candidates, [{ sessionId: 's1', title: 'T' }], 'its candidates stay: Retry needs them')
})

test('a workspace todo in state starting keeps the old wording', () => {
  const store = createStore()
  const item = store.add({ type: 'todo', text: 'fix it', state: 'starting', workspaceId: 'w1' })
  cancelStalePending(store)
  assert.deepEqual([store.get(item.id).state, store.get(item.id).error], ['failed', 'Interrupted by a server restart. Retry to start it.'])
})

test('a follow-up that was only waiting is not touched (only its suggesting mark goes), and the scope still applies', () => {
  const store = createStore()
  const waiting = store.add(followUp({ state: 'awaiting-confirm', suggesting: true }))
  const newer = store.add(followUp())
  cancelStalePending(store, { only: new Set([waiting.id]) })
  assert.deepEqual([store.get(waiting.id).state, store.get(waiting.id).suggesting, store.get(waiting.id).error], ['awaiting-confirm', false, undefined])
  assert.deepEqual([store.get(newer.id).state, store.get(newer.id).error], ['starting', undefined], 'an item of this process is not looked at')
})
