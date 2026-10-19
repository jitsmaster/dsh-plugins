import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createRouter } from '../server.js'
import { cancelStalePending } from '../capture.js'
import { spokenFor, titleFor, fullTextFor } from '../speech.js'

// A merged pull request becomes a task-list item that offers to archive the session that worked on it.
function setup({ archive, archived = [], log } = {}) {
  let n = 0
  const store = createStore({ uuid: () => 'i' + ++n })
  const calls = []
  const registry = { archivedSessionIds: archived, archiveSession: archive ?? (async (id, options) => { calls.push([id, options]) }) }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), registryOf: () => registry, speaker: { speak: () => ({ ok: true }), stop() {} }, log })
  return { store, queue, calls, registry }
}
const info = (extra = {}) => ({ prId: '5', prSessions: [{ id: 'p1', title: 'PR 5' }], followUps: [{ id: 'f1', title: 'feature - after PR 5' }], ...extra })

test('notifyPrMerged adds one open item per PR session, carrying the PR id and the follow-ups that were told to start', () => {
  const { store, queue } = setup()
  assert.deepEqual(queue.notifyPrMerged(info({ prSessions: [{ id: 'p1', title: 'PR 5' }, { id: 'p2', title: 'PR 5 - 2' }] })), { ok: true, added: 2 })
  const open = store.snapshot().open
  assert.deepEqual(open.map((i) => [i.type, i.sessionId, i.sessionTitle, i.payload.prId]), [['pr-merged', 'p1', 'PR 5', '5'], ['pr-merged', 'p2', 'PR 5 - 2', '5']])
  assert.deepEqual(open[0].payload.followUps, [{ id: 'f1', title: 'feature - after PR 5' }])
})

test('notifyPrMerged is idempotent per session and PR, and rejects a bad PR id', () => {
  const { store, queue } = setup()
  queue.notifyPrMerged(info())
  assert.deepEqual(queue.notifyPrMerged(info()), { ok: true, added: 0 })
  assert.equal(store.snapshot().open.length, 1)
  assert.equal(queue.notifyPrMerged(info({ prId: 'x' })).ok, false)
  assert.equal(queue.notifyPrMerged(undefined).ok, false)
  assert.equal(store.snapshot().open.length, 1)
})

test('notifyPrMerged with no PR session adds nothing', () => {
  const { store, queue } = setup()
  assert.deepEqual(queue.notifyPrMerged(info({ prSessions: [] })), { ok: true, added: 0 })
  assert.equal(store.snapshot().open.length, 0)
})

test('archive archives the session (stopping running work), then closes the item as archived', async () => {
  const { store, queue, calls } = setup()
  queue.notifyPrMerged(info())
  const id = store.snapshot().open[0].id
  assert.deepEqual(await queue.archive(id), { ok: true })
  assert.deepEqual(calls, [['p1', { stopActivity: true }]])
  assert.equal(store.snapshot().open.length, 0)
  assert.deepEqual(store.snapshot().resolved[0].resolution, { kind: 'archived', by: 'card' })
  assert.deepEqual(await queue.archive(id), { ok: false, error: 'not-open' })
})

test('archive only applies to a merged-PR item and needs the session registry', async () => {
  const { store, queue } = setup()
  const done = store.add({ type: 'completed', sessionId: 's', payload: { reply: 'x' } })
  assert.deepEqual(await queue.archive(done.id), { ok: false, error: 'not-pr-merged' })
  assert.deepEqual(await queue.archive('nope'), { ok: false, error: 'not-open' })
  const bare = createReviewQueue({ store, capture: {}, controllerOf: () => ({}), speaker: undefined })
  bare.notifyPrMerged(info())
  assert.deepEqual(await bare.archive(store.snapshot().open.find((i) => i.type === 'pr-merged').id), { ok: false, error: 'no-registry' })
})

test('archive: a failing registry keeps the item open with the reason; an unknown session closes it as ended', async () => {
  const failing = setup({ archive: async () => { throw new Error('storage fault') } })
  failing.queue.notifyPrMerged(info())
  const id = failing.store.snapshot().open[0].id
  assert.deepEqual(await failing.queue.archive(id), { ok: false, error: 'storage fault' })
  assert.equal(failing.store.snapshot().open.length, 1)
  const gone = setup({ archive: async () => { throw Object.assign(new Error('unknown'), { name: 'WorkspaceUnknownSessionError' }) } })
  gone.queue.notifyPrMerged(info())
  assert.deepEqual(await gone.queue.archive(gone.store.snapshot().open[0].id), { ok: false, error: 'no-session' })
  assert.equal(gone.store.snapshot().open.length, 0)
  assert.equal(gone.store.snapshot().resolved[0].resolution.kind, 'session-ended')
})

test('a merged-PR item can be dismissed with Reviewed (keep the session)', () => {
  const { store, queue } = setup()
  queue.notifyPrMerged(info())
  assert.deepEqual(queue.markReviewed(store.snapshot().open[0].id), { ok: true })
  assert.equal(store.snapshot().open.length, 0)
})

test('a session archived elsewhere takes its merged-PR item out of the list', () => {
  const { store, queue, registry } = setup()
  queue.notifyPrMerged(info())
  assert.equal(queue.snapshot().open.length, 1)
  registry.archivedSessionIds = ['p1']
  assert.equal(queue.snapshot().open.length, 0)
  assert.deepEqual(store.snapshot().resolved[0].resolution, { kind: 'archived', by: 'elsewhere' })
})

test('a session archived elsewhere logs the item it took out of the list', () => {
  const logs = []
  const { store, queue, registry } = setup({ log: (l) => logs.push(l) })
  queue.notifyPrMerged(info())
  const [item] = store.snapshot().open
  registry.archivedSessionIds = ['p1']
  queue.snapshot()
  assert.ok(logs.some((l) => l.includes(item.id) && /archived/.test(l)), logs.join(' | '))
})

test('archiving a session DSH does not know closes the item as session-ended and logs it', async () => {
  const logs = []
  const { store, queue } = setup({ log: (l) => logs.push(l), archive: async () => { throw Object.assign(new Error('unknown'), { name: 'WorkspaceUnknownSessionError' }) } })
  queue.notifyPrMerged(info())
  const [item] = store.snapshot().open
  assert.deepEqual(await queue.archive(item.id), { ok: false, error: 'no-session' })
  assert.equal(store.get(item.id).resolution.kind, 'session-ended')
  assert.ok(logs.some((l) => l.includes(item.id) && l.includes('session-ended')), logs.join(' | '))
})

test('count() reports merged PRs by type', () => {
  const { queue } = setup()
  queue.notifyPrMerged(info())
  assert.deepEqual(queue.count(), { total: 1, byType: { question: 0, permission: 0, completed: 0, 'pr-merged': 1, todo: 0, paused: 0 } })
})

test('a merged-PR item survives a restart (only questions and permissions are cancelled)', () => {
  const store = createStore()
  store.add({ type: 'question', sessionId: 's', payload: {} })
  store.add({ type: 'pr-merged', sessionId: 's', payload: { prId: '5' } })
  assert.equal(cancelStalePending(store), 1)
  assert.deepEqual(store.snapshot().open.map((i) => i.type), ['pr-merged'])
})

test('speech: title, spoken headline and the play-button text name the PR and the follow-up', () => {
  const item = { type: 'pr-merged', sessionId: 'p1', sessionTitle: 'PR 5', payload: { prId: '5', followUps: [{ id: 'f1', title: 'x' }] } }
  assert.equal(titleFor(item), 'PR 5 merged')
  assert.equal(spokenFor(item, 2).headline, 'Item 2. Pull request 5 merged in PR 5.')
  const text = fullTextFor(item, 2)
  assert.match(text, /^Item 2\.\n\nPull request 5 is merged in PR 5\. The follow-up session was told to start\./)
  assert.match(fullTextFor({ ...item, payload: { prId: '5', followUps: [] } }, undefined), /^Pull request 5 is merged in PR 5\. You can archive/)
})

test('POST /v1/archive archives; a missing item is 409 not-open', async () => {
  const { store, queue, calls } = setup()
  queue.notifyPrMerged(info())
  const serve = createRouter({ queue, dev: undefined })
  const server = createServer((req, res) => serve(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const base = 'http://127.0.0.1:' + server.address().port
    const post = (body) => fetch(base + '/v1/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const ok = await post({ id: store.snapshot().open[0].id })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).ok, true)
    assert.equal(calls.length, 1)
    const again = await post({ id: 'nope' })
    assert.equal(again.status, 409)
    assert.deepEqual(await again.json(), { ok: false, error: 'not-open' })
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) }
})

test('client: the card knows the merged-PR type and says what became of an archived item', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
  const source = readFileSync(file, 'utf8')
  let registered
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setTimeout, clearTimeout, setInterval() {}, clearInterval() {} }, { filename: file })
  const mod = registered.factory(() => ({ createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }))
  assert.equal(mod.__test.resolutionText({ resolution: { kind: 'archived', by: 'card' } }), 'Session archived')
  assert.equal(mod.__test.resolutionText({ resolution: { kind: 'archived', by: 'elsewhere' } }), 'Session archived elsewhere')
  assert.match(source, /"pr-merged": "PR merged"/)
  assert.match(source, /"\/v1\/archive"/)
})
