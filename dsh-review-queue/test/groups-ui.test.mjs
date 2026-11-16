// Slice 1: the model behind the group card (header facts, items oldest first, collapsed "AI handled N"). Pure; the React part is tested separately.
import test from 'node:test'
import assert from 'node:assert/strict'
import { groupOpen, groupIdOf } from '../groups.js'
import { groupCardModel, aiHandledLine, groupsOfOpen, indexResolved } from '../lib/groups-ui.js'

test('groupsOfOpen groups a snapshot open list by groupId, in first-seen order, items oldest first', () => {
  const open = [
    item({ id: 'a1', groupId: 's1', createdAt: 100, tier: { tier: 2 } }),
    item({ id: 'b1', groupId: 's2', sessionId: 's2', createdAt: 110 }),
    item({ id: 'a2', groupId: 's1', createdAt: 120, tier: { tier: 1 } }),
  ]
  const gs = groupsOfOpen(open)
  assert.deepEqual(gs.map((g) => g.id), ['s1', 's2'])
  assert.deepEqual(gs[0].items.map((i) => i.id), ['a1', 'a2'])
  assert.equal(gs[0].count, 2)
  assert.equal(gs[0].topTier, 1)
  assert.equal(gs[0].createdAt, 100)
  assert.deepEqual(groupsOfOpen(undefined), [])
  assert.equal(groupsOfOpen([item({ id: 'z' })])[0].id, 'item:z', 'an item without groupId stands alone')
})

const item = (over) => ({ id: 'i' + Math.random(), type: 'completed', status: 'open', sessionId: 's1', sessionTitle: 'Work', workspace: 'ws', createdAt: 100, ...over })
const ai = (over) => item({ status: 'resolved', resolvedAt: 150, resolution: { kind: 'ai-resolved' }, ...over })

test('two items without createdAt keep a stable order (seq), same in groups.js and groupsOfOpen', () => {
  const open = [item({ id: 'p', createdAt: undefined, seq: 2 }), item({ id: 'q', createdAt: undefined, seq: 1 }), item({ id: 'r', createdAt: 5, seq: 3 })]
  const a = groupOpen(open)[0].items.map((i) => i.id)
  const b = groupsOfOpen(open.map((i) => ({ ...i, groupId: 's1' })))[0].items.map((i) => i.id)
  assert.deepEqual(a, ['r', 'q', 'p'])
  assert.deepEqual(b, a)
})

test('parity: groupsOfOpen and groupOpen agree on membership, order, count and top tier', () => {
  const open = [
    item({ id: 'a', sessionId: 's1', createdAt: 3, seq: 1, tier: { tier: 2 } }),
    item({ id: 'b', sessionId: 's2', createdAt: 1, seq: 2 }),
    item({ id: 'c', sessionId: 's1', createdAt: 2, seq: 3, tier: { tier: 0 } }),
    item({ id: 'd', sessionId: undefined, type: 'todo', createdAt: 4, seq: 4 }),
  ]
  const server = groupOpen(open)
  const client = groupsOfOpen(open.map((i) => ({ ...i, groupId: groupOpen([i])[0].id }))).sort((x, y) => x.createdAt - y.createdAt)
  const pick = (gs) => gs.map((g) => [g.id, g.items.map((i) => i.id), g.count, g.topTier])
  assert.deepEqual(pick(client), pick(server))
})

test('header: title, workspace, top tier, count, age of the oldest open item', () => {
  const [g] = groupOpen([item({ id: 'a', createdAt: 200, tier: { tier: 2 } }), item({ id: 'b', createdAt: 100, tier: { tier: 1 } })])
  const m = groupCardModel(g, [])
  assert.equal(m.title, 'Work')
  assert.equal(m.workspace, 'ws')
  assert.equal(m.topTier, 1)
  assert.equal(m.count, 2)
  assert.equal(m.createdAt, 100)
  assert.deepEqual(m.items.map((i) => i.id), ['b', 'a'])
})

test('AI handled counts only this session\'s AI-resolved or auto-cleared items resolved since the oldest open item', () => {
  const [g] = groupOpen([item({ id: 'a', createdAt: 100 })])
  const resolved = [
    ai({ id: 'x1', resolvedAt: 150 }),
    ai({ id: 'x2', resolvedAt: 90 }), // before the group began
    ai({ id: 'x3', sessionId: 'other' }),
    item({ id: 'x4', status: 'resolved', resolvedAt: 160, resolution: { kind: 'no-action', by: 'auto' } }),
    item({ id: 'x5', status: 'resolved', resolvedAt: 160, resolution: { kind: 'no-action', by: 'user' } }),
  ]
  assert.equal(groupCardModel(g, resolved).aiHandled, 2)
})

test('a group whose items carry no session title gets a neutral label, not one card title', () => {
  const [g] = groupOpen([item({ id: 'a', sessionTitle: undefined, title: 'Fix parser' }), item({ id: 'b', sessionTitle: undefined, title: 'Other' })])
  assert.equal(groupCardModel(g, []).title, 'Session')
})

test('an indexed resolved list gives the same AI handled count as the raw list', () => {
  const [g] = groupOpen([item({ id: 'a', createdAt: 100 }), item({ id: 'b', createdAt: 120 })])
  const resolved = [ai({ id: 'x1', resolvedAt: 150 }), ai({ id: 'x2', resolvedAt: 90 }), ai({ id: 'x3', sessionId: 'other' })]
  assert.equal(groupCardModel(g, indexResolved(resolved)).aiHandled, groupCardModel(g, resolved).aiHandled)
  assert.equal(groupCardModel(g, indexResolved(resolved)).aiHandled, 1)
})

test('a single-card group has no AI handled line and bad input is harmless', () => {
  const [g] = groupOpen([item({ id: 'a', sessionId: undefined, type: 'todo' })])
  assert.equal(groupCardModel(g, [ai({})]).aiHandled, 0)
  assert.equal(groupCardModel(g, undefined).aiHandled, 0)
  assert.equal(aiHandledLine(0), '')
  assert.equal(aiHandledLine(1), 'AI handled 1')
  assert.equal(aiHandledLine(3), 'AI handled 3')
})

test('groupsOfOpen orders items by last update like groupOpen (updatedAt, else createdAt)', () => {
  const open = [item({ id: 'a', sessionId: 's1', createdAt: 1, updatedAt: 9, seq: 1 }), item({ id: 'b', sessionId: 's1', createdAt: 5, seq: 2 })]
  const server = groupOpen(open)[0].items.map((i) => i.id)
  const client = groupsOfOpen(open.map((i) => ({ ...i, groupId: 's1' })))[0].items.map((i) => i.id)
  assert.deepEqual(server, ['b', 'a'])
  assert.deepEqual(client, server)
})

// groups-ui.js cannot import groups.js (the overlay bundle), so its copy of the age order is pinned to the server's on the same fixtures.
test('groupsOfOpen orders items and groups exactly like groups.js groupOpen (updatedAt, missing createdAt, seq ties)', () => {
  const raw = [
    { id: 'a', sessionId: 's1', createdAt: 100, seq: 3 },
    { id: 'b', sessionId: 's1', createdAt: 100, seq: 1 },
    { id: 'c', sessionId: 's1', createdAt: 50, updatedAt: 200, seq: 2 },
    { id: 'd', sessionId: 's2', seq: 5 },
    { id: 'e', sessionId: 's2', createdAt: 70, seq: 4, tier: { tier: 2 } },
    { id: 'f', sessionId: 's3', seq: 7 },
    { id: 'g', sessionId: 's3', seq: 6 },
    { id: 'h', type: 'todo', sessionId: 's1', createdAt: 10, seq: 8 },
    { id: 'i', createdAt: 5, seq: 9, tier: { tier: 1 } },
  ]
  const open = raw.map((i) => ({ ...i, type: i.type ?? 'question', status: 'open', groupId: groupIdOf({ type: i.type ?? 'question', ...i }) }))
  const shape = (gs) => gs.map((g) => ({ id: g.id, ids: g.items.map((i) => i.id), createdAt: g.createdAt, count: g.count, topTier: g.topTier }))
  assert.deepEqual(shape(groupsOfOpen(open)).sort((x, y) => x.id.localeCompare(y.id)), shape(groupOpen(open)).sort((x, y) => x.id.localeCompare(y.id)))
})