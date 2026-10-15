import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AWAY_MS, GRACE_MS } from '../hub/instances.js'
import { postJson, raw } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

const permission = (over = {}) => ({ type: 'permission', sessionId: 's1', workspace: 'D:/w', payload: { toolName: 'shell', summary: 'ls', detail: 'ls' }, ...over })
const risky = () => permission({ payload: { toolName: 'shell', summary: 'rm', detail: 'rm -rf /tmp/x' } })
const act = (port, kind, body, headers) => postJson(port, P + '/v1/' + kind, body, headers)
const ws = (id, title, path) => ({ id, title, path })

async function twoAgents(t, over = {}) {
  const ctx = await startHub(t, over)
  const a = agentOf(ctx.port)
  const b = agentOf(ctx.port, { id: 'bbbb2222', key: 'k2', label: 'DSH :2' })
  await a.register({ sync: sync({ workspaces: [ws('w1', 'alpha', 'D:/a')] }) })
  await b.register({ sync: sync({ workspaces: [ws('w1', 'beta', 'D:/b')] }) })
  return { ...ctx, a, b }
}
/** Post one action, let the agent fetch it and (when result is given) answer it. */
async function viaAgent(agent, port, kind, body, result, headers) {
  const pending = act(port, kind, body, headers)
  const got = await agent.poll(0, 3000)
  const cmd = got.json.commands[0]
  if (cmd && result) await agent.result(cmd.cid, result)
  return { res: await pending, cmd }
}
const nothingQueued = async (agent) => assert.deepEqual((await agent.poll(0, 0)).json.commands, [])

// ---- D8: confirm, hold, risk ---------------------------------------------------------------------------------------------------

test('a phone approve of an item of A goes to A only, with via forced to phone, and the answer of A is the response', async (t) => {
  const { port, a, b } = await twoAgents(t, { roleOf: () => 'device' })
  await a.send(a.add(1, permission()))
  const { res, cmd } = await viaAgent(a, port, 'approve', { id: a.itemId(1), confirmed: true, via: 'desktop' }, { ok: true })
  assert.deepEqual([res.status, res.json], [200, { ok: true }])
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args], ['approve', a.itemId(1), { via: 'phone', confirmed: true, held: false }])
  await nothingQueued(b)
})

test('a desktop role is via desktop whatever the body says', async (t) => {
  const { port, a } = await twoAgents(t)
  await a.send(a.add(1, permission()))
  const { cmd } = await viaAgent(a, port, 'approve', { id: a.itemId(1), via: 'phone' }, { ok: true })
  assert.equal(cmd.args.via, 'desktop')
})

test('a phone approve needs the confirm sheet (400 needs-confirm) and a risky one the hold too (400 needs-hold); nothing is queued', async (t) => {
  const { port, a } = await twoAgents(t, { roleOf: () => 'device' })
  await a.send(a.add(1, permission()), a.add(2, risky()))
  const plain = await act(port, 'approve', { id: a.itemId(1) })
  assert.deepEqual([plain.status, plain.json], [400, { ok: false, error: 'needs-confirm' }])
  assert.equal((await act(port, 'approve', { id: a.itemId(1), confirmed: 'yes' })).status, 400)
  const noHold = await act(port, 'approve', { id: a.itemId(2), confirmed: true })
  assert.deepEqual([noHold.status, noHold.json], [400, { ok: false, error: 'needs-hold' }])
  await nothingQueued(a)
  const { res, cmd } = await viaAgent(a, port, 'approve', { id: a.itemId(2), confirmed: true, held: true }, { ok: true })
  assert.equal(res.status, 200)
  assert.deepEqual(cmd.args, { via: 'phone', confirmed: true, held: true })
})

test('the desktop needs neither confirm nor hold', async (t) => {
  const { port, a } = await twoAgents(t)
  await a.send(a.add(1, risky()))
  const { res } = await viaAgent(a, port, 'approve', { id: a.itemId(1) }, { ok: true })
  assert.equal(res.status, 200)
})

test('approve-similar from the phone needs confirm, and a risky request is never approved as similar, by anybody', async (t) => {
  let role = 'device'
  const { port, a } = await twoAgents(t, { roleOf: () => role })
  await a.send(a.add(1, permission()), a.add(2, risky()))
  assert.deepEqual((await act(port, 'approve-similar', { id: a.itemId(1) })).json, { ok: false, error: 'needs-confirm' })
  const hold = await act(port, 'approve-similar', { id: a.itemId(2), confirmed: true, held: true })
  assert.deepEqual([hold.status, hold.json], [409, { ok: false, error: 'risky' }])
  role = 'desktop'
  assert.deepEqual((await act(port, 'approve-similar', { id: a.itemId(2) })).json, { ok: false, error: 'risky' })
  await nothingQueued(a)
  const { res, cmd } = await viaAgent(a, port, 'approve-similar', { id: a.itemId(1) }, { ok: true, count: 2 })
  assert.deepEqual([res.status, res.json, cmd.kind], [200, { ok: true, count: 2 }, 'approve-similar'])
})

test('an unknown item is not-found, a closed one not-open, before anything is sent', async (t) => {
  const { port, a } = await twoAgents(t)
  await a.send(a.add(1, permission()), { op: 'resolve', id: a.itemId(1), resolution: { kind: 'approved' } })
  assert.deepEqual((await act(port, 'approve', { id: 'nope' })).json, { ok: false, error: 'not-found' })
  assert.deepEqual((await act(port, 'approve', { id: a.itemId(1) })).json, { ok: false, error: 'not-open' })
  await nothingQueued(a)
})

test('every owner action becomes the command of its name with its arguments', async (t) => {
  const { port, a } = await twoAgents(t)
  await a.send(a.add(1, { type: 'question', payload: { questions: [] } }), a.add(2, { type: 'question', payload: { questions: [] } }), a.add(3), a.add(4, { type: 'pr-merged' }), a.add(5, permission()))
  const answers = [{ id: 'q', selected: ['x'] }]
  const cases = [
    ['answer', { id: a.itemId(1), answers }, { answers }],
    ['deny', { id: a.itemId(5) }, {}],
    ['reply', { id: a.itemId(3), text: 'go on' }, { text: 'go on' }],
    ['archive', { id: a.itemId(4) }, {}],
    ['open-session', { id: a.itemId(3) }, { sessionId: 's3' }],
  ]
  for (const [kind, body, args] of cases) {
    const { res, cmd } = await viaAgent(a, port, kind, body, { ok: true })
    assert.equal(res.status, 200, kind)
    assert.deepEqual([cmd.kind, cmd.itemId, cmd.args], [kind, body.id, args], kind)
  }
  await a.send({ op: 'resolve', id: a.itemId(2), resolution: { kind: 'expired' } })
  const late = await viaAgent(a, port, 'late-answer', { id: a.itemId(2), answers }, { ok: true, sent: true })
  assert.deepEqual([late.cmd.kind, late.cmd.args, late.res.json], ['late-answer', { answers }, { ok: true, sent: true }])
})

// ---- outcomes -------------------------------------------------------------------------------------------------------------------

test('what the agent reports is mapped like server.js: a refusal is 409, malformed input 400', async (t) => {
  const { port, a } = await twoAgents(t)
  await a.send(a.add(1, { type: 'question', payload: { questions: [] } }))
  const gone = await viaAgent(a, port, 'deny', { id: a.itemId(1) }, { ok: false, error: 'not-pending' })
  assert.deepEqual([gone.res.status, gone.res.json], [409, { ok: false, error: 'not-pending' }])
  const bad = await viaAgent(a, port, 'answer', { id: a.itemId(1), answers: [] }, { ok: false, error: 'bad-answer' })
  assert.deepEqual([bad.res.status, bad.res.json], [400, { ok: false, error: 'bad-answer' }])
})

test('an owner that never fetches the command: 504 owner-timeout, and the command is gone from its queue', async (t) => {
  const { port, a } = await twoAgents(t, { commandTimeoutsMs: { reply: 120 } })
  await a.send(a.add(1))
  const res = await act(port, 'reply', { id: a.itemId(1), text: 'x' })
  assert.deepEqual([res.status, res.json], [504, { ok: false, error: 'owner-timeout' }])
  await nothingQueued(a)
})

test('a command that was fetched but never answered: 504 unknown-outcome, never shown as a success', async (t) => {
  const { port, a } = await twoAgents(t, { commandTimeoutsMs: { reply: 200 } })
  await a.send(a.add(1))
  const { res, cmd } = await viaAgent(a, port, 'reply', { id: a.itemId(1), text: 'x' })
  assert.ok(cmd)
  assert.deepEqual([res.status, res.json], [504, { ok: false, error: 'unknown-outcome' }])
})

test('an owner that missed 45 s of polling is away (409 owner-away), one that is gone is offline (409 owner-offline); reviewed still works', async (t) => {
  const { hub, port, a, clock } = await twoAgents(t)
  await a.send(a.add(1))
  clock.advance(AWAY_MS + 1000)
  hub.instances.tick()
  assert.deepEqual((await act(port, 'reply', { id: a.itemId(1), text: 'x' })).json, { ok: false, error: 'owner-away' })
  clock.advance(GRACE_MS)
  hub.instances.tick()
  const offline = await act(port, 'reply', { id: a.itemId(1), text: 'x' })
  assert.deepEqual([offline.status, offline.json], [409, { ok: false, error: 'owner-offline' }])
  assert.deepEqual((await act(port, 'reviewed', { id: a.itemId(1) })).json, { ok: true })
})

test('a command waiting for an owner that goes away is answered owner-offline at once', async (t) => {
  const { hub, port, a } = await twoAgents(t)
  await a.send(a.add(1))
  const pending = act(port, 'reply', { id: a.itemId(1), text: 'x' })
  await new Promise((r) => setTimeout(r, 60))
  hub.instances.bye(a.id)
  assert.deepEqual((await pending).json, { ok: false, error: 'owner-offline' })
})

// ---- hub-local transitions tell the owner ------------------------------------------------------------------------------------

test('reviewed and reopen are applied by the hub and sent to a live owner as apply messages', async (t) => {
  const { hub, port, a } = await twoAgents(t)
  await a.send(a.add(1))
  assert.deepEqual((await act(port, 'reviewed', { id: a.itemId(1) })).json, { ok: true })
  assert.equal(hub.store.get(a.itemId(1)).status, 'resolved')
  assert.deepEqual((await act(port, 'reopen', { id: a.itemId(1) })).json, { ok: true })
  const cmds = (await a.poll(0, 0)).json.commands
  assert.deepEqual(cmds.map((c) => [c.kind, c.args.change]), [
    ['apply', { op: 'resolve', id: a.itemId(1), resolution: { kind: 'reviewed', by: 'card' } }],
    ['apply', { op: 'reopen', id: a.itemId(1) }],
  ])
})

// ---- todos and workspaces --------------------------------------------------------------------------------------------------------

test('the workspace union has every online instance, the caller own first', async (t) => {
  const { port, b } = await twoAgents(t)
  const res = await raw({ port, path: P + '/v1/workspaces', headers: { 'x-rq-instance': b.id } })
  assert.deepEqual(res.json.workspaces, [{ id: 'bbbb/w1', title: 'beta' }, { id: 'aaaa/w1', title: 'alpha (DSH :1)' }])
})

test('a todo with a workspace goes to the instance that owns it, with the local workspace id', async (t) => {
  const { port, a } = await twoAgents(t)
  const { res, cmd } = await viaAgent(a, port, 'todo', { text: 'fix it', workspaceId: 'aaaa/w1', sparc: true }, { ok: true, id: 'aaaa-000000000009', state: 'starting' })
  assert.deepEqual([res.status, res.json.state], [200, 'starting'])
  assert.deepEqual([cmd.kind, cmd.args], ['todo-start', { text: 'fix it', sparc: true, workspaceId: 'w1' }])
})

test('a todo for a workspace nobody knows is 400 unknown-workspace, and with no instance at all 409 no-registry', async (t) => {
  const { port } = await twoAgents(t)
  assert.deepEqual((await act(port, 'todo', { text: 'x', workspaceId: 'zzzz/w9' })).json, { ok: false, error: 'unknown-workspace' })
  const empty = await startHub(t)
  assert.deepEqual((await act(empty.port, 'todo', { text: 'x' })).json, { ok: false, error: 'no-registry' })
  assert.deepEqual((await act(empty.port, 'todo', { text: 'x', workspaceId: 'aaaa/w1' })).json, { ok: false, error: 'no-registry' })
})

test('choose for me: the calling instance coordinates, else the most recently desktop-active one; it gets the whole union', async (t) => {
  const { port, a, b } = await twoAgents(t)
  const first = await viaAgent(b, port, 'todo', { text: 'fix it' }, { ok: true, id: 'bbbb-000000000001', state: 'awaiting-confirm' }, { 'x-rq-instance': b.id })
  assert.equal(first.cmd.kind, 'todo-suggest')
  assert.deepEqual(first.cmd.args.workspaces.map((w) => [w.id, w.title, w.path]), [['bbbb/w1', 'beta', 'D:/b'], ['aaaa/w1', 'alpha (DSH :1)', 'D:/a']])
  assert.equal(first.cmd.args.text, 'fix it')
  await a.post('presence', { desktopActive: true })
  const second = await viaAgent(a, port, 'todo', { text: 'again' }, { ok: true, id: 'aaaa-000000000001', state: 'awaiting-confirm' })
  assert.equal(second.cmd.kind, 'todo-suggest')
})

test('confirming a todo for a workspace of its own instance sends todo-start there', async (t) => {
  const { port, b } = await twoAgents(t)
  await b.send(b.add(1, { type: 'todo', text: 'fix it', state: 'awaiting-confirm', suggested: { workspaceId: 'bbbb/w1', title: 'beta' } }))
  const { res, cmd } = await viaAgent(b, port, 'todo-confirm', { id: b.itemId(1) }, { ok: true, state: 'starting' })
  assert.equal(res.status, 200)
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args], ['todo-start', b.itemId(1), { workspaceId: 'w1' }])
})

test('confirming a todo for a workspace of another instance moves the item there: owner changes, the new owner gets the item, the old one drops it', async (t) => {
  const { hub, port, a, b } = await twoAgents(t)
  await b.send(b.add(1, { type: 'todo', text: 'fix it', state: 'awaiting-confirm', suggested: { workspaceId: 'aaaa/w1', title: 'alpha' } }))
  const pending = act(port, 'todo-confirm', { id: b.itemId(1) })
  const got = (await a.poll(0, 3000)).json.commands[0]
  assert.deepEqual([got.kind, got.args.workspaceId, got.args.item.id, got.args.item.text], ['todo-start', 'w1', b.itemId(1), 'fix it'])
  assert.equal(hub.store.get(b.itemId(1)).owner, a.id)
  await a.result(got.cid, { ok: true, state: 'starting' })
  assert.equal((await pending).status, 200)
  const drop = (await b.poll(0, 0)).json.commands[0]
  assert.deepEqual([drop.kind, drop.args.change], ['apply', { op: 'drop', id: b.itemId(1) }])
})

test('a move that the new owner cannot start is undone: the item stays with its old owner', async (t) => {
  const { hub, port, a, b } = await twoAgents(t)
  await b.send(b.add(1, { type: 'todo', text: 'x', state: 'awaiting-confirm' }))
  const pending = act(port, 'todo-confirm', { id: b.itemId(1), workspaceId: 'aaaa/w1' })
  const got = (await a.poll(0, 3000)).json.commands[0]
  await a.result(got.cid, { ok: false, error: 'unknown-workspace' })
  assert.deepEqual([(await pending).status, hub.store.get(b.itemId(1)).owner], [400, b.id])
  await nothingQueued(b)
})

test('todo-confirm without any workspace is 400 no-workspace; cancel goes to the owner', async (t) => {
  const { port, a } = await twoAgents(t)
  await a.send(a.add(1, { type: 'todo', text: 'x', state: 'awaiting-confirm' }))
  assert.deepEqual((await act(port, 'todo-confirm', { id: a.itemId(1) })).json, { ok: false, error: 'no-workspace' })
  const { res, cmd } = await viaAgent(a, port, 'todo-cancel', { id: a.itemId(1) }, { ok: true })
  assert.deepEqual([res.status, cmd.kind], [200, 'todo-cancel'])
})

test('actions that only the desktop can do stay 403 local-only', async (t) => {
  const { port } = await twoAgents(t)
  for (const kind of ['read', 'stop', 'ui', 'focus']) assert.equal((await act(port, kind, { id: 'x' })).status, 403, kind)
})
