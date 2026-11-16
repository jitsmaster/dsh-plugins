// The question merge is switched by config.questionMerge (default on), never by the test runner's environment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewQueuePlugin } from '../index.js'

function plugin(t, config) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = {
    on() {}, get: () => undefined, effect: () => {}, logger: { warn() {}, info() {} },
    inject: (_names, fn) => fn({ effect: (f) => f(), connection: { admit: () => ({}) }, webServer: { register() {} } }),
  }
  return createReviewQueuePlugin(ctx, { hub: false, stateDir: dir, ...config })
}
const ask = (text) => ({ type: 'question', sessionId: 's1', workspace: 'D:/w', detached: true, payload: { questions: [{ question: text, options: [] }] } })
const settle = () => new Promise((r) => setTimeout(r, 30))

test('by default a repeated question supersedes the older one, with no help from the environment', async (t) => {
  const { store } = plugin(t, {})
  const old = store.add(ask('Use Postgres?'))
  store.add(ask('use postgres'))
  await settle()
  assert.equal(store.get(old.id).resolution?.kind, 'superseded')
})

test('questionMerge: false leaves the older question alone', async (t) => {
  const { store } = plugin(t, { questionMerge: false })
  const old = store.add(ask('Use Postgres?'))
  store.add(ask('use postgres'))
  await settle()
  assert.equal(store.get(old.id).status, 'open')
})