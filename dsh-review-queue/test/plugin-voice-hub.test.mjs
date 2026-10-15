// In hub mode the reviewQueue service answers its actions with promises (the local one answers at once). The sibling dsh-hooks-tts plugin
// uses the service from its voice runner and its alert positions: this runs that real code (read only) against the real hub-mode plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queuePositionOf } from '../../dsh-hooks-tts/voice/alert-position.js'
import { createQueueRunner } from '../../dsh-hooks-tts/voice/queue-runner.js'
import { openSessionOf } from '../agent/wire.js'
import { makeWorld, startPlugin, waitFor } from './plugin-helpers.mjs'

async function twoApps(t) {
  const world = await makeWorld(t)
  await world.startHub()
  const A = await startPlugin(t, world, { label: 'DSH :1', webPort: 12201 })
  const B = await startPlugin(t, world, { label: 'DSH :2', webPort: 12202 })
  await Promise.all([A.inState('hub'), B.inState('hub')])
  return { world, A, B }
}

test('voice deny of the first item, which belongs to the OTHER app, goes through the hub and settles that app\'s request', async (t) => {
  const { A, B } = await twoApps(t)
  const p = await A.permission('sa1')
  await waitFor(() => B.mirrored(p.id), 5000, 'the item in the mirror of B')
  const runner = createQueueRunner({ queue: () => B.provided.reviewQueue, select: () => {} })
  const prepared = await runner.prepareReply({ kind: 'deny' })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.frozen.id, p.id)
  const sent = await runner.sendReply(prepared.frozen, '', { decision: 'deny' })
  assert.equal(sent.outcome, 'sent')
  assert.match(sent.line, /denied/i)
  assert.ok(await Promise.race([p.outcome, new Promise((r) => setTimeout(r, 3000))]), 'the request of the other app was decided')
  assert.equal(A.store.get(p.id).status, 'resolved')
})

test('voice reads (count, read position, stop) are synchronous in hub mode and cover the items of every app', async (t) => {
  const { A, B } = await twoApps(t)
  await A.completed('sa1', 'A did a thing')
  const q = B.question('sb1')
  await waitFor(() => B.mirrored(q.id), 5000, 'in the mirror')
  const runner = createQueueRunner({ queue: () => B.provided.reviewQueue, select: () => {} })
  assert.match((await runner.run({ kind: 'count' })).line, /^Two waiting: one question, one done\.$/)
  const service = B.provided.reviewQueue
  assert.equal(service.count().total, 2, 'a plain value, not a promise')
  assert.equal(typeof service.snapshot().open[0].position, 'number')
  assert.equal(service.openTarget().sessionId, 'sa1', 'the first item is the one of the other app')
})

test('the alert position of an item is read synchronously from the mirror, whichever app owns the item', async (t) => {
  const { A, B } = await twoApps(t)
  await A.completed('sa1', 'first')
  const q = B.question('sb1')
  await waitFor(() => A.mirrored(q.id), 5000, 'in the mirror of A')
  assert.equal(queuePositionOf(() => A.provided.reviewQueue, { type: 'question', sessionId: 'sb1' }), 2)
})

test('the open-session command uses the controller of the app when it can show a session, else it says so', async () => {
  const shown = []
  assert.deepEqual(await openSessionOf(() => ({ openSession: async (id) => { shown.push(id) } }))('s1'), { ok: true })
  assert.deepEqual(shown, ['s1'])
  assert.deepEqual(await openSessionOf(() => ({}))('s1'), { ok: false, error: 'no-controller' })
  assert.deepEqual(await openSessionOf(() => { throw new Error('gone') })('s1'), { ok: false, error: 'no-controller' })
  assert.deepEqual(await openSessionOf(() => ({ openSession: async () => { throw new Error('no such session') } }))('s1'), { ok: false, error: 'no such session' })
})
