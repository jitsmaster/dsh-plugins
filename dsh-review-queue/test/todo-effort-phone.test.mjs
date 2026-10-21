import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentOf, sync } from './hub-agent-helpers.mjs'
import { P, startPhoneHub } from './hub-device-helpers.mjs'
import { createExecutor } from '../agent/executor.js'
import { TIMEOUT_MS } from '../hub/commands.js'

// The phone's New todo form has the Effort field too: the hub no longer drops the effort of a device, and GET /v1/model-efforts is answered by the hub
// (the coordinator app is asked with the command model-efforts: the phone has no app of its own). The phone form itself is tested in mobile-todo-effort.test.mjs.

const EFFORTS = { ok: true, model: { provider: 'p', id: 'm', name: 'Model' }, efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }
const ws = (id, title, path) => ({ id, title, path })

async function withAgent(t) {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: sync({ workspaces: [ws('w1', 'alpha', 'D:/a')] }) })
  await a.post('presence', { desktopActive: true })
  const p = await h.pairPhone()
  const viaAgent = async (method, path, body, result = { ok: true }) => {
    const pending = p.call(method, P + path, body)
    const got = await a.poll(0, 3000)
    const cmd = got.json.commands[0]
    if (cmd) await a.result(cmd.cid, result)
    return { res: await pending, cmd }
  }
  return { h, a, p, viaAgent }
}

test('a phone todo keeps its effort: todo-start for a workspace and todo-suggest for Choose for me carry it', async (t) => {
  const { viaAgent } = await withAgent(t)
  const start = await viaAgent('POST', '/v1/todo', { text: 'fix it', workspaceId: 'aaaa/w1', effort: 'high' })
  assert.equal(start.cmd.kind, 'todo-start')
  assert.equal(start.cmd.args.effort, 'high')
  const suggest = await viaAgent('POST', '/v1/todo', { text: 'fix it', effort: 'low' })
  assert.equal(suggest.cmd.kind, 'todo-suggest')
  assert.equal(suggest.cmd.args.effort, 'low')
  const none = await viaAgent('POST', '/v1/todo', { text: 'fix it', workspaceId: 'aaaa/w1', effort: '' })
  assert.equal('effort' in none.cmd.args, false)
})

test('GET /v1/model-efforts for a phone asks the coordinator app (command model-efforts) and answers what it said', async (t) => {
  const { viaAgent } = await withAgent(t)
  const { res, cmd } = await viaAgent('GET', '/v1/model-efforts', undefined, EFFORTS)
  assert.equal(cmd.kind, 'model-efforts')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, EFFORTS)
})

test('GET /v1/model-efforts: no app online answers an empty list (the phone form then has no dropdown); POST is 405; a stranger is 401', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  const none = await p.call('GET', P + '/v1/model-efforts')
  assert.equal(none.status, 200)
  assert.deepEqual(none.json.efforts, [])
  assert.equal((await p.call('POST', P + '/v1/model-efforts', {})).status, 405)
  const stranger = await h.stranger('GET', P + '/v1/model-efforts')
  assert.equal(stranger.status, 401)
})

test('GET /v1/model-efforts: an app that fails to answer gives an empty list too, not an error page', async (t) => {
  const { viaAgent } = await withAgent(t)
  const { res } = await viaAgent('GET', '/v1/model-efforts', undefined, { ok: false, error: 'failed' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.efforts, [])
})

test('the executor answers model-efforts from the queue as a read: at once, and every time', async () => {
  let n = 0
  const executor = createExecutor({ queue: { modelEfforts: async () => ({ ...EFFORTS, n: ++n }) }, adapter: {} })
  assert.equal((await executor.execute({ kind: 'model-efforts', cid: 'c1' })).n, 1)
  assert.equal((await executor.execute({ kind: 'model-efforts', cid: 'c1' })).n, 2, 'not kept by cid')
})

test('the command has a timeout of its own', () => {
  assert.equal(typeof TIMEOUT_MS['model-efforts'], 'number')
})

test('the hub no longer says "a phone sends no effort" in its routing comment', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'hub', 'routing.js'), 'utf8')
  assert.equal(/role === 'device' \|\| typeof body\.effort/.test(src), false)
})
