import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGroups, applyMove, buildGroupsView } from '../groups.js'

const fresh = () => createGroups(mkdtempSync(join(tmpdir(), 'groups-')))

test('moveSession: moves a session between groups and out of every group', () => {
  const groups = fresh()
  const a = groups.ensureGroup('s1', 'ws', { title: 'Alpha work' })
  groups.addToGroup(a.id, 's2')
  const b = groups.ensureGroup('s3', 'ws', { title: 'Beta work' })
  groups.moveSession('s2', b.id)
  assert.deepEqual(groups.groupOf('s2').sessionIds, ['s3', 's2'])
  assert.deepEqual(groups.groupOf('s1').sessionIds, ['s1'])
  groups.moveSession('s2', null)
  assert.equal(groups.groupOf('s2'), undefined)
})

test('moveSession: a session that was in no group can be moved in; an unknown group is refused', () => {
  const groups = fresh()
  const a = groups.ensureGroup('s1', 'ws', { title: 'Alpha work' })
  groups.moveSession('loose', a.id)
  assert.deepEqual(groups.groupOf('loose').sessionIds, ['s1', 'loose'])
  assert.throws(() => groups.moveSession('loose', 'nope'), /unknown group/)
})

test('a group left empty by a move is removed', () => {
  const groups = fresh()
  const a = groups.ensureGroup('s1', 'ws', { title: 'Alpha work' })
  const b = groups.ensureGroup('s2', 'ws', { title: 'Beta work' })
  groups.moveSession('s1', b.id)
  assert.equal(groups.list().some((g) => g.id === a.id), false)
  groups.moveSession('s1', null)
  groups.moveSession('s2', null)
  assert.equal(groups.list().length, 0)
})

test('createGroup: a new named group holding the session, trimmed and clipped; blank names refused', () => {
  const groups = fresh()
  const g = groups.createGroup('  My new group  ', 's1', 'ws')
  assert.equal(g.name, 'My new group')
  assert.deepEqual(groups.groupOf('s1').sessionIds, ['s1'])
  assert.throws(() => groups.createGroup('   ', 's1', 'ws'), /name/)
  assert.equal(groups.createGroup('x'.repeat(200), 's2', 'ws').name.length <= 61, true)
})

test('applyMove: validates the request and enforces the workspace', () => {
  const groups = fresh()
  const a = groups.ensureGroup('s1', 'ws1', { title: 'Alpha work' })
  const wsOf = (id) => ({ s1: 'ws1', s2: 'ws1', s9: 'ws2' })[id]
  assert.equal(applyMove(groups, { sessionId: 's2', groupId: a.id }, wsOf).status, 200)
  assert.deepEqual(groups.groupOf('s2').sessionIds, ['s1', 's2'])
  assert.equal(applyMove(groups, { sessionId: 's9', groupId: a.id }, wsOf).status, 409) // other workspace
  assert.equal(applyMove(groups, { sessionId: 's2', groupId: 'nope' }, wsOf).status, 404)
  assert.equal(applyMove(groups, { sessionId: '', groupId: a.id }, wsOf).status, 400)
  assert.equal(applyMove(groups, { sessionId: 's2', groupId: 5 }, wsOf).status, 400)
  assert.equal(applyMove(groups, { sessionId: 's2', groupId: null }, wsOf).status, 200)
  assert.equal(groups.groupOf('s2'), undefined)
  const created = applyMove(groups, { sessionId: 's9', newGroupName: 'Fresh' }, wsOf)
  assert.equal(created.status, 200)
  assert.equal(groups.groupOf('s9').name, 'Fresh')
  assert.equal(groups.groupOf('s9').workspaceId, 'ws2')
  assert.equal(applyMove(groups, { sessionId: 's9', newGroupName: '  ' }, wsOf).status, 400)
})

test('buildGroupsView: members carry titles; sessions list their group; ids missing from the live list are still shown', () => {
  const groups = fresh()
  const a = groups.ensureGroup('s1', 'ws1', { title: 'Alpha work' })
  groups.addToGroup(a.id, 'gone')
  const view = buildGroupsView(groups.list(), [{ id: 's1', title: 'Original', workspaceId: 'ws1' }, { id: 's5', title: 'Loose', workspaceId: 'ws1' }])
  assert.deepEqual(view.groups[0].members, [{ id: 's1', title: 'Original', live: true }, { id: 'gone', title: undefined, live: false }])
  assert.deepEqual(view.sessions.find((s) => s.id === 's5'), { id: 's5', title: 'Loose', workspaceId: 'ws1', groupId: undefined })
  assert.equal(view.sessions.find((s) => s.id === 's1').groupId, a.id)
})

test('applyMove: joining a workspace-less group gives it the session workspace', () => {
  const groups = fresh()
  const g = groups.ensureGroup('s1', undefined, { title: 'Alpha work' })
  assert.equal(applyMove(groups, { sessionId: 's2', groupId: g.id }, () => 'ws1').status, 200)
  assert.equal(groups.list()[0].workspaceId, 'ws1')
  assert.equal(applyMove(groups, { sessionId: 's3', groupId: g.id }, () => 'ws2').status, 409)
})

test('applyMove: joining or creating a group needs a live session; removing a closed one is still allowed', () => {
  const groups = fresh()
  const g = groups.ensureGroup('s1', 'ws1', { title: 'Alpha work' })
  groups.addToGroup(g.id, 'closed')
  const live = (id) => id === 's1' || id === 's2'
  assert.equal(applyMove(groups, { sessionId: 'fake', groupId: g.id }, () => 'ws1', live).status, 404)
  assert.equal(applyMove(groups, { sessionId: 'fake', newGroupName: 'X' }, () => 'ws1', live).status, 404)
  assert.equal(applyMove(groups, { sessionId: 's2', groupId: g.id }, () => 'ws1', live).status, 200)
  assert.equal(applyMove(groups, { sessionId: 'closed', groupId: null }, () => undefined, live).status, 200)
  assert.equal(groups.groupOf('closed'), undefined)
})
