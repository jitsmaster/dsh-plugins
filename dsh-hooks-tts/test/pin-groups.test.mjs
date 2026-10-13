import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGroups } from '../groups.js'
import { createGroupPinner } from '../pin-groups.js'

const fresh = () => createGroups(mkdtempSync(join(tmpdir(), 'pin-groups-')))

/** A registry double that mirrors pinSession (prepend, idempotent) and rejects unknown or archived sessions like DSH. */
function fakeRegistry({ pinned = [], archived = [], unknown = [] } = {}) {
  const reg = {
    pinnedSessionIds: [...pinned],
    archivedSessionIds: [...archived],
    calls: [],
    async pinSession(id) {
      reg.calls.push(id)
      if (reg.pinnedSessionIds.includes(id)) return
      if (reg.archivedSessionIds.includes(id)) throw new Error('archived')
      if (unknown.includes(id)) throw new Error('unknown session')
      reg.pinnedSessionIds = [id, ...reg.pinnedSessionIds]
    },
  }
  return reg
}
const change = (pinnedSessionIds, over = {}) => ({ domain: 'workspace', table: '', operation: 'put', value: { pinnedSessionIds }, ...over })

test('pinning a session pins the rest of its group, keeping the group order', async () => {
  const groups = fresh()
  const g = groups.ensureGroup('s1', 'ws', { title: 'Alpha work' })
  groups.addToGroup(g.id, 's2'); groups.addToGroup(g.id, 's3')
  const reg = fakeRegistry()
  const pinner = createGroupPinner({ groups, registry: () => reg })
  reg.pinnedSessionIds = ['s2']
  await pinner.onChange(change(['s2']))
  assert.deepEqual(new Set(reg.pinnedSessionIds), new Set(['s1', 's2', 's3']))
  assert.deepEqual(reg.pinnedSessionIds.filter((id) => id !== 's2'), ['s1', 's3'])
})

test('a session in no group, and groups of other sessions, are left alone', async () => {
  const groups = fresh()
  groups.ensureGroup('s1', 'ws', { title: 'Alpha work' })
  const reg = fakeRegistry()
  const pinner = createGroupPinner({ groups, registry: () => reg })
  reg.pinnedSessionIds = ['loose']
  await pinner.onChange(change(['loose']))
  assert.deepEqual(reg.calls, [])
})

test('archived or unknown members are skipped and never stop the others', async () => {
  const groups = fresh()
  const g = groups.ensureGroup('s1', 'ws', { title: 'Alpha work' })
  for (const id of ['s2', 's3', 's4']) groups.addToGroup(g.id, id)
  const reg = fakeRegistry({ archived: ['s2'], unknown: ['s3'] })
  const traces = []
  const pinner = createGroupPinner({ groups, registry: () => reg, trace: (l) => traces.push(l) })
  reg.pinnedSessionIds = ['s1']
  await pinner.onChange(change(['s1']))
  assert.equal(reg.pinnedSessionIds.includes('s4'), true)
  assert.equal(reg.pinnedSessionIds.includes('s2'), false)
  assert.equal(traces.length >= 1, true)
})

test('only newly pinned sessions trigger it: unpinning, other tables and the starting pins do not', async () => {
  const groups = fresh()
  const g = groups.ensureGroup('s1', 'ws', { title: 'Alpha work' })
  groups.addToGroup(g.id, 's2')
  const reg = fakeRegistry({ pinned: ['s1'] }) // pinned before the plugin started: not retro-pinned
  const pinner = createGroupPinner({ groups, registry: () => reg })
  await pinner.onChange(change(['s1']))
  await pinner.onChange(change(['s1'], { domain: 'other' }))
  await pinner.onChange(change(['s1'], { table: 'workspaces' }))
  await pinner.onChange(change(['s1'], { operation: 'deleted' }))
  assert.deepEqual(reg.calls, [])
  reg.pinnedSessionIds = [] // the user unpins s1: the group stays as it is
  await pinner.onChange(change([]))
  assert.deepEqual(reg.calls, [])
  assert.equal(groups.groupOf('s1').sessionIds.length, 2)
})

test('a registry that is not ready (throws or is not a registry) never breaks construction, and learns the pins from the first change', async () => {
  const groups = fresh()
  const g = groups.ensureGroup('s1', 'ws', { title: 'Alpha work' })
  groups.addToGroup(g.id, 's2')
  assert.doesNotThrow(() => createGroupPinner({ groups, registry: () => { throw new Error('no registry yet') } }))
  assert.doesNotThrow(() => createGroupPinner({ groups, registry: () => new Proxy(function () {}, { get: () => function () {} }) }))
  const late = fakeRegistry()
  let ready = false
  const pinner = createGroupPinner({ groups, registry: () => (ready ? late : undefined) })
  ready = true
  late.pinnedSessionIds = ['s1']
  await pinner.onChange(change(['s1'])) // first sight of the pin set: no retroactive pinning
  assert.deepEqual(late.calls, [])
  late.pinnedSessionIds = ['s2', 's1']
  await pinner.onChange(change(['s2', 's1'])) // later pins are followed (s1 is already pinned here)
  assert.deepEqual(late.calls, [])
})

test('the pins it made itself do not loop, and a missing registry or malformed change is ignored', async () => {
  const groups = fresh()
  const g = groups.ensureGroup('s1', 'ws', { title: 'Alpha work' })
  groups.addToGroup(g.id, 's2')
  const reg = fakeRegistry()
  const pinner = createGroupPinner({ groups, registry: () => reg })
  reg.pinnedSessionIds = ['s1']
  await pinner.onChange(change(['s1']))
  const first = reg.calls.length
  await pinner.onChange(change(reg.pinnedSessionIds)) // the echo of our own pin of s2
  assert.equal(reg.calls.length, first)
  const none = createGroupPinner({ groups, registry: () => undefined })
  await none.onChange(change(['s1']))
  await pinner.onChange({ domain: 'workspace', table: '', operation: 'put', value: 'junk' })
  await pinner.onChange(undefined)
})
