import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postJson } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'
import { createExecutor } from '../agent/executor.js'

// The ids of pasted images ride with a desktop todo: hub -> todo-start / todo-suggest -> the app's addTodo. A phone never sends images.
const IDS = ['11111111-1111-4111-8111-111111111111']
const ws = (id, title, path) => ({ id, title, path })
async function viaAgent(agent, port, kind, body, result) {
  const pending = postJson(port, P + '/v1/' + kind, body)
  const got = await agent.poll(0, 3000)
  const cmd = got.json.commands[0]
  if (cmd) await agent.result(cmd.cid, result)
  return { res: await pending, cmd }
}
async function oneAgent(t, over) {
  const ctx = await startHub(t, over)
  const a = agentOf(ctx.port)
  await a.register({ sync: sync({ workspaces: [ws('w1', 'alpha', 'D:/a')] }) })
  await a.post('presence', { desktopActive: true })
  return { ...ctx, a }
}

test('a desktop todo with a workspace sends its image ids to the owner app in todo-start', async (t) => {
  const { port, a } = await oneAgent(t)
  const { cmd } = await viaAgent(a, port, 'todo', { text: 'look', workspaceId: 'aaaa/w1', images: IDS }, { ok: true, state: 'starting' })
  assert.equal(cmd.kind, 'todo-start')
  assert.deepEqual(cmd.args.images, IDS)
})

test('a desktop todo with "Choose for me" sends its image ids to the coordinator in todo-suggest', async (t) => {
  const { port, a } = await oneAgent(t)
  const { cmd } = await viaAgent(a, port, 'todo', { text: 'look', images: IDS }, { ok: true, state: 'awaiting-confirm' })
  assert.equal(cmd.kind, 'todo-suggest')
  assert.deepEqual(cmd.args.images, IDS)
})

test('a todo without images has no images key in the command', async (t) => {
  const { port, a } = await oneAgent(t)
  const { cmd } = await viaAgent(a, port, 'todo', { text: 'look', workspaceId: 'aaaa/w1' }, { ok: true })
  assert.equal('images' in cmd.args, false)
})

test('a phone todo drops images: the files are the desktop form\'s', async (t) => {
  const { port, a } = await oneAgent(t, { roleOf: () => 'device' })
  const { cmd } = await viaAgent(a, port, 'todo', { text: 'look', workspaceId: 'aaaa/w1', images: IDS }, { ok: true })
  assert.equal(cmd.kind, 'todo-start')
  assert.equal('images' in cmd.args, false)
})

test('the executor passes images on to addTodo for todo-suggest and todo-start, and only when there are some', async () => {
  const calls = []
  const executor = createExecutor({ queue: { addTodo: (text, opts) => { calls.push([text, opts]); return { ok: true } } }, adapter: {} })
  await executor.execute({ kind: 'todo-suggest', args: { text: 'a', workspaces: [], images: IDS } })
  await executor.execute({ kind: 'todo-start', args: { text: 'b', workspaceId: 'w1', images: IDS } })
  await executor.execute({ kind: 'todo-start', args: { text: 'c', workspaceId: 'w1' } })
  assert.deepEqual(calls[0][1].images, IDS)
  assert.deepEqual(calls[1][1].images, IDS)
  assert.equal('images' in calls[2][1], false)
})
