import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, need, tick, source } from './client-todo-helpers.mjs'

// "View Changes" next to "Open session": opens the session like Open session does, then opens the Git tab (kind "git", dsh-git-view) in the
// right panel of that session. The right panel (ctx.sidebarRight) acts on the session on screen, so the call waits until that is the session.
const timers = () => {
  const q = []
  return { later: (fn, ms) => { q.push({ fn, ms }); return q.length }, run: () => { const t = q.shift(); if (t) t.fn(); return !!t }, q }
}
const sidebar = (mountedNow, opened = []) => ({ opened, mounted: { getSnapshot: () => (typeof mountedNow === 'function' ? mountedNow() : mountedNow) }, openTab: (kind, o) => opened.push([kind, o]) })

test('openGitTab opens the git tab at once when the session is already the one on screen', () => {
  const { T } = loadClient()
  need(T, 'openGitTab')
  const sb = sidebar('S1')
  T.openGitTab('S1', { sidebar: sb, later: () => {} })
  assert.deepEqual(sb.opened.map((o) => o[0]), ['git'])
})

test('openGitTab waits until the session is on screen, then opens the git tab once', () => {
  const { T } = loadClient()
  need(T, 'openGitTab')
  let current = 'OTHER'
  const sb = sidebar(() => current)
  const t = timers()
  T.openGitTab('S1', { sidebar: sb, later: t.later })
  assert.equal(sb.opened.length, 0)
  t.run()
  assert.equal(sb.opened.length, 0)
  current = 'S1'
  t.run()
  assert.deepEqual(sb.opened.map((o) => o[0]), ['git'])
  while (t.run());
  assert.equal(sb.opened.length, 1)
})

test('openGitTab gives up quietly when the session never shows, with no right panel service, or when openTab throws', () => {
  const { T } = loadClient()
  need(T, 'openGitTab')
  const sb = sidebar('OTHER')
  const t = timers()
  T.openGitTab('S1', { sidebar: sb, later: t.later })
  while (t.run());
  assert.equal(sb.opened.length, 0)
  assert.doesNotThrow(() => T.openGitTab('S1', { sidebar: undefined, later: () => {} }))
  assert.doesNotThrow(() => T.openGitTab('S1', { sidebar: { mounted: { getSnapshot: () => 'S1' }, openTab() { throw new Error('no git tab type') } }, later: () => {} }))
})

test('viewChanges opens the session, closes the overlay and then opens the git tab', async () => {
  const { T } = loadClient()
  need(T, 'viewChanges'); need(T, 'setHostOpen'); need(T, 'setHostSidebar')
  const sb = sidebar('S1')
  T.setHostOpen(async () => {})
  T.setHostSidebar(() => sb)
  T.set({ overlay: true })
  T.viewChanges({ id: 'i1', sessionId: 'S1' })
  await tick(); await tick()
  assert.equal(T.state.overlay, false)
  assert.deepEqual(sb.opened.map((o) => o[0]), ['git'])
})

test('viewChanges for a refused open does not open the git tab and shows the usual error', async () => {
  const { T } = loadClient()
  need(T, 'viewChanges')
  const sb = sidebar('S1')
  T.setHostOpen(async () => { throw new Error('gone') })
  T.setHostSidebar(() => sb)
  T.set({ overlay: true })
  T.viewChanges({ id: 'i1', sessionId: 'S1' })
  await tick(); await tick()
  assert.equal(T.state.overlay, true)
  assert.equal(T.state.errors.i1, 'That session no longer exists.')
  assert.equal(sb.opened.length, 0)
})

test('Open session alone does not open the git tab', async () => {
  const { T } = loadClient()
  const sb = sidebar('S1')
  T.setHostOpen(async () => {})
  T.setHostSidebar(() => sb)
  T.openSession({ id: 'i1', sessionId: 'S1' })
  await tick(); await tick()
  assert.equal(sb.opened.length, 0)
})

test('canViewChanges: needs both the session opener and the right panel service', () => {
  const { T } = loadClient()
  need(T, 'canViewChanges')
  assert.equal(T.canViewChanges(), false)
  T.setHostOpen(() => {})
  assert.equal(T.canViewChanges(), false)
  T.setHostSidebar(() => sidebar('S1'))
  assert.equal(T.canViewChanges(), true)
  T.setHostSidebar(undefined)
  assert.equal(T.canViewChanges(), false)
})

test('source: View Changes sits beside Open session on a started todo, an open card and a resolved card', () => {
  const todo = source.slice(source.indexOf('function TodoBody'), source.indexOf('function FollowUpBody'))
  const card = source.slice(source.indexOf('function Card('), source.indexOf('function HoldButton'))
  const resolved = source.slice(source.indexOf('function ResolvedCard'), source.indexOf('function ResolvedList'))
  for (const [name, body] of [['todo', todo], ['card', card], ['resolved', resolved]]) {
    assert.match(body, /View Changes/, name)
    assert.match(body, /viewChanges\(/, name)
    assert.match(body, /Open session/, name)
  }
})
