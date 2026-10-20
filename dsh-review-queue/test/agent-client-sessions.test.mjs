import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentClient } from '../agent/client.js'
import { createExecutor } from '../agent/executor.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { waitFor } from './hub-helpers.mjs'
import { SECRET, startHub } from './hub-agent-helpers.mjs'

// The agent reports "N working / M open" to the hub: with the register, then through presence when the numbers change (not when they do not).
function setup(t, port, { id = 'aaaa1111', key = 'k1', fetch, ...over } = {}) {
  const adapter = createStoreAdapter({ instanceId: id })
  const executor = createExecutor({ queue: {}, adapter })
  const client = createAgentClient({ baseUrl: 'http://127.0.0.1:' + port, secret: SECRET, instanceKey: key, instanceId: id, label: 'DSH', adapter, executor, backoff: { minMs: 10, maxMs: 40 }, waitMs: 300, sessionReportMs: 20, ...(fetch ? { fetch } : {}), ...over })
  t.after(() => client.stop({ bye: false }))
  return client
}
const connected = (c) => waitFor(() => c.state === 'connected', 8000, 'connected')
function spyFetch() {
  const log = []
  return { log, fetch: async (url, init) => { const name = new URL(url).pathname.split('/').pop(); log.push([name, init?.body]); return fetch(url, init) } }
}

const withSessions = (log) => log.filter(([n, body]) => n === 'presence' && body && JSON.parse(body).sessions)

test('the numbers ride along with the register', async (t) => {
  const { hub, port } = await startHub(t)
  const c = setup(t, port, { sessionCounts: () => ({ working: 2, open: 4 }) })
  c.start()
  await connected(c)
  assert.deepEqual(hub.instances.sessionsTotal(), { working: 2, open: 4 })
})

test('a change is reported through presence; an unchanged number is not sent again', async (t) => {
  const { hub, port } = await startHub(t)
  let counts = { working: 1, open: 3 }
  const spy = spyFetch()
  const c = setup(t, port, { sessionCounts: () => counts, fetch: spy.fetch })
  c.start()
  await connected(c)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(withSessions(spy.log).length, 0, 'nothing changed since the register')
  counts = { working: 2, open: 3 }
  await waitFor(() => hub.instances.sessionsTotal()?.working === 2, 3000, 'reported')
  const sent = withSessions(spy.log)
  assert.equal(sent.length, 1)
  assert.deepEqual(JSON.parse(sent[0][1]).sessions, { working: 2, open: 3 })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(withSessions(spy.log).length, 1)
})

test('unknown numbers (undefined, a throwing function, junk) are never sent', async (t) => {
  for (const sessionCounts of [() => undefined, () => { throw new Error('x') }, () => ({ working: 'a' }), undefined]) {
    const { hub, port } = await startHub(t)
    const spy = spyFetch()
    const c = setup(t, port, { sessionCounts, fetch: spy.fetch })
    c.start()
    await connected(c)
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(hub.instances.sessionsTotal(), undefined)
    assert.equal(withSessions(spy.log).length, 0)
  }
})

test('a hub that does not know the numbers (an old hub answers presence as before) never degrades the client', async (t) => {
  const { port } = await startHub(t)
  let counts = { working: 1, open: 1 }
  const c = setup(t, port, {
    sessionCounts: () => counts,
    fetch: async (url, init) => (new URL(url).pathname.endsWith('/presence') ? { status: 404, json: async () => ({ error: 'not-found' }), text: async () => '{"error":"not-found"}', headers: new Headers() } : fetch(url, init)),
  })
  c.start()
  await connected(c)
  counts = { working: 2, open: 2 }
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(c.state, 'connected')
})

// ---- the numbers are only kept fresh while somebody looks ----------------------------------------------------------------------------------

test('while the hub says nobody looks the agent does not touch the counter; when it says somebody does, it does, until that stops', async (t) => {
  const { hub, port } = await startHub(t)
  let watched = 0
  const c = setup(t, port, { sessionCounts: () => ({ working: 1, open: 2 }), sessionsWatch: () => { watched++ } })
  c.start()
  await connected(c)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(watched, 0, 'nobody looks')
  hub.noteWatch()
  await waitFor(() => watched > 0, 3000, 'the agent learned that somebody looks')
  const n = watched
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(watched > n, 'keeps touching while watched')
})

test('an old hub (no watch field in its answers) never makes the app list sessions for nobody: a missing field means nobody looks', async (t) => {
  const { port } = await startHub(t)
  let watched = 0
  const strip = async (url, init) => {
    const res = await fetch(url, init)
    const name = new URL(url).pathname.split('/').pop()
    if (name !== 'register' && name !== 'presence') return res
    const json = await res.json()
    delete json.watch
    return { status: res.status, text: async () => JSON.stringify(json) }
  }
  const c = setup(t, port, { sessionCounts: () => ({ working: 1, open: 2 }), sessionsWatch: () => { watched++ }, fetch: strip })
  c.start()
  await connected(c)
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(watched, 0)
})

test('only watch === true counts: a hub that says false, a string or null is not looking', async (t) => {
  const { port } = await startHub(t)
  for (const value of [false, 'true', null, 1]) {
    let watched = 0
    const lie = async (url, init) => {
      const res = await fetch(url, init)
      const name = new URL(url).pathname.split('/').pop()
      if (name !== 'register' && name !== 'presence') return res
      const json = await res.json()
      json.watch = value
      return { status: res.status, text: async () => JSON.stringify(json) }
    }
    const c = setup(t, port, { id: 'cccc' + String(Math.random()).slice(2, 6), key: 'kx' + value, sessionCounts: () => ({ working: 1, open: 2 }), sessionsWatch: () => { watched++ }, fetch: lie })
    c.start()
    await connected(c)
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(watched, 0, String(value))
  }
})

test('while nobody looks the agent checks with the hub (a presence without numbers), often; while somebody does, rarely', async (t) => {
  const { hub, port } = await startHub(t)
  const spy = spyFetch()
  const c = setup(t, port, { sessionCounts: () => undefined, fetch: spy.fetch })
  c.start()
  await connected(c)
  await new Promise((r) => setTimeout(r, 200))
  const idle = spy.log.filter(([n]) => n === 'presence').length
  assert.ok(idle >= 3, 'presence checks while nobody looks: ' + idle)
  hub.noteWatch()
  await waitFor(() => hub.watching(), 1000, 'watching')
  await new Promise((r) => setTimeout(r, 120))
  const mark = spy.log.filter(([n]) => n === 'presence').length
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(spy.log.filter(([n]) => n === 'presence').length - mark <= 1, 'a long recheck interval while watched')
})
