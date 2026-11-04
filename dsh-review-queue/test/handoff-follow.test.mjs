import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createServer } from 'node:http'
import { createRouter } from '../server.js'

// A done card whose reply says a handoff note was written gets a "Follow" action: it opens a NEW session that resumes that note (the sparcr flow of the
// session menu's "Follow-up from handoff", which dsh-hooks-tts publishes as the service 'handoffFollowUp') and the source session is archived by it.
// handoff-follow.js: the pure check (handoffFollowable) and the server-side action (createHandoffFollow). The wiring is queue.followHandoff / POST /v1/follow-handoff.
const mod = await import('../handoff-follow.js').catch((error) => ({ importError: error }))
const need = (name) => { assert.equal(mod.importError, undefined, 'handoff-follow.js must exist: ' + mod.importError?.message); assert.equal(typeof mod[name], 'function', 'handoff-follow.js must export ' + name) }

const done = (reply, over = {}) => ({ id: 'i1', type: 'completed', status: 'open', sessionId: 's1', summary: 'Did it', payload: { reply }, ...over })

test('handoffFollowable: an open done card whose reply says a handoff was written to an absolute handoff.md path', () => {
  need('handoffFollowable')
  const table = [
    ['a backticked Windows path', done('All done.\nHandoff written to `D:\\x\\a-handoff.md`'), true],
    ['a plain forward-slash path', done('Handoff written to D:/x/a-handoff.md'), true],
    ['a POSIX path', done('Handoff written to `/home/u/a-handoff.md`'), true],
    ['a relative path', done('Handoff written to `notes/a-handoff.md`'), false],
    ['no write verb (resuming from a note)', done('resuming from D:/x/a-handoff.md'), false],
    ['not a handoff file', done('Handoff written to D:/x/notes.md'), false],
    ['no reply text', done(''), false],
    ['no payload', { id: 'i', type: 'completed', status: 'open', sessionId: 's1' }, false],
    ['reply is not a string', done({ not: 'text' }), false],
    ['a question card', done('Handoff written to D:/x/a-handoff.md', { type: 'question' }), false],
    ['a resolved card', done('Handoff written to D:/x/a-handoff.md', { status: 'resolved' }), false],
    ['no session id', done('Handoff written to D:/x/a-handoff.md', { sessionId: undefined }), false],
    ['an empty session id', done('Handoff written to D:/x/a-handoff.md', { sessionId: '' }), false],
    ['nothing at all', undefined, false],
  ]
  for (const [name, item, expected] of table) assert.equal(mod.handoffFollowable(item), expected, name)
})

// ---- createHandoffFollow ---------------------------------------------------------------------------------------------------------------

const REPLY = 'Handoff written to `D:\\secret\\dir\\a-handoff.md`'
function make({ service, item = done(REPLY), over = {} } = {}) {
  const store = createStore({ uuid: () => 'i1' })
  const added = store.add({ type: 'completed', sessionId: item.sessionId, sessionTitle: 'T', summary: 'Did it', payload: item.payload })
  const logs = []
  const calls = []
  const svc = service === undefined ? { latest: (s) => { calls.push(['latest', s]); return 'D:\\secret\\dir\\a-handoff.md' }, followUp: async (s) => { calls.push(['followUp', s]); return { status: 200, sessionId: 'new-1' } } } : service
  const follow = mod.createHandoffFollow ? mod.createHandoffFollow({ serviceOf: () => svc, store, log: (l) => logs.push(l), ...over }) : undefined
  return { store, follow, id: added.id, logs, calls, svc }
}
const needFollow = () => { need('createHandoffFollow') }

test('follow: starts the follow-up of the item\'s session and resolves the card as handoff-followed with the new session id', async () => {
  needFollow()
  const { follow, id, store, calls } = make()
  assert.deepEqual(await follow.follow(id), { ok: true, sessionId: 'new-1' })
  assert.deepEqual(calls, [['latest', 's1'], ['followUp', 's1']])
  const item = store.get(id)
  assert.equal(item.status, 'resolved')
  assert.deepEqual(item.resolution, { kind: 'handoff-followed', by: 'card', sessionId: 'new-1' })
})

test('follow: an unknown item is not-found and the service is not asked', async () => {
  needFollow()
  const { follow, calls } = make()
  assert.deepEqual(await follow.follow('nope'), { ok: false, error: 'not-found' })
  assert.deepEqual(calls, [])
})

test('follow: a card that is not followable (no handoff in the reply, or another type) is not-followable', async () => {
  needFollow()
  const plain = make({ item: done('All done.') })
  const stored = plain.store.get(plain.id)
  stored.payload = { reply: 'All done.' }
  assert.deepEqual(await plain.follow.follow(plain.id), { ok: false, error: 'not-followable' })
  const q = make()
  const other = q.store.add({ type: 'question', sessionId: 's2', payload: { reply: REPLY } })
  assert.deepEqual(await q.follow.follow(other.id), { ok: false, error: 'not-followable' })
  assert.deepEqual(q.calls, [])
})

test('follow: a card that was resolved meanwhile is not-followable and nothing is started', async () => {
  needFollow()
  const { follow, id, store, calls } = make()
  store.resolve(id, { kind: 'reviewed', by: 'card' })
  assert.deepEqual(await follow.follow(id), { ok: false, error: 'not-followable' })
  assert.deepEqual(calls, [])
})

test('follow: when the service knows no note for the session it is no-handoff and followUp is not called', async () => {
  needFollow()
  const calls = []
  const { follow, id, store } = make({ service: { latest: () => undefined, followUp: async () => { calls.push('followUp'); return { status: 200, sessionId: 'x' } } } })
  assert.deepEqual(await follow.follow(id), { ok: false, error: 'no-handoff' })
  assert.deepEqual(calls, [])
  assert.equal(store.get(id).status, 'open')
})

test('follow: the service answering 404 is no-handoff, 409 is follow-busy, anything else is failed; the card stays open', async () => {
  needFollow()
  for (const [result, error] of [[{ status: 404, error: 'this session has no handoff note' }, 'no-handoff'], [{ status: 409, error: 'a follow-up session is already being created' }, 'follow-busy'], [{ status: 500, error: 'spawn failed at D:\\secret\\x' }, 'failed'], [{ status: 200 }, 'failed'], [undefined, 'failed']]) {
    const { follow, id, store } = make({ service: { latest: () => 'D:\\p\\a-handoff.md', followUp: async () => result } })
    assert.deepEqual(await follow.follow(id), { ok: false, error }, JSON.stringify(result))
    assert.equal(store.get(id).status, 'open')
  }
})

test('follow: without the hooks-tts service it is unavailable', async () => {
  needFollow()
  for (const serviceOf of [() => undefined, () => { throw new Error('no such service') }]) {
    const { follow, id, store } = make({ over: { serviceOf } })
    assert.deepEqual(await follow.follow(id), { ok: false, error: 'unavailable' })
    assert.equal(store.get(id).status, 'open')
  }
})

test('follow: a service that throws or rejects is failed, never an exception, and no path or message leaks', async () => {
  needFollow()
  for (const service of [{ latest: () => { throw new Error('boom D:\\secret\\dir') }, followUp: async () => ({}) }, { latest: () => 'D:\\p\\a-handoff.md', followUp: async () => { throw new Error('boom D:\\secret\\dir') } }, { latest: () => 'D:\\p\\a-handoff.md', followUp: () => { throw new Error('sync boom') } }]) {
    const { follow, id, logs } = make({ service })
    const result = await follow.follow(id)
    assert.deepEqual(result, { ok: false, error: 'failed' })
    assert.ok(!JSON.stringify(result).includes('secret'))
    assert.ok(!logs.join('\n').includes('D:\\secret'), 'the log does not hold the path either: ' + logs.join('|'))
  }
})

test('follow: an error never carries the note path', async () => {
  needFollow()
  const { follow, id } = make({ service: { latest: () => 'D:\\secret\\dir\\a-handoff.md', followUp: async () => ({ status: 500, error: 'could not start D:\\secret\\dir\\a-handoff.md' }) } })
  assert.ok(!JSON.stringify(await follow.follow(id)).includes('secret'))
})

test('follow: the source session is archived by the follow-up, which may close the card first; the card then stays as that resolution and the call is still ok', async () => {
  needFollow()
  let storeRef
  const { follow, id, store } = make({ service: { latest: () => 'D:\\p\\a-handoff.md', followUp: async () => { storeRef.resolve(id, { kind: 'archived', by: 'elsewhere' }); return { status: 200, sessionId: 'new-2' } } } })
  storeRef = store
  assert.deepEqual(await follow.follow(id), { ok: true, sessionId: 'new-2' })
  assert.deepEqual(store.get(id).resolution, { kind: 'archived', by: 'elsewhere' })
})

test('follow: a double click starts one follow-up; the second call is follow-busy', async () => {
  needFollow()
  let started = 0
  let release
  const gate = new Promise((r) => { release = r })
  const { follow, id } = make({ service: { latest: () => 'D:\\p\\a-handoff.md', followUp: async () => { started++; await gate; return { status: 200, sessionId: 'new-3' } } } })
  const first = follow.follow(id)
  const second = await follow.follow(id)
  assert.deepEqual(second, { ok: false, error: 'follow-busy' })
  release()
  assert.deepEqual(await first, { ok: true, sessionId: 'new-3' })
  assert.equal(started, 1)
  assert.deepEqual(await follow.follow(id), { ok: false, error: 'not-followable' }, 'after success the card is resolved')
})

test('the store keeps a handoff-followed resolution as it is given', () => {
  const store = createStore({ uuid: () => 'z' })
  const item = store.add({ type: 'completed', sessionId: 's1', payload: { reply: REPLY } })
  store.resolve(item.id, { kind: 'handoff-followed', by: 'card', sessionId: 'n1' })
  assert.deepEqual(store.get(item.id).resolution, { kind: 'handoff-followed', by: 'card', sessionId: 'n1' })
})

// ---- the service method and the route ---------------------------------------------------------------------------------------------------

function app(svc) {
  const store = createStore({ uuid: () => 'r1' })
  const speaker = { speak: () => ({ ok: true }), stop: () => {} }
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => ({ prompt: async () => ({}) }), speaker, handoffFollowOf: () => svc })
  return { store, queue }
}

test('queue.followHandoff(id) is the service method of the action', async () => {
  const { store, queue } = app({ latest: () => 'D:\\p\\a-handoff.md', followUp: async () => ({ status: 200, sessionId: 'n9' }) })
  assert.equal(typeof queue.followHandoff, 'function')
  const item = store.add({ type: 'completed', sessionId: 's1', payload: { reply: REPLY } })
  assert.deepEqual(await queue.followHandoff(item.id), { ok: true, sessionId: 'n9' })
  assert.equal(store.get(item.id).resolution.kind, 'handoff-followed')
})

async function serve(svc) {
  const { store, queue } = app(svc)
  const router = createRouter({ queue })
  const server = createServer((req, res) => router(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  const post = async (body, raw) => { const res = await fetch(base + '/v1/follow-handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) }); return [res.status, await res.json()] }
  return { store, post, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }
}

test('POST /v1/follow-handoff: 200 with the new session id for a followable card', async (t) => {
  const s = await serve({ latest: () => 'D:\\p\\a-handoff.md', followUp: async () => ({ status: 200, sessionId: 'n5' }) })
  t.after(s.close)
  const item = s.store.add({ type: 'completed', sessionId: 's1', payload: { reply: REPLY } })
  assert.deepEqual(await s.post({ id: item.id }), [200, { ok: true, sessionId: 'n5' }])
})

test('POST /v1/follow-handoff: an unknown id is 409 not-found (the route exists: not 404 unknown-action)', async (t) => {
  const s = await serve({ latest: () => undefined, followUp: async () => ({}) })
  t.after(s.close)
  assert.deepEqual(await s.post({ id: 'nope' }), [409, { ok: false, error: 'not-found' }])
})

test('POST /v1/follow-handoff: the refusals map like the other actions (no-handoff, follow-busy, unavailable, failed are 409; not-followable is 409)', async (t) => {
  const cases = [
    [{ latest: () => undefined, followUp: async () => ({}) }, 'no-handoff'],
    [{ latest: () => 'p', followUp: async () => ({ status: 409 }) }, 'follow-busy'],
    [undefined, 'unavailable'],
    [{ latest: () => 'p', followUp: async () => ({ status: 500 }) }, 'failed'],
  ]
  for (const [svc, error] of cases) {
    const s = await serve(svc)
    t.after(s.close)
    const item = s.store.add({ type: 'completed', sessionId: 's1', payload: { reply: REPLY } })
    assert.deepEqual(await s.post({ id: item.id }), [409, { ok: false, error }], error)
  }
})

test('POST /v1/follow-handoff: a malformed JSON body is 400', async (t) => {
  const s = await serve({ latest: () => 'p', followUp: async () => ({}) })
  t.after(s.close)
  const [status] = await s.post(undefined, '{nope')
  assert.equal(status, 400)
})

test('POST /v1/follow-handoff: a body without an id is refused, not started', async (t) => {
  let started = 0
  const s = await serve({ latest: () => 'p', followUp: async () => { started++; return { status: 200, sessionId: 'x' } } })
  t.after(s.close)
  const item = s.store.add({ type: 'completed', sessionId: 's1', payload: { reply: REPLY } })
  const [status, json] = await s.post({})
  assert.equal(json.ok, false)
  assert.ok(status === 400 || status === 409, 'status ' + status)
  assert.equal(started, 0)
  assert.equal(s.store.get(item.id).status, 'open')
})
