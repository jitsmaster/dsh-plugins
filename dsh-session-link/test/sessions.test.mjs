import test from 'node:test'
import assert from 'node:assert/strict'
import { listPeers, isSubagent } from '../sessions.js'

const items = [
  { sessionId: 's1', updatedAt: 5, cwd: 'D:\\dev\\CTnP-Final', projections: { values: { title: 'Fix 25883' } }, running: true },
  { sessionId: 's2', updatedAt: 9, cwd: 'D:\\dev\\ai\\dsh-plugins' },
  { sessionId: 's3', updatedAt: 1, parentSessionId: 's1', cwd: 'D:\\x' },
  { sessionId: 's4', updatedAt: 2, origin: 'subagent', cwd: 'D:\\x' },
  { sessionId: 's5', updatedAt: 3, blank: true, cwd: 'D:\\x' },
  { sessionId: 's6', updatedAt: 4, cwd: 'D:\\y', projections: { values: { title: 'Archived one' } } },
  { sessionId: 'me', updatedAt: 8, cwd: 'D:\\z', projections: { values: { title: 'Me' } } },
  { sessionId: 'bad id', updatedAt: 7, cwd: 'D:\\x' },
]
const controller = { list: async () => ({ items }) }
const registry = { archivedSessionIds: new Set(['s6']) }

test('drops sub-agents, blank, archived, the caller and invalid ids; newest first', async () => {
  const peers = await listPeers({ controller, registry, senderId: 'me' })
  assert.deepEqual(peers.map((p) => p.sessionId), ['s2', 's1'])
})

test('title falls back to the folder name, then Untitled; workspace is the folder name', async () => {
  const peers = await listPeers({ controller, registry, senderId: 'me' })
  assert.equal(peers[0].title, 'dsh-plugins')
  assert.equal(peers[1].title, 'Fix 25883')
  assert.equal(peers[1].workspace, 'CTnP-Final')
  assert.equal(peers[1].running, true)
  const bare = await listPeers({ controller: { list: async () => ({ items: [{ sessionId: 'q', updatedAt: 1 }] }) }, registry: undefined, senderId: 'me' })
  assert.equal(bare[0].title, 'Untitled session')
})

test('titles are clipped to 200 characters', async () => {
  const c = { list: async () => ({ items: [{ sessionId: 'q', cwd: 'D:\\a', projections: { values: { title: 'x'.repeat(500) } } }] }) }
  assert.equal((await listPeers({ controller: c, senderId: 'me' }))[0].title.length, 200)
})

test('no controller or a failing list gives an error the caller can show', async () => {
  await assert.rejects(listPeers({ controller: undefined, senderId: 'me' }), /session controller/)
  await assert.rejects(listPeers({ controller: { list: async () => { throw new Error('boom') } }, senderId: 'me' }), /could not list sessions/)
})

test('isSubagent reads the session header', () => {
  assert.equal(isSubagent({ session: { header: { origin: 'subagent' } } }), true)
  assert.equal(isSubagent({ session: { header: { parentSession: 'p' } } }), true)
  assert.equal(isSubagent({ session: { header: {} } }), false)
  assert.equal(isSubagent(undefined), false)
})

test('caps the result at 200, newest first', async () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ sessionId: 'p' + i, updatedAt: i, cwd: 'D:\\w' }))
  const peers = await listPeers({ controller: { list: async () => ({ items: many }) }, senderId: 'me' })
  assert.equal(peers.length, 200)
  assert.equal(peers[0].sessionId, 'p249')
  assert.equal(peers[199].sessionId, 'p50')
})

test('a non-iterable archivedSessionIds gives the structured list error', async () => {
  await assert.rejects(listPeers({ controller, registry: { archivedSessionIds: 5 }, senderId: 'me' }), /could not list sessions/)
})
