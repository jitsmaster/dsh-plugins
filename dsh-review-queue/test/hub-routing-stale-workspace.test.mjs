// A workspace id of the union is "<instance short>/<workspace id>" and the short part changes with every start of an app (the instance id is new
// each time). A todo card that was waiting for its confirm keeps the id it had; the hub finds the workspace by its own id when the prefix is old.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postJson } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

const act = (port, kind, body) => postJson(port, P + '/v1/' + kind, body)
const ws = (id, title) => ({ id, title, path: 'D:/' + title })
const todo = (suggested) => ({ type: 'todo', text: 'fix it', state: 'awaiting-confirm', ...(suggested ? { suggested } : {}) })

/** The old app (id aaaa...) was restarted: the new one (id dddd..., same key) lists the same workspaces; an extra app may list one of them too. */
async function restarted(t, { second } = {}) {
  const ctx = await startHub(t)
  const old = agentOf(ctx.port)
  await old.register({ sync: sync({ workspaces: [ws('w1', 'alpha')] }) })
  await old.send(old.add(1, todo({ workspaceId: 'aaaa/w1', title: 'alpha' })))
  const fresh = agentOf(ctx.port, { id: 'dddd4444' })
  await fresh.register({ sync: sync({ workspaces: [ws('w1', 'alpha')] }) })
  const other = second ? agentOf(ctx.port, { id: 'bbbb2222', key: 'k2', label: 'DSH :2' }) : undefined
  await other?.register({ sync: sync({ workspaces: [second] }) })
  return { ...ctx, old, fresh, other, itemId: old.itemId(1) }
}

test('confirming with a workspace id whose instance part is from before a restart starts it in the app that has that workspace now', async (t) => {
  const { port, fresh, itemId } = await restarted(t)
  const pending = act(port, 'todo-confirm', { id: itemId, workspaceId: 'aaaa/w1' })
  const cmd = (await fresh.poll(0, 1000)).json.commands[0]
  assert.ok(cmd, 'the app was sent a command')
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args], ['todo-start', itemId, { workspaceId: 'w1' }])
  await fresh.result(cmd.cid, { ok: true, state: 'starting' })
  assert.equal((await pending).status, 200)
})

test('the id suggested before the restart is used when the confirm names no workspace', async (t) => {
  const { port, fresh, itemId } = await restarted(t)
  const pending = act(port, 'todo-confirm', { id: itemId })
  const cmd = (await fresh.poll(0, 1000)).json.commands[0]
  assert.ok(cmd, 'the app was sent a command')
  assert.deepEqual([cmd.kind, cmd.args], ['todo-start', { workspaceId: 'w1' }])
  await fresh.result(cmd.cid, { ok: true, state: 'starting' })
  assert.equal((await pending).status, 200)
})

test('a new todo for such an id is started in that app', async (t) => {
  const { port, fresh } = await restarted(t)
  const pending = act(port, 'todo', { text: 'fix it', workspaceId: 'aaaa/w1' })
  const cmd = (await fresh.poll(0, 1000)).json.commands[0]
  assert.ok(cmd, 'the app was sent a command')
  assert.deepEqual([cmd.kind, cmd.args], ['todo-start', { text: 'fix it', sparc: false, workspaceId: 'w1' }])
  await fresh.result(cmd.cid, { ok: true, state: 'starting' })
  assert.equal((await pending).status, 200)
})

test('when two apps list the same workspace id the old prefix is not guessed: 400 unknown-workspace and nothing is sent', async (t) => {
  const { port, fresh, other, itemId } = await restarted(t, { second: ws('w1', 'alpha') })
  assert.deepEqual((await act(port, 'todo-confirm', { id: itemId, workspaceId: 'aaaa/w1' })).json, { ok: false, error: 'unknown-workspace' })
  assert.deepEqual((await act(port, 'todo', { text: 'x', workspaceId: 'aaaa/w1' })).json, { ok: false, error: 'unknown-workspace' })
  assert.deepEqual([(await fresh.poll(0, 0)).json.commands, (await other.poll(0, 0)).json.commands], [[], []])
})

test('an id that no app lists is still unknown-workspace', async (t) => {
  const { port, itemId } = await restarted(t)
  assert.deepEqual((await act(port, 'todo-confirm', { id: itemId, workspaceId: 'aaaa/w9' })).json, { ok: false, error: 'unknown-workspace' })
  assert.deepEqual((await act(port, 'todo', { text: 'x', workspaceId: 'zzzz/w9' })).json, { ok: false, error: 'unknown-workspace' })
})
