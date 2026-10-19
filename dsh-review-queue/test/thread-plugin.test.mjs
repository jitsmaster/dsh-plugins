import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewQueuePlugin } from '../index.js'
import { log, writeLog } from './paused-helpers.mjs'
import { makeWorld, startPlugin } from './plugin-helpers.mjs'

// The real plugin reads the threads from <DSH_HOME>/sessions, the folder the paused scan reads: standalone and through the hub.

const frames = () => [[log.head(), log.turnStart(1), log.user('please refactor'), log.assistant('Refactored the parser.'), log.turnEnd(1)]]
function dshHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-thread-home-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(() => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; rmSync(dir, { recursive: true, force: true }) })
  return dir
}
const fakeCtx = () => ({ on() {}, get: () => undefined, effect() {}, logger: { warn() {}, info() {} }, inject() {} })

test('standalone: the queue service reads the thread of an item from the sessions folder of DSH_HOME', async (t) => {
  const home = dshHome(t)
  writeLog(join(home, 'sessions'), 'sess-1', frames())
  const { queue, store } = createReviewQueuePlugin(fakeCtx(), { hub: false, stateDir: join(home, 'state') })
  const item = store.add({ type: 'completed', sessionId: 'sess-1', sessionTitle: 'Refactor', summary: 'x', payload: { reply: 'r' } })
  const r = await queue.thread(item.id)
  assert.deepEqual([r.ok, r.sessionId, r.title, r.messages.map((m) => [m.role, m.text])], [true, 'sess-1', 'Refactor', [['user', 'please refactor'], ['assistant', 'Refactored the parser.']]])
  assert.deepEqual(await queue.thread(store.add({ type: 'completed', sessionId: 'other', payload: {} }).id), { ok: false, error: 'no-log' })
  assert.deepEqual(await queue.thread('nope'), { ok: false, error: 'not-found' })
})

test('through the hub: the thread read by the owner app comes back over /v1/thread, and a post reaches its session', async (t) => {
  const home = dshHome(t)
  writeLog(join(home, 'sessions'), 'sess-9', frames())
  const world = await makeWorld(t)
  await world.startHub()
  const prompts = []
  const services = { sessionController: { prompt: async (req) => { prompts.push(req); return {} } } }
  const app = await startPlugin(t, world, { label: 'DSH :1', webPort: 13001, services })
  await app.inState('hub')
  const id = await app.completed('sess-9', 'Refactored the parser.')
  const hubPort = world.hubPort
  await new Promise((r) => setTimeout(r, 300))
  const asDesktop = (kind, body) => fetch('http://127.0.0.1:' + hubPort + '/review-queue/v1/' + kind, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }))
  const thread = await asDesktop('thread', { id })
  assert.equal(thread.status, 200)
  assert.deepEqual([thread.json.sessionId, thread.json.hasMore, thread.json.messages.map((m) => [m.role, m.text])], ['sess-9', false, [['user', 'please refactor'], ['assistant', 'Refactored the parser.']]])
  const post = await asDesktop('post', { id, text: 'now the tests' })
  assert.deepEqual([post.status, post.json], [200, { ok: true }])
  assert.deepEqual([prompts[0].sessionId, prompts[0].content[0].text], ['sess-9', 'now the tests'])
})
