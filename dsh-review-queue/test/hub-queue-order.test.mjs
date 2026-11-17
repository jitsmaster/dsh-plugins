// Slice 5: an app reports its display order (tier / oldest) with presence; the hub exposes the order of the most recently desktop-active online app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHubStore } from '../hub/hub-store.js'
import { createCommands } from '../hub/commands.js'
import { createInstances } from '../hub/instances.js'
import { fakeClock, memIo } from './hub-helpers.mjs'

const A = 'aaaa1111'
const B = 'bbbb2222'
function make() {
  const clock = fakeClock()
  let n = 0
  const store = createHubStore({ now: clock.now, uuid: () => 'u' + ++n, timers: clock, io: memIo() })
  const commands = createCommands({ now: clock.now, timers: clock })
  const instances = createInstances({ store, commands, now: clock.now })
  return { clock, instances }
}
const reg = (instances, id, key) => instances.register({ key, id, label: 'DSH ' + id.slice(0, 1) })

test('no app reported an order: undefined', () => {
  const { instances } = make()
  reg(instances, A, 'k1')
  assert.equal(instances.queueOrder(), undefined)
})

test('presence carries the order; only "tier" and "oldest" are accepted', () => {
  const { instances } = make()
  reg(instances, A, 'k1')
  instances.presence(A, { queueOrder: 'tier' })
  assert.equal(instances.queueOrder(), 'tier')
  instances.presence(A, { queueOrder: 'bogus' })
  assert.equal(instances.queueOrder(), 'tier', 'a bad value changes nothing')
  instances.presence(A, { queueOrder: 'oldest' })
  assert.equal(instances.queueOrder(), 'oldest')
})

test('with two apps the most recently desktop-active one decides', () => {
  const { instances, clock } = make()
  reg(instances, A, 'k1')
  reg(instances, B, 'k2')
  instances.presence(A, { queueOrder: 'tier', desktopActive: true })
  clock.advance?.(1000)
  instances.presence(B, { queueOrder: 'oldest', desktopActive: true })
  assert.equal(instances.queueOrder(), 'oldest')
})
