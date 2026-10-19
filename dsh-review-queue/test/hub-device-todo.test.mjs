import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentOf, sync } from './hub-agent-helpers.mjs'
import { P, startPhoneHub } from './hub-device-helpers.mjs'

// A paired phone may start todos: POST /v1/todo, /v1/todo-confirm and /v1/todo-cancel go through the hub like the desktop's, and are
// routed by hub/routing.js (a workspace goes to its owner, "Choose for me" to the most recently desktop-active online app). It still
// may not open sessions: open-session (and every action not on the phone's list) stays 403 desktop-only.

const ws = (id, title, path) => ({ id, title, path })

async function withAgent(t) {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  await a.register({ sync: sync({ workspaces: [ws('w1', 'alpha', 'D:/a')] }) })
  await a.post('presence', { desktopActive: true })
  const p = await h.pairPhone()
  /** One phone action, answered by the agent when it receives a command. */
  const viaAgent = async (kind, body, result = { ok: true }) => {
    const pending = p.call('POST', P + '/v1/' + kind, body)
    const got = await a.poll(0, 3000)
    const cmd = got.json.commands[0]
    if (cmd) await a.result(cmd.cid, result)
    return { res: await pending, cmd }
  }
  return { h, a, p, viaAgent }
}

test('a phone can start a todo in a workspace: the owner app gets todo-start with its own workspace id', async (t) => {
  const { viaAgent } = await withAgent(t)
  const { res, cmd } = await viaAgent('todo', { text: 'fix it', workspaceId: 'aaaa/w1', sparc: true }, { ok: true, id: 'aaaa-000000000009', state: 'starting' })
  assert.deepEqual([res.status, res.json.ok, res.json.state], [200, true, 'starting'])
  assert.deepEqual([cmd.kind, cmd.args], ['todo-start', { text: 'fix it', sparc: true, workspaceId: 'w1' }])
})

test('a phone todo with "Choose for me" goes to the coordinator as todo-suggest, with the workspaces to choose from', async (t) => {
  const { viaAgent } = await withAgent(t)
  const { res, cmd } = await viaAgent('todo', { text: 'fix it' }, { ok: true, id: 'aaaa-000000000009', state: 'awaiting-confirm' })
  assert.deepEqual([res.status, res.json.state], [200, 'awaiting-confirm'])
  assert.equal(cmd.kind, 'todo-suggest')
  assert.equal(cmd.args.text, 'fix it')
  assert.deepEqual(cmd.args.workspaces.map((w) => w.title), ['alpha'])
})

test('a phone can confirm a todo (Start / Retry): the owner app gets todo-start for that item', async (t) => {
  const { a, viaAgent } = await withAgent(t)
  await a.send(a.add(1, { type: 'todo', text: 'fix it', state: 'awaiting-confirm', suggested: { workspaceId: 'aaaa/w1', title: 'alpha' } }))
  const { res, cmd } = await viaAgent('todo-confirm', { id: a.itemId(1), workspaceId: 'aaaa/w1' }, { ok: true, state: 'starting' })
  assert.equal(res.status, 200)
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args], ['todo-start', a.itemId(1), { workspaceId: 'w1' }])
})

test('a phone can cancel a todo: the owner app gets todo-cancel for that item', async (t) => {
  const { a, viaAgent } = await withAgent(t)
  await a.send(a.add(1, { type: 'todo', text: 'fix it', state: 'awaiting-confirm' }))
  const { res, cmd } = await viaAgent('todo-cancel', { id: a.itemId(1) })
  assert.equal(res.status, 200)
  assert.deepEqual([cmd.kind, cmd.itemId], ['todo-cancel', a.itemId(1)])
})

test('a phone todo with no app online is 409 no-registry, not 403', async (t) => {
  const h = await startPhoneHub(t)
  const p = await h.pairPhone()
  const res = await p.call('POST', P + '/v1/todo', { text: 'fix it' })
  assert.deepEqual([res.status, res.json], [409, { ok: false, error: 'no-registry' }])
})

test('a phone todo for a workspace nobody lists is 400 unknown-workspace', async (t) => {
  const { p } = await withAgent(t)
  const res = await p.call('POST', P + '/v1/todo', { text: 'fix it', workspaceId: 'zzzz/w9' })
  assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'unknown-workspace' }])
})

test('the phone reads the workspaces for the dropdown (GET /v1/workspaces stays open to a device)', async (t) => {
  const { p } = await withAgent(t)
  const res = await p.call('GET', P + '/v1/workspaces')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.workspaces, [{ id: 'aaaa/w1', title: 'alpha' }])
})

test('a phone still cannot open a session: open-session is 403 desktop-only, and nothing reaches the app', async (t) => {
  const { a, p } = await withAgent(t)
  const res = await p.call('POST', P + '/v1/open-session', { id: 'x' })
  assert.deepEqual([res.status, res.json], [403, { error: 'desktop-only' }])
  assert.deepEqual((await a.poll(0, 0)).json.commands, [])
})

test('the todo actions keep the other fences: a stranger is 401, a foreign Origin is refused', async (t) => {
  const { h, p } = await withAgent(t)
  for (const kind of ['todo', 'todo-confirm', 'todo-cancel']) {
    assert.equal((await h.stranger('POST', P + '/v1/' + kind, { text: 'x', id: 'x' })).status, 401, kind + ' stranger')
    const evil = await p.call('POST', P + '/v1/' + kind, { text: 'x', id: 'x' }, { origin: 'https://evil.example' })
    assert.deepEqual([evil.status, evil.json], [403, { error: 'bad-origin' }], kind + ' origin')
  }
})

test('a revoked phone cannot start a todo any more (401)', async (t) => {
  const { h, p } = await withAgent(t)
  await h.desktop('POST', '/hub/v1/devices/' + p.deviceId + '/revoke', {})
  const res = await p.call('POST', P + '/v1/todo', { text: 'x' })
  assert.equal(res.status, 401)
})

// ---- the list itself: source check in the style of the other static tests ---------------------------------------------------------------------

const http = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'hub', 'http.js'), 'utf8')

test('DEVICE_ACTIONS is exactly the old phone actions plus todo, todo-confirm, todo-cancel and the chat view (thread, post), never open-session', () => {
  const m = /const DEVICE_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(http)
  assert.ok(m, 'DEVICE_ACTIONS literal')
  const actions = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
  assert.deepEqual(actions, ['answer', 'approve', 'approve-similar', 'archive', 'deny', 'late-answer', 'post', 'reopen', 'reply', 'reviewed', 'thread', 'todo', 'todo-cancel', 'todo-confirm'])
  assert.ok(!actions.includes('open-session'))
})

test('the comment above DEVICE_ACTIONS says a phone may start todos but never open sessions', () => {
  const m = /(\/\*\*[^]*?\*\/)\s*\nconst DEVICE_ACTIONS/.exec(http)
  assert.ok(m, 'a doc comment right above DEVICE_ACTIONS')
  assert.match(m[1], /todo/i)
  assert.match(m[1], /open-session/)
  assert.doesNotMatch(m[1], /todo\*, open-session\) stays on the desktop/, 'the old "todo* stays on the desktop" wording is gone')
})
