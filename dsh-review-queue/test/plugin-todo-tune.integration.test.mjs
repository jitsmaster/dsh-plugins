import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorld, startPlugin } from './plugin-helpers.mjs'
import { fakeLlm, systemOf, userOf } from './todo-tune-helpers.mjs'

// RED tests: index.js wires createTuner (todo-tune.js) with the SAME llm service as the summarizer (ctx.get('llm')), config.promptTunePath is the
// optional rules file, and POST /review-queue/v1/todo-tune works through the real plugin: standalone and in hub mode (answered locally).
// Today the route is an unknown action: 404.
const RULES = ['## 1. Empty argument check', 'BEFORE-MARKER', '## 2. Parse the profile flag', 'PLUGIN-RULES-MARKER', '## 4. Produce the rewrite', 'REWRITE-MARKER', '## 5. Show the before/after', 'SHOW-MARKER', ''].join('\n')

test('standalone: the route tunes the text with the llm service of the host', async (t) => {
  const world = await makeWorld(t)
  const seen = {}
  const p = await startPlugin(t, world, { label: 'DSH :1', webPort: 14101, config: { hub: false }, services: { llm: fakeLlm({ answer: 'Optimized: Fix the login form.', seen }) } })
  const res = await p.post('/v1/todo-tune', { text: 'fix login' })
  assert.deepEqual([res.status, res.json], [200, { ok: true, text: 'Fix the login form.' }])
  assert.ok(userOf(seen).includes('fix login'))
  assert.equal(seen.calls, 1)
})

test('config.promptTunePath is the rules file: its section is in the system prompt', async (t) => {
  const world = await makeWorld(t)
  const file = join(world.dir, 'my-prompt-tune.md')
  writeFileSync(file, RULES)
  const seen = {}
  const p = await startPlugin(t, world, { label: 'DSH :1', webPort: 14102, config: { hub: false, promptTunePath: file }, services: { llm: fakeLlm({ answer: 'ok', seen }) } })
  assert.equal((await p.post('/v1/todo-tune', { text: 'fix' })).status, 200)
  assert.ok(systemOf(seen).includes('PLUGIN-RULES-MARKER') && systemOf(seen).includes('REWRITE-MARKER'))
  assert.ok(!systemOf(seen).includes('BEFORE-MARKER') && !systemOf(seen).includes('SHOW-MARKER'))
})

test('without a model the route is a 409 no model available', async (t) => {
  const world = await makeWorld(t)
  const p = await startPlugin(t, world, { label: 'DSH :1', webPort: 14103, config: { hub: false }, services: { llm: fakeLlm({ noModels: true }) } })
  const res = await p.post('/v1/todo-tune', { text: 'fix' })
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'no model available' }])
})

test('with no llm service at all the route is a 409 failure, not a crash', async (t) => {
  const world = await makeWorld(t)
  const p = await startPlugin(t, world, { label: 'DSH :1', webPort: 14104, config: { hub: false }, services: {} })
  const res = await p.post('/v1/todo-tune', { text: 'fix' })
  assert.equal(res.status, 409)
  assert.equal(res.json.ok, false)
})

test('hub mode: the same route is answered by this app with its own llm', async (t) => {
  const world = await makeWorld(t)
  await world.startHub()
  const seen = {}
  const p = await startPlugin(t, world, { label: 'DSH :1', webPort: 14105, services: { llm: fakeLlm({ answer: 'Tuned in hub mode', seen }) } })
  await p.inState('hub')
  const res = await p.post('/v1/todo-tune', { text: 'fix login' })
  assert.deepEqual([res.status, res.json], [200, { ok: true, text: 'Tuned in hub mode' }])
  assert.equal(seen.calls, 1)
})
