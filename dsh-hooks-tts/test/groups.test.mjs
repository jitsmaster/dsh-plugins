import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGroups, applyMove, buildGroupsView, deriveGroupName } from '../groups.js'
import { chmodSync, mkdirSync } from 'node:fs'

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
  assert.equal(applyMove(groups, { sessionId: 's2', groupId: a.id }, wsOf, () => true).status, 200)
  assert.deepEqual(groups.groupOf('s2').sessionIds, ['s1', 's2'])
  assert.equal(applyMove(groups, { sessionId: 's9', groupId: a.id }, wsOf, () => true).status, 409) // other workspace
  assert.equal(applyMove(groups, { sessionId: 's2', groupId: 'nope' }, wsOf, () => true).status, 404)
  assert.equal(applyMove(groups, { sessionId: '', groupId: a.id }, wsOf).status, 400)
  assert.equal(applyMove(groups, { sessionId: 's2', groupId: 5 }, wsOf, () => true).status, 400)
  assert.equal(applyMove(groups, { sessionId: 's2', groupId: null }, wsOf).status, 200)
  assert.equal(groups.groupOf('s2'), undefined)
  const created = applyMove(groups, { sessionId: 's9', newGroupName: 'Fresh' }, wsOf, () => true)
  assert.equal(created.status, 200)
  assert.equal(groups.groupOf('s9').name, 'Fresh')
  assert.equal(groups.groupOf('s9').workspaceId, 'ws2')
  assert.equal(applyMove(groups, { sessionId: 's9', newGroupName: '  ' }, wsOf, () => true).status, 400)
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
  assert.equal(applyMove(groups, { sessionId: 's2', groupId: g.id }, () => 'ws1', () => true).status, 200)
  assert.equal(groups.list()[0].workspaceId, 'ws1')
  assert.equal(applyMove(groups, { sessionId: 's3', groupId: g.id }, () => 'ws2', () => true).status, 409)
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

// ---- manual group creation (empty groups) ----

test('createGroup without a session makes an empty manual group that survives moves and restarts', () => {
  const groups = fresh()
  const g = groups.createGroup('Planning', undefined, 'ws1')
  assert.deepEqual(g.sessionIds, [])
  assert.equal(g.manual, true)
  const auto = groups.ensureGroup('s1', 'ws1', { title: 'Alpha work' })
  groups.moveSession('s1', null) // drops the emptied auto group, must not drop the manual one
  assert.equal(groups.list().some((x) => x.id === auto.id), false)
  assert.equal(groups.list().some((x) => x.id === g.id), true)
  assert.equal(createGroups(groups.path.replace(/groups\.json$/, '')).list().some((x) => x.id === g.id), true)
})

test('a group created around a session vanishes when emptied; one created empty stays', () => {
  const groups = fresh()
  groups.createGroup('Around', 's1', 'ws1')
  const empty = groups.createGroup('Planning', undefined, 'ws1')
  groups.moveSession('s1', null)
  assert.deepEqual(groups.list().map((x) => x.id), [empty.id])
})

test('deleteGroup removes only an empty group', () => {
  const groups = fresh()
  const g = groups.createGroup('Planning', undefined, 'ws1')
  groups.addToGroup(g.id, 's1')
  assert.throws(() => groups.deleteGroup(g.id), /not empty/)
  groups.moveSession('s1', null)
  groups.deleteGroup(g.id)
  assert.equal(groups.list().length, 0)
  assert.throws(() => groups.deleteGroup('nope'), /unknown group/)
})

test('applyMove: create an empty group in a known workspace; delete an empty group', () => {
  const groups = fresh()
  const workspaces = () => [{ id: 'ws1', title: 'Alpha' }]
  const none = () => undefined
  assert.equal(applyMove(groups, { newGroupName: 'Planning', workspaceId: 'ws1' }, none, () => true, workspaces).status, 200)
  const g = groups.list()[0]
  assert.equal(g.name, 'Planning')
  assert.equal(g.workspaceId, 'ws1')
  assert.equal(applyMove(groups, { newGroupName: 'X', workspaceId: 'zzz' }, none, () => true, workspaces).status, 404)
  assert.equal(applyMove(groups, { newGroupName: 'X' }, none, () => true, workspaces).status, 400)
  assert.equal(applyMove(groups, { newGroupName: '  ', workspaceId: 'ws1' }, none, () => true, workspaces).status, 400)
  assert.equal(applyMove(groups, { newGroupName: 'X', workspaceId: 'ws1' }, none, () => true, undefined).status, 404) // workspaces unknown
  assert.equal(applyMove(groups, { deleteGroupId: 'nope' }, none, () => true, workspaces).status, 404)
  groups.addToGroup(g.id, 's1')
  assert.equal(applyMove(groups, { deleteGroupId: g.id }, none, () => true, workspaces).status, 409)
  groups.moveSession('s1', null)
  assert.equal(applyMove(groups, { deleteGroupId: g.id }, none, () => true, workspaces).status, 200)
  assert.equal(groups.list().length, 0)
})

test('buildGroupsView: carries manual flag, empty groups and the workspace list', () => {
  const groups = fresh()
  groups.createGroup('Planning', undefined, 'ws1')
  const view = buildGroupsView(groups.list(), [], [{ id: 'ws1', title: 'Alpha' }])
  assert.equal(view.groups[0].manual, true)
  assert.deepEqual(view.groups[0].members, [])
  assert.deepEqual(view.workspaces, [{ id: 'ws1', title: 'Alpha' }])
})

test('deriveGroupName: credentials in the first request are redacted', () => {
  const name = deriveGroupName({ title: 'Untitled', request: 'deploy with token=abcd1234secretvalue now', cwd: 'D:/x/proj' })
  assert.ok(!name.includes('abcd1234secretvalue'), name)
  assert.ok(!deriveGroupName({ request: 'use ghp_ABCDEFGHIJKLMNOPQRSTUV for it' }).includes('ghp_ABCDEF'))
})

test('createGroup refuses at the cap when every group has members, and never evicts a group with members', () => {
  const groups = fresh()
  for (let i = 0; i < 200; i++) groups.ensureGroup('s' + i, 'ws', { title: 'Work ' + i })
  assert.throws(() => groups.createGroup('One more', undefined, 'ws'), /too many/)
  assert.equal(groups.list().length, 200)
  assert.ok(groups.list().every((g) => g.sessionIds.length === 1))
})

test('applyMove answers 500 when the change could not be saved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groups-'))
  const groups = createGroups(dir)
  const g = groups.createGroup('Keep', undefined, 'ws')
  mkdirSync(join(dir, 'groups.json.tmp'))   // a directory where the temp file goes: the write must fail
  const res = applyMove(groups, { deleteGroupId: g.id }, () => undefined, () => true)
  assert.equal(res.status, 500)
})
