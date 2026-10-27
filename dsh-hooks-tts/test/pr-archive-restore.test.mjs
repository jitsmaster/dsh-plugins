/**
 * A session that polls a still-open PR must not stay archived: pr.js exposes the guard (archiveGuard) and, when such a session
 * newly appears in the archived set (the host sidebar cannot be vetoed), unarchives it and re-registers its poll, unless pr.js
 * archived it itself because the PR is over.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPrPoller } from '../pr.js'
import { createSettings } from '../settings.js'
import { fakeSchedule, until } from './pr-schedule-helpers.mjs'

const PAT = 'sup3r-secret-pat'

function world({ prStatus = 'active', unarchive = true, titles = {}, restoreDelayMs = 0, withSchedule = false, signal, ...settingsExtra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pra-'))
  const settings = createSettings(dir, settingsExtra)
  const state = { prStatus, fetchError: false, archived: [], unarchives: [], archives: [], titles, urls: [] }
  const handlers = {}
  const fire = async (event, ...args) => { for (const fn of handlers[event] ?? []) await fn(...args, async () => ({ kind: 'continue' })) }
  const changed = () => fire('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: [...state.archived] } })
  const registry = {
    list: () => [{ sessionIds: ['a1', ...Object.keys(state.titles)] }],
    get archivedSessionIds() { return state.archived },
    archiveSession: async (id, opts) => { state.archives.push([id, opts]); state.archived.push(id); await changed() },
    ...(unarchive ? { unarchiveSession: async (id) => { state.unarchives.push(id); state.archived = state.archived.filter((x) => x !== id); await changed() } } : {}),
  }
  const schedule = fakeSchedule()
  const ctx = {
    logger: { warn() {}, info() {} },
    get: (name) => {
      if (name === 'schedule') return withSchedule ? schedule.service : undefined
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessionTitle') return { get: () => ({ title: 'PR 5' }) }
      if (name === 'sessionController') return { rename: async () => {}, prompt: async () => {} }
      if (name === 'sessionQuery') return { readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', value: { title: { title: state.titles[id] ?? 'work' } } })) }
      return undefined
    },
    on: (event, fn) => { (handlers[event] ??= []).push(fn) },
  }
  const fetchImpl = async (url) => {
    state.urls.push(url)
    if (state.fetchError) throw new Error('network down')
    if (state.prNotFound) return { ok: false, status: 404, json: async () => ({}) }
    if (url.includes('/build/builds')) return { ok: true, status: 200, json: async () => ({ value: [] }) }
    const body = url.includes('/threads') ? { value: [] } : { pullRequestId: 5, status: state.prStatus, lastMergeSourceCommit: { commitId: 'c1' }, targetRefName: 'refs/heads/develop' }
    return { ok: true, status: 200, json: async () => body }
  }
  const poller = installPrPoller(ctx, {}, { settings, fetchImpl, env: { AZURE_DEVOPS_EXT_PAT: PAT }, restoreDelayMs, signal, onPrMerged: async () => {} })
  const log = () => { const p = join(dir, 'spawn.log'); return existsSync(p) ? readFileSync(p, 'utf8') : '' }
  /** The user archives the session in the sidebar: the registry gains the id and tells the plugin. */
  const sidebarArchive = async (id = 'a1') => { state.archived.push(id); await changed() }
  /** The user unarchives the session. */
  const userUnarchive = async (id = 'a1') => { state.archived = state.archived.filter((x) => x !== id); await changed() }
  return { poller, state, settings, log, sidebarArchive, userUnarchive, changed, registry, schedule, fire }
}

// ---- guard exposed by the poller ----

test('archiveGuard: the live poll session of an active PR is protected, a completed PR is not', async () => {
  const open = world()
  open.poller.register({ id: 'a1' }, '5')
  assert.deepEqual(await open.poller.archiveGuard.check('a1'), { protected: true, prId: '5', status: 'active' })
  const over = world({ prStatus: 'completed' })
  over.poller.register({ id: 'a1' }, '5')
  assert.equal((await over.poller.archiveGuard.check('a1')).protected, false)
})

test('archiveGuard: a lookup failure counts as still open', async () => {
  const w = world()
  w.poller.register({ id: 'a1' }, '5')
  w.state.fetchError = true
  assert.deepEqual(await w.poller.archiveGuard.check('a1'), { protected: true, prId: '5', status: 'unknown' })
})

test('archiveGuard: a session titled "PR <n>" that was never registered is protected through its title; a follow-up title is not', async () => {
  const w = world({ titles: { x1: 'PR 7 - Fix: thing - 12345', x2: 'Fix: thing - after PR 7', x3: 'work' } })
  assert.deepEqual(await w.poller.archiveGuard.check('x1'), { protected: true, prId: '7', status: 'active' })
  assert.equal((await w.poller.archiveGuard.check('x2')).protected, false)
  assert.equal((await w.poller.archiveGuard.check('x3')).protected, false)
})

test('archiveGuard: a finished PR is not protected and needs no lookup', async () => {
  const w = world({ prStatus: 'completed' })
  w.poller.register({ id: 'a1' }, '5')
  await w.poller.poll('a1') // sees the completed PR, marks it finished, archives the session itself
  const before = w.state.urls.length
  assert.equal((await w.poller.archiveGuard.check('a1')).protected, false)
  assert.equal(w.state.urls.length, before)
})

test('archiveGuard: protectPrSessions off protects nothing', async () => {
  const w = world({ protectPrSessions: false })
  w.poller.register({ id: 'a1' }, '5')
  assert.equal((await w.poller.archiveGuard.check('a1')).protected, false)
})

test('archiveGuard: a PR that does not exist (HTTP 404) is not protected, so a stray "PR <n>" title can still be archived', async () => {
  const w = world({ titles: { x1: 'PR 99' } })
  w.state.prNotFound = true
  assert.equal((await w.poller.archiveGuard.check('x1')).protected, false)
  w.state.prNotFound = false
  w.state.fetchError = true
  assert.equal((await world({ titles: { x1: 'PR 99' } }).poller.archiveGuard.check('x1')).protected, true, 'a network failure still counts as open')
})

// ---- restore ----

test('restore: a protected PR session archived elsewhere is unarchived and polled again', async () => {
  const w = world()
  w.poller.register({ id: 'a1' }, '5')
  await w.sidebarArchive()
  assert.ok(await until(() => w.state.unarchives.length === 1), 'unarchived')
  assert.deepEqual(w.state.unarchives, ['a1'])
  assert.match(w.log(), /PR 5 is still open: unarchived session a1/)
  assert.ok(await until(() => /stopped polling PR 5 for a1: session archived[\s\S]*polling PR 5 for a1/.test(w.log())), 'stopped by the archive, registered again after the unarchive')
  assert.ok(w.poller.has('a1'), 'the poll is registered again')
})

test('restore: a PR that pr.js archives itself because it is over is not restored', async () => {
  const w = world({ prStatus: 'completed' })
  w.poller.register({ id: 'a1' }, '5')
  await w.poller.poll('a1')
  await until(() => w.state.archives.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(w.state.archives.map(([id]) => id), ['a1'])
  assert.deepEqual(w.state.unarchives, [])
  assert.doesNotMatch(w.log(), /unarchived session/)
})

test('restore: a session of a PR that is over by the time it is archived stays archived', async () => {
  const w = world()
  w.poller.register({ id: 'a1' }, '5')
  w.state.prStatus = 'abandoned'
  await w.sidebarArchive()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(w.state.unarchives, [])
})

test('restore: a status lookup that fails still restores (counts as open)', async () => {
  const w = world()
  w.poller.register({ id: 'a1' }, '5')
  w.state.fetchError = true
  await w.sidebarArchive()
  assert.ok(await until(() => w.state.unarchives.length === 1))
})

test('restore: off with protectPrSessions, and for sessions this process never polled', async () => {
  const off = world({ protectPrSessions: false })
  off.poller.register({ id: 'a1' }, '5')
  await off.sidebarArchive()
  const stranger = world()
  await stranger.sidebarArchive('zz') // archived long ago / never polled here
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(off.state.unarchives, [])
  assert.deepEqual(stranger.state.unarchives, [])
})

test('restore: a session is restored once; archiving it again is deliberate and sticks, with a trace', async () => {
  const w = world()
  w.poller.register({ id: 'a1' }, '5')
  await w.sidebarArchive()
  assert.ok(await until(() => w.state.unarchives.length === 1), 'restored once')
  assert.ok(await until(() => w.poller.has('a1')))
  await w.sidebarArchive()
  assert.ok(await until(() => /a1 was archived again after its restore; leaving it archived/.test(w.log())))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(w.state.unarchives.length, 1)
  assert.deepEqual(w.state.archived, ['a1'])
})

test('restore: the one restore is available again after the session was deleted', async () => {
  const w = world()
  w.poller.register({ id: 'a1' }, '5')
  await w.sidebarArchive()
  assert.ok(await until(() => w.state.unarchives.length === 1))
  await w.fire('agent/disposed', { agent: { id: 'a1' } })
  w.poller.register({ id: 'a1' }, '5')
  await w.sidebarArchive()
  assert.ok(await until(() => w.state.unarchives.length === 2), 'a session id that starts over is protected again')
})

test('restore: a failed unarchive does not use up the restore', async () => {
  const w = world()
  const unarchive = w.registry.unarchiveSession
  w.registry.unarchiveSession = async () => { throw new Error('registry broke') }
  w.poller.register({ id: 'a1' }, '5')
  await w.sidebarArchive()
  assert.ok(await until(() => /could not unarchive a1: registry broke/.test(w.log())))
  w.registry.unarchiveSession = unarchive
  await w.userUnarchive()
  w.poller.register({ id: 'a1' }, '5')
  await w.sidebarArchive()
  assert.ok(await until(() => w.state.unarchives.length === 1), 'restored on the next archive')
})

test('restore: a manual unarchive during the pause does not use up the restore', async () => {
  const w = world({ restoreDelayMs: 150 })
  w.poller.register({ id: 'a1' }, '5')
  await w.sidebarArchive()
  await new Promise((resolve) => setTimeout(resolve, 60)) // inside the pause: the status lookup is done, the unarchive is not
  await w.userUnarchive()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(w.state.unarchives, [])
  await w.sidebarArchive()
  assert.ok(await until(() => w.state.unarchives.length === 1), 'the next archive is still restored')
})

test('restore: a disposed plugin does not unarchive or register a poll after the pause', async () => {
  const controller = new AbortController()
  const w = world({ restoreDelayMs: 40, signal: controller.signal })
  w.poller.register({ id: 'a1' }, '5')
  await w.sidebarArchive()
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(w.state.unarchives, [])
  assert.equal(w.poller.has('a1'), false)
})

test('a session renamed away from "PR <n>" is neither restored nor protected', async () => {
  const w = world({ withSchedule: true })
  w.poller.register({ id: 'a1' }, '5')
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 1), 'precondition: the poll task exists')
  await w.fire('session/event', { id: 'a1' }, { type: 'session/title', data: { title: 'refactor the parser' } })
  assert.ok(await until(() => w.schedule.tasksOf('a1').length === 0), 'precondition: title-away dropped the task')
  await w.sidebarArchive()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(w.state.unarchives, [])
  assert.equal((await w.poller.archiveGuard.check('a1')).protected, false)
})

test('restore: a registry without unarchiveSession is tolerated and traced', async () => {
  const w = world({ unarchive: false })
  w.poller.register({ id: 'a1' }, '5')
  await w.sidebarArchive()
  assert.ok(await until(() => /cannot unarchive a1/.test(w.log())))
})

test('restore: a failing unarchive is traced and never throws', async () => {
  const w = world()
  w.registry.unarchiveSession = async () => { throw new Error('registry broke') }
  w.poller.register({ id: 'a1' }, '5')
  await w.sidebarArchive()
  assert.ok(await until(() => /could not unarchive a1: registry broke/.test(w.log())))
})
