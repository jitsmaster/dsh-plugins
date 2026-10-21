import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../userpause.js'
import { isTopLevel, listRunningSessions } from '../userpause.js'

// What is left of userpause.js: the running top-level sessions (the session count and /v1/running-sessions). Pause all and quit is gone.
const item = (id, over = {}) => ({ sessionId: id, running: true, cwd: 'D:/w/' + id, ...over })

test('isTopLevel: not a subagent and not a child session', () => {
  assert.equal(isTopLevel(item('a')), true)
  assert.equal(isTopLevel(item('s', { origin: 'subagent' })), false)
  assert.equal(isTopLevel(item('k', { parentSessionId: 'a' })), false)
})

test('listRunningSessions keeps the running top-level sessions only', async () => {
  const sessions = [item('a'), item('b'), item('idle', { running: false }), item('sub', { origin: 'subagent' }), item('kid', { parentSessionId: 'a' }), item('yes', { running: 'yes' })]
  const out = await listRunningSessions({ list: async () => ({ items: sessions }) })
  assert.deepEqual(out.map((i) => i.sessionId), ['a', 'b'])
  assert.deepEqual(await listRunningSessions({ list: async () => ({}) }), [])
})

test('listRunningSessions passes a timeout signal and lets a failing list throw', async () => {
  let signal
  await listRunningSessions({ list: async (_, s) => { signal = s; return { items: [] } } })
  assert.ok(signal instanceof AbortSignal)
  await assert.rejects(listRunningSessions({ list: async () => { throw new Error('x') } }), /x/)
})

test('the Pause all pieces are gone: no pause record, no paused-by-user candidates', () => {
  for (const name of ['createPauseRecord', 'pauseRunningSessions', 'pausedByUserCandidates', 'mergeCandidates', 'logMtimeOf']) assert.equal(mod[name], undefined, name)
})
