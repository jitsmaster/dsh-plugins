import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QUEUE_VERSION } from '../hub/hub-store.js'
import { postJson, tmpDir } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

// A post from the phone adopts an ownerless open item (the coordinator takes it) only for a done item: posting to it resolves it as replied, so
// the coordinator that sends the prompt may own it. Posting to any other open type resolves nothing: nothing is adopted, and the card gets
// session-unavailable. Real hub routing, real agent protocol; reply keeps its old behaviour (it adopts whatever the type).

const act = (port, kind, body) => postJson(port, P + '/v1/' + kind, body)
const PAYLOADS = { completed: { reply: 'r' }, question: { questions: [] }, permission: { toolName: 'shell', summary: 'ls', detail: 'ls' }, paused: {}, 'pr-merged': { prId: '7', followUps: [] } }
const row = (type, seq) => ({ id: 'old-' + type, seq, type, status: 'open', createdAt: 1_800_000_000_000, sessionId: 's-' + type, payload: PAYLOADS[type] })
/** A hub whose queue file holds one open item without an owner of each type (a v2 file: the legacy import would end the questions and permissions). */
function writeQueue(dir, types) {
  mkdirSync(join(dir, 'hub'), { recursive: true })
  writeFileSync(join(dir, 'hub', 'queue.json'), JSON.stringify({ v: QUEUE_VERSION, epoch: 'e1', seq: types.length + 1, rev: 0, items: types.map((type, i) => row(type, i + 1)), instances: [] }))
}
async function legacyHub(t) {
  const dir = tmpDir(t)
  writeQueue(dir, Object.keys(PAYLOADS))
  const ctx = await startHub(t, { dir })
  const a = agentOf(ctx.port)
  await a.register({ sync: sync() })
  return { ...ctx, a }
}

test('a post to an ownerless open question, permission, paused or merged-PR item is session-unavailable: nothing is sent and the item is not adopted', async (t) => {
  const { hub, port, a } = await legacyHub(t)
  for (const type of ['question', 'permission', 'paused', 'pr-merged']) {
    const res = await act(port, 'post', { id: 'old-' + type, text: 'hello' })
    assert.deepEqual(res.json, { ok: false, error: 'session-unavailable' }, type)
    assert.equal(hub.store.get('old-' + type).owner, undefined, type + ' stays ownerless')
  }
  assert.deepEqual((await a.poll(0, 0)).json.commands, [], 'no apply, no post reached the coordinator')
})

test('the answer is the same when no app is online: a post to a non-done ownerless item does not depend on a coordinator', async (t) => {
  const dir = tmpDir(t)
  writeQueue(dir, ['question'])
  const { port } = await startHub(t, { dir })
  assert.deepEqual((await act(port, 'post', { id: 'old-question', text: 'x' })).json, { ok: false, error: 'session-unavailable' })
})

test('a post to an ownerless open done item still adopts it first and sends the post; success keeps the coordinator as its owner', async (t) => {
  const { hub, port, a } = await legacyHub(t)
  const pending = act(port, 'post', { id: 'old-completed', text: 'hello' })
  const cmds = (await a.poll(0, 3000)).json.commands
  assert.deepEqual(cmds.map((c) => c.kind), ['apply', 'post'])
  await a.result(cmds.find((c) => c.kind === 'post').cid, { ok: true })
  assert.deepEqual((await pending).json, { ok: true })
  assert.equal(hub.store.get('old-completed').owner, 'aaaa1111')
})

test('reply is unchanged: an ownerless open question is adopted for it and given back when the owner refuses', async (t) => {
  const { hub, port, a } = await legacyHub(t)
  const pending = act(port, 'reply', { id: 'old-question', text: 'hello' })
  const cmds = (await a.poll(0, 3000)).json.commands
  assert.deepEqual(cmds.map((c) => c.kind), ['apply', 'reply'], 'adoption and the reply, as before')
  await a.result(cmds.find((c) => c.kind === 'reply').cid, { ok: false, error: 'not-completed' })
  assert.deepEqual((await pending).json, { ok: false, error: 'not-completed' })
  assert.equal(hub.store.get('old-question').owner, undefined)
})
