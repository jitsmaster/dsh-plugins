// Slice 1: the overlay loads lib/groups-ui.js lazily from /review-queue/m/groups-ui.js, once, and retries after a failure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './client-todo-helpers.mjs'

const { T } = loadClient()

test('loadGroupsUi imports the module once and caches it', async () => {
  const urls = []
  T.setGroupsImporter((u) => { urls.push(u); return Promise.resolve({ groupsOfOpen: () => [] }) })
  const a = await T.loadGroupsUi()
  const b = await T.loadGroupsUi()
  assert.equal(a, b)
  assert.deepEqual([...urls], ['/review-queue/m/groups-ui.js'])
})

test('requestGroupsUi asks once per page: a render loop does not re-import, even after a failure', async () => {
  let n = 0
  T.setGroupsImporter(() => { n++; return Promise.reject(new Error('404')) })
  T.requestGroupsUi(() => {})
  T.requestGroupsUi(() => {})
  T.requestGroupsUi(() => {})
  await new Promise((r) => setImmediate(r))
  T.requestGroupsUi(() => {})
  assert.equal(n, 1)
})

test('a failed import is not cached: the next call tries again', async () => {
  let n = 0
  T.setGroupsImporter(() => (++n === 1 ? Promise.reject(new Error('x')) : Promise.resolve({ ok: true })))
  await assert.rejects(T.loadGroupsUi())
  assert.deepEqual({ ...(await T.loadGroupsUi()) }, { ok: true })
})
