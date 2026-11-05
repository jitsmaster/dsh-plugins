import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentOf } from './hub-agent-helpers.mjs'
import { P, startPhoneHub } from './hub-device-helpers.mjs'
import { act, autopilot, kinds, nothingQueued, twoApps, ws } from './hub-follow-up-helpers.mjs'

// A trusted todo-link without followUp (start_session): the hub never starts the session. The coordinator stores a waiting card (todo-suggest
// with requireConfirm, source and the workspace as the hub lists it), and a later todo-confirm starts it in the chosen workspace.

const SOURCE = { sessionId: 's1', title: 'Requester' }
const BODY = { text: 'fix the engine', requireConfirm: true, workspaceId: 'bbbb/w1', source: SOURCE, sparc: true }
const accepted = (agent) => (cmd) => (cmd.kind === 'todo-suggest' ? { ok: true, id: agent.itemId(9), state: 'awaiting-confirm' } : { ok: false, error: 'unexpected-' + cmd.kind })

test('todo-link with requireConfirm and a workspace of another app: the coordinator gets todo-suggest with the hub workspace id, source and the list; nobody gets todo-start', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, accepted(a))
  const seenB = autopilot(t, b, accepted(b))
  const res = await act(port, 'todo-link', BODY, { 'x-rq-instance': a.id })
  assert.deepEqual([res.status, res.json], [200, { ok: true, id: a.itemId(9), state: 'awaiting-confirm' }])
  assert.deepEqual([kinds(seenA), kinds(seenB)], [['todo-suggest'], []])
  const args = seenA[0].args
  assert.deepEqual([args.text, args.requireConfirm, args.source, args.workspaceId, args.sparc], ['fix the engine', true, SOURCE, 'bbbb/w1', true])
  assert.deepEqual(args.workspaces.map((w) => w.id).sort(), ['aaaa/w1', 'bbbb/w1'], 'the list the app picks the workspace from carries the same hub ids')
})

test('an unknown workspace is 400 unknown-workspace and nothing is sent', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, accepted(a))
  autopilot(t, b, accepted(b))
  const res = await act(port, 'todo-link', { ...BODY, workspaceId: 'bbbb/nope' }, { 'x-rq-instance': a.id })
  assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'unknown-workspace' }])
  assert.deepEqual(kinds(seenA), [])
})

test('requireConfirm that is not a boolean, or a bad source, is refused before anything is sent', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, accepted(a))
  autopilot(t, b, accepted(b))
  const bad = await act(port, 'todo-link', { ...BODY, requireConfirm: 'yes' }, { 'x-rq-instance': a.id })
  assert.deepEqual(bad.json, { ok: false, error: 'bad-require-confirm' })
  const src = await act(port, 'todo-link', { ...BODY, source: { sessionId: '../x' } }, { 'x-rq-instance': a.id })
  assert.deepEqual(src.json, { ok: false, error: 'bad-source' })
  assert.deepEqual(kinds(seenA), [])
})

test('without a workspace the todo-link goes to the coordinator for a suggestion, still with requireConfirm and source', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, accepted(a))
  autopilot(t, b, accepted(b))
  const { workspaceId, ...open } = BODY
  const res = await act(port, 'todo-link', open, { 'x-rq-instance': a.id })
  assert.equal(res.status, 200)
  assert.deepEqual([seenA[0].args.requireConfirm, seenA[0].args.source, 'workspaceId' in seenA[0].args], [true, SOURCE, false])
})

test('a trusted todo-link with a workspace and no requireConfirm starts at once and the todo-start carries the source', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, () => ({ ok: true, id: a.itemId(9), state: 'starting' }))
  const seenB = autopilot(t, b, () => ({ ok: true, id: b.itemId(9), state: 'starting' }))
  const { requireConfirm, ...direct } = BODY
  const res = await act(port, 'todo-link', direct, { 'x-rq-instance': a.id })
  assert.equal(res.status, 200)
  const sent = [...seenA, ...seenB]
  assert.deepEqual(sent.map((c) => c.kind), ['todo-start'])
  assert.deepEqual([sent[0].args.source, 'requireConfirm' in sent[0].args], [SOURCE, false])
})

test('an untrusted todo never forwards requireConfirm or source, with a workspace or without', async (t) => {
  const { port, a, b } = await twoApps(t)
  const seenA = autopilot(t, a, (cmd) => ({ ok: true, id: a.itemId(9), state: cmd.kind === 'todo-start' ? 'starting' : 'awaiting-confirm' }))
  const seenB = autopilot(t, b, (cmd) => ({ ok: true, id: b.itemId(9), state: 'starting' }))
  await act(port, 'todo', { text: 'x', requireConfirm: true, source: SOURCE }, { 'x-rq-instance': a.id })
  await act(port, 'todo', { text: 'x', requireConfirm: true, source: SOURCE, workspaceId: 'bbbb/w1' }, { 'x-rq-instance': a.id })
  const sent = [...seenA, ...seenB]
  assert.deepEqual(sent.map((c) => c.kind).sort(), ['todo-start', 'todo-suggest'])
  for (const c of sent) for (const key of ['requireConfirm', 'source']) assert.equal(key in c.args, false, c.kind + ' ' + key)
})

test('a paired phone gets 403 desktop-only on a todo-link without followUp, and nothing is sent', async (t) => {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: { n: 0, openItems: [], resolvedItems: [], workspaces: [ws('w1', 'alpha', 'D:/a')], sessionIds: [] } })
  const p = await h.pairPhone()
  const res = await p.call('POST', P + '/v1/todo-link', BODY)
  assert.deepEqual([res.status, res.json], [403, { error: 'desktop-only' }])
  await nothingQueued(a)
})

test('todo-confirm of the waiting card (owner a, suggested workspace of b) starts it in b: the item moves to b and b gets todo-start', async (t) => {
  const { port, a, b, hub } = await twoApps(t)
  await a.send(a.add(1, { type: 'todo', text: 'fix the engine', state: 'awaiting-confirm', source: SOURCE, suggested: { workspaceId: 'bbbb/w1', title: 'beta (DSH :2)', reason: 'picked by the requesting session' } }))
  const seenA = autopilot(t, a, () => ({ ok: true }))
  const seenB = autopilot(t, b, (cmd) => (cmd.kind === 'todo-start' ? { ok: true, state: 'starting' } : undefined))
  const res = await act(port, 'todo-confirm', { id: a.itemId(1) }, { 'x-rq-instance': a.id })
  assert.deepEqual([res.status, res.json.ok], [200, true])
  assert.deepEqual(kinds(seenB), ['todo-start'])
  assert.equal(seenB[0].itemId, a.itemId(1))
  assert.equal(seenB[0].args.workspaceId, 'w1', 'the owning app gets its own local id')
  assert.equal(seenB[0].args.item.source.sessionId, 's1', 'the item, with its source, moves along')
  assert.equal(hub.store.get(a.itemId(1)).owner, b.id)
  assert.equal(kinds(seenA).includes('todo-start'), false)
})
