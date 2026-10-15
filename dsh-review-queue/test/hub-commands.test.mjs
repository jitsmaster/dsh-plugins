import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommands, TIMEOUT_MS } from '../hub/commands.js'
import { fakeClock } from './hub-helpers.mjs'

let counter = 0
const make = (over = {}) => {
  const clock = fakeClock()
  const commands = createCommands({ now: clock.now, timers: clock, uuid: () => 'c' + ++counter, ...over })
  return { clock, commands }
}
const approve = { kind: 'approve', itemId: 'i1', args: { via: 'phone', confirmed: true } }

test('the timeouts are the 6.2 table', () => {
  assert.deepEqual(
    { ...TIMEOUT_MS },
    { answer: 10_000, deny: 10_000, approve: 10_000, 'approve-similar': 10_000, 'late-answer': 15_000, reply: 35_000, archive: 35_000, 'todo-suggest': 10_000, 'todo-start': 10_000, 'todo-cancel': 10_000, 'open-session': 10_000, apply: 10_000 },
  )
})

test('a command is queued for its instance, delivered by a poll and finished by its result', async () => {
  const { commands } = make()
  const done = commands.enqueue('A', approve)
  const [cmd] = await commands.poll('A', 0, 0)
  assert.deepEqual([cmd.cid, cmd.seq, cmd.kind, cmd.itemId, cmd.args], ['c' + counter, 1, 'approve', 'i1', { via: 'phone', confirmed: true }])
  assert.equal(typeof cmd.deadline, 'number')
  assert.equal(commands.complete('A', cmd.cid, { ok: true }), true)
  assert.deepEqual(await done, { ok: true })
})

test('every instance has its own FIFO with its own sequence numbers', async () => {
  const { commands } = make()
  void commands.enqueue('A', approve)
  void commands.enqueue('A', { ...approve, kind: 'deny' })
  void commands.enqueue('B', approve)
  assert.deepEqual((await commands.poll('A', 0, 0)).map((c) => [c.seq, c.kind]), [[1, 'approve'], [2, 'deny']])
  assert.deepEqual((await commands.poll('B', 0, 0)).map((c) => c.seq), [1])
})

test('until the agent acknowledges with after=<seq> a command is delivered again, and then it is not', async () => {
  const { commands } = make()
  void commands.enqueue('A', approve)
  const first = await commands.poll('A', 0, 0)
  const again = await commands.poll('A', 0, 0)
  assert.equal(first[0].cid, again[0].cid)
  assert.deepEqual(await commands.poll('A', 1, 0), [])
})

test('a long poll is woken by a new command and gives up with an empty list at its wait time', async () => {
  const { commands, clock } = make()
  const woken = commands.poll('A', 0, 25_000)
  void commands.enqueue('A', approve)
  assert.equal((await woken).length, 1)
  const quiet = commands.poll('A', 1, 25_000)
  clock.advance(25_000)
  assert.deepEqual(await quiet, [])
})

test('a command nobody fetched in time fails with owner-timeout and leaves the queue', async () => {
  const { commands, clock } = make()
  const done = commands.enqueue('A', approve)
  clock.advance(TIMEOUT_MS.approve)
  assert.deepEqual(await done, { ok: false, error: 'owner-timeout' })
  assert.deepEqual(await commands.poll('A', 0, 0), [])
})

test('a command that was delivered but never answered fails with unknown-outcome, and a late result is ignored', async () => {
  const { commands, clock } = make()
  const done = commands.enqueue('A', { ...approve, kind: 'reply', args: { text: 'x' } })
  const [cmd] = await commands.poll('A', 0, 0)
  clock.advance(TIMEOUT_MS.reply)
  assert.deepEqual(await done, { ok: false, error: 'unknown-outcome' })
  assert.equal(commands.complete('A', cmd.cid, { ok: true }), false)
})

test('a result for another instance, an unknown cid or an already finished command is not accepted', async () => {
  const { commands } = make()
  const done = commands.enqueue('A', approve)
  const [cmd] = await commands.poll('A', 0, 0)
  assert.equal(commands.complete('B', cmd.cid, { ok: true }), false)
  assert.equal(commands.complete('A', 'nope', { ok: true }), false)
  assert.equal(commands.complete('A', cmd.cid, { ok: true }), true)
  assert.equal(commands.complete('A', cmd.cid, { ok: false, error: 'x' }), false)
  assert.deepEqual(await done, { ok: true })
})

test('per-kind timeouts can be overridden (tests and slow machines)', async () => {
  const { commands, clock } = make({ timeoutsMs: { approve: 50 } })
  const done = commands.enqueue('A', approve)
  clock.advance(50)
  assert.deepEqual(await done, { ok: false, error: 'owner-timeout' })
})

test('failInstance answers what was waiting: owner-offline for a queued command, unknown-outcome for a delivered one', async () => {
  const { commands } = make()
  const delivered = commands.enqueue('A', approve)
  await commands.poll('A', 0, 0)
  const queued = commands.enqueue('A', { ...approve, kind: 'deny' })
  const other = commands.enqueue('B', approve)
  commands.failInstance('A')
  assert.deepEqual(await delivered, { ok: false, error: 'unknown-outcome' })
  assert.deepEqual(await queued, { ok: false, error: 'owner-offline' })
  assert.equal(commands.pending('A'), 0)
  assert.equal(commands.pending('B'), 1)
  void other
})

test('failAll (hub shutdown) answers every waiter and wakes the long polls', async () => {
  const { commands } = make()
  const queued = commands.enqueue('A', approve)
  const delivered = commands.enqueue('B', approve)
  await commands.poll('B', 0, 0)
  const poll = commands.poll('C', 0, 25_000)
  commands.failAll()
  assert.deepEqual(await queued, { ok: false, error: 'shutting-down' })
  assert.deepEqual(await delivered, { ok: false, error: 'unknown-outcome' })
  assert.deepEqual(await poll, [])
})

test('a command without a waiter (apply) resolves at once and is only a message for the agent', async () => {
  const { commands, clock } = make()
  assert.deepEqual(await commands.enqueue('A', { kind: 'apply', args: { change: { op: 'drop', id: 'x' } }, wait: false }), { ok: true, queued: true })
  const [cmd] = await commands.poll('A', 0, 0)
  assert.equal(cmd.kind, 'apply')
  assert.equal(commands.complete('A', cmd.cid, { ok: true }), true)
  clock.advance(60_000)
  assert.equal(commands.pending('A'), 0)
})
