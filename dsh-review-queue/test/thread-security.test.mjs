import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postJson, tmpDir } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'
import { P as PD, startPhoneHub } from './hub-device-helpers.mjs'

// Security review of the phone chat (thread and post): a todo is neither read nor written to (the hub refuses it before sending, so the
// coordinator's sessionId fallback cannot bypass it), a phone's post leaves an audit line without its text, and the limits are documented.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const act = (port, kind, body) => postJson(port, P + '/v1/' + kind, body)

// ---- the hub refuses a todo for thread and post before sending anything ------------------------------------------------------------

test('thread of a todo item is no-session and post is not-a-session: the owner is never asked', async (t) => {
  const { port } = await startHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, { type: 'todo', text: 'fix it', state: 'started', sessionId: 's1' }), a.add(2, { type: 'todo', text: 'x', state: 'awaiting-confirm' }))
  for (const n of [1, 2]) {
    assert.deepEqual((await act(port, 'thread', { id: a.itemId(n) })).json, { ok: false, error: 'no-session' }, 'thread ' + n)
    assert.deepEqual((await act(port, 'post', { id: a.itemId(n), text: 'hello' })).json, { ok: false, error: 'not-a-session' }, 'post ' + n)
  }
  assert.deepEqual((await a.poll(0, 0)).json.commands, [], 'nothing was sent to the app')
})

test('a resolved todo is refused the same way', async (t) => {
  const { port } = await startHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  await a.send(a.add(1, { type: 'todo', text: 'x', state: 'started', sessionId: 's1' }), { op: 'resolve', id: a.itemId(1), resolution: { kind: 'cancelled', by: 'card' } })
  assert.deepEqual((await act(port, 'thread', { id: a.itemId(1) })).json, { ok: false, error: 'no-session' })
  assert.deepEqual((await act(port, 'post', { id: a.itemId(1), text: 'x' })).json, { ok: false, error: 'not-a-session' })
  assert.deepEqual((await a.poll(0, 0)).json.commands, [])
})

test('an ownerless open todo (the coordinator path that carries a session id) is refused before the coordinator is asked', async (t) => {
  const dir = tmpDir(t)
  const row = { id: 'old-todo', seq: 1, type: 'todo', status: 'open', createdAt: 1_800_000_000_000, sessionId: 'session-todo', state: 'started', text: 'x', payload: {} }
  writeFileSync(join(dir, 'queue.json'), JSON.stringify({ v: 1, seq: 2, items: [row] }))
  const { port } = await startHub(t, { dir })
  const a = agentOf(port)
  await a.register({ sync: sync() })
  assert.deepEqual((await act(port, 'thread', { id: 'old-todo' })).json, { ok: false, error: 'no-session' })
  assert.deepEqual((await act(port, 'post', { id: 'old-todo', text: 'x' })).json, { ok: false, error: 'not-a-session' })
  assert.deepEqual((await a.poll(0, 0)).json.commands, [], 'no thread command, no adopt')
})

test('items of the other types still reach the owner (the guard is the todo only)', async (t) => {
  const { port } = await startHub(t)
  const a = agentOf(port)
  await a.register({ sync: sync() })
  await a.send(a.add(1))
  const pending = act(port, 'thread', { id: a.itemId(1) })
  const cmd = (await a.poll(0, 3000)).json.commands[0]
  assert.equal(cmd.kind, 'thread')
  await a.result(cmd.cid, { ok: true, messages: [], hasMore: false })
  assert.equal((await pending).status, 200)
})

// ---- the audit line of a post --------------------------------------------------------------------------------------------------------

test('a post from a paired phone is logged by the hub as: post: device <id> item <id> chars <n>, never with its text', async (t) => {
  const h = await startPhoneHub(t, { commandTimeoutsMs: { post: 80 } })
  const a = agentOf(h.port)
  await a.register({ sync: sync() })
  await a.send(a.add(1))
  const p = await h.pairPhone()
  const text = 'TOP-SECRET-PROMPT-TEXT'
  await p.call('POST', PD + '/v1/post', { id: a.itemId(1), text })
  assert.deepEqual(h.logs.filter((l) => l.startsWith('post: ')), ['post: device ' + p.deviceId + ' item ' + a.itemId(1) + ' chars ' + text.length])
  assert.equal(h.logs.join('\n').includes('SECRET'), false, 'the text is not in any line of the hub log')
})

test('the audit line is written for a refused or failing post too, and not for a thread read or a post of the desktop', async (t) => {
  const h = await startPhoneHub(t, { commandTimeoutsMs: { post: 80, thread: 80 } })
  const a = agentOf(h.port)
  await a.register({ sync: sync() })
  await a.send(a.add(1))
  const p = await h.pairPhone()
  await p.call('POST', PD + '/v1/post', { id: 'nope', text: 'hello' })
  await p.call('POST', PD + '/v1/thread', { id: a.itemId(1) })
  await h.desktop('POST', PD + '/v1/post', { id: a.itemId(1), text: 'from the desktop' })
  assert.deepEqual(h.logs.filter((l) => l.startsWith('post: ')), ['post: device ' + p.deviceId + ' item nope chars 5'])
})

test('a hostile item id or text type cannot forge or flood the audit line', async (t) => {
  const h = await startPhoneHub(t, { commandTimeoutsMs: { post: 80 } })
  const p = await h.pairPhone()
  await p.call('POST', PD + '/v1/post', { id: 'x\nforged: line ' + 'y'.repeat(200), text: { not: 'a string' } })
  const lines = h.logs.filter((l) => l.startsWith('post: '))
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0], /[\r\n]/)
  assert.ok(lines[0].length < 160, 'bounded: ' + lines[0].length)
  assert.match(lines[0], /chars 0$/)
})

// ---- the documentation says what the phone can now do -------------------------------------------------------------------------------

const section = (md, from, to) => md.slice(md.indexOf(from), md.indexOf(to, md.indexOf(from)))

test('hub.md 6.8 carries the security note: allowedTailnetLogins, transcripts, duplicate post, the depth cap, the audit line', () => {
  const hub = readFileSync(join(root, 'docs', 'hub.md'), 'utf8')
  const s = section(hub, '### 6.8 ', '## 7. ')
  assert.match(s, /allowedTailnetLogins/)
  assert.match(s, /prompt any item's session/i)
  assert.match(s, /transcript/i)
  assert.match(s, /unknown-outcome/)
  assert.match(s, /duplicate/i)
  assert.match(s, /MAX_THREAD_DEPTH/)
  assert.match(s, /400/)
  assert.match(s, /post: device/)
  assert.match(s, /post-failed/)
})

test('mobile.md documents the paging depth cap and that the conversation loads only while it is open', () => {
  const mobile = readFileSync(join(root, 'docs', 'mobile.md'), 'utf8')
  const s = section(mobile, '## Chat thread', '## iPhone')
  assert.match(s, /MAX_THREAD_DEPTH/)
  assert.match(s, /400/)
  assert.doesNotMatch(s, /first load run whether the section is open or not/)
  assert.match(s, /only while the Conversation section is open/i)
})
