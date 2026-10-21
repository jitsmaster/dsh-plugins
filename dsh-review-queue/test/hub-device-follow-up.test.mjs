import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentOf } from './hub-agent-helpers.mjs'
import { P, startPhoneHub } from './hub-device-helpers.mjs'
import { answers, autopilot, followItem, kinds, nothingQueued, sess, ws } from './hub-follow-up-helpers.mjs'

// The phone does a follow-up todo through the same two calls as any todo (POST /v1/todo {text, followUp}, POST /v1/todo-confirm {id, sessionId}); the
// hub asks the apps, never the phone, for the sessions.

async function phoneWithApps(t) {
  const h = await startPhoneHub(t)
  const a = agentOf(h.port)
  const b = agentOf(h.port, { id: 'bbbb2222', key: 'k2', label: 'DSH :2' })
  await a.register({ sync: { n: 0, openItems: [], resolvedItems: [], workspaces: [ws('w1', 'alpha', 'D:/a')], sessionIds: [] } })
  await b.register({ sync: { n: 0, openItems: [], resolvedItems: [], workspaces: [ws('w1', 'beta', 'D:/b')], sessionIds: [] } })
  await b.post('presence', { desktopActive: true }) // the phone's coordinator: the most recently desktop-active app
  const p = await h.pairPhone()
  return { h, a, b, p }
}
const BODY = { text: 'also the null case', followUp: 'the PR review' }

test('a phone follow-up is coordinated by the most recently desktop-active app, with the sessions of both apps tagged by owner', async (t) => {
  const { a, b, p } = await phoneWithApps(t)
  const seenA = autopilot(t, a, answers(a, [sess('sa1', 100)]))
  const seenB = autopilot(t, b, answers(b, [sess('sb1', 200)]))
  const res = await p.call('POST', P + '/v1/todo', BODY)
  assert.deepEqual([res.status, res.json], [200, { ok: true, id: b.itemId(9), state: 'awaiting-confirm' }])
  const suggest = seenB.find((c) => c.kind === 'followup-suggest')
  assert.deepEqual(suggest.args.sessions.map((s) => [s.sessionId, s.owner]), [['sb1', b.id], ['sa1', a.id]])
  assert.deepEqual([kinds(seenA), kinds(seenB)], [['sessions-list'], ['sessions-list', 'followup-suggest']])
})

test('the phone cannot bring its own sessions: a sessions list in its body is dropped, only the apps\' sessions count', async (t) => {
  const { a, b, p } = await phoneWithApps(t)
  autopilot(t, a, answers(a, [sess('sa1', 100)]))
  const seenB = autopilot(t, b, answers(b, []))
  const res = await p.call('POST', P + '/v1/todo', { ...BODY, sessions: [{ sessionId: 'evil', title: 'x', owner: a.id, updatedAt: 99_999_999 }] })
  assert.equal(res.status, 200)
  assert.deepEqual(seenB.find((c) => c.kind === 'followup-suggest').args.sessions.map((s) => s.sessionId), ['sa1'])
})

test('a phone follow-up with empty words is 400 empty-query and no app is asked', async (t) => {
  const { a, b, p } = await phoneWithApps(t)
  const res = await p.call('POST', P + '/v1/todo', { text: 'x', followUp: '  ' })
  assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'empty-query' }])
  await nothingQueued(a)
  await nothingQueued(b)
})

test('a phone can confirm a follow-up to a session of the other app: the item moves there and that app gets followup-send', async (t) => {
  const { h, a, b, p } = await phoneWithApps(t)
  await a.send(followItem(a, 1, { candidates: [{ sessionId: 'sa1', title: 'A', owner: a.id }, { sessionId: 'sb1', title: 'B', owner: b.id }] }))
  const pending = p.call('POST', P + '/v1/todo-confirm', { id: a.itemId(1), sessionId: 'sb1' })
  const cmd = (await b.poll(0, 3000)).json.commands[0]
  assert.deepEqual([cmd.kind, cmd.itemId, cmd.args.sessionId], ['followup-send', a.itemId(1), 'sb1'])
  await b.result(cmd.cid, { ok: true, state: 'starting' })
  assert.equal((await pending).status, 200)
  assert.equal(h.hub.store.get(a.itemId(1)).owner, b.id)
})

test('a phone confirm of a session the item does not list is 400 unknown-session', async (t) => {
  const { a, b, p } = await phoneWithApps(t)
  await a.send(followItem(a, 1, { candidates: [{ sessionId: 'sa1', title: 'A', owner: a.id }] }))
  const res = await p.call('POST', P + '/v1/todo-confirm', { id: a.itemId(1), sessionId: 'sb1' })
  assert.deepEqual([res.status, res.json], [400, { ok: false, error: 'unknown-session' }])
  await nothingQueued(a)
  await nothingQueued(b)
})

test('the commands of the follow-up are not actions of the phone: the URL of sessions-list, followup-suggest and followup-send is unknown (404)', async (t) => {
  const { a, p } = await phoneWithApps(t)
  for (const kind of ['sessions-list', 'followup-suggest', 'followup-send']) {
    const res = await p.call('POST', P + '/v1/' + kind, { id: 'x', text: 'x', followUp: 'x', sessions: [] })
    assert.deepEqual([res.status, res.json], [404, { error: 'unknown-action' }], kind)
  }
  await nothingQueued(a)
})

test('a stranger and a foreign Origin are refused on a follow-up as on any todo', async (t) => {
  const { h, p } = await phoneWithApps(t)
  assert.equal((await h.stranger('POST', P + '/v1/todo', BODY)).status, 401)
  const evil = await p.call('POST', P + '/v1/todo', BODY, { origin: 'https://evil.example' })
  assert.deepEqual([evil.status, evil.json], [403, { error: 'bad-origin' }])
})

// ---- the audit lines of a phone that sends a message into an existing session (docs/hub.md 6.8): who, which item and session, how long; never the text ----

const audit = (h) => h.logs.filter((l) => l.startsWith('followup-'))

test('a phone follow-up leaves an audit line with the device and the length of the message, never the message or the words', async (t) => {
  const { h, a, b, p } = await phoneWithApps(t)
  autopilot(t, a, answers(a, []))
  autopilot(t, b, answers(b, []))
  const text = 'TOP-SECRET-MESSAGE-TEXT'
  await p.call('POST', P + '/v1/todo', { text, followUp: 'SECRET-WORDS-ABOUT-THE-SESSION' })
  assert.deepEqual(audit(h), ['followup-add: device ' + p.deviceId + ' chars ' + text.length])
  assert.equal(h.logs.join('\n').includes('SECRET'), false, 'neither the text nor the words are in any line of the hub log')
})

test('a phone confirm of a follow-up leaves device, item, target session and the length of the text', async (t) => {
  const { h, a, p } = await phoneWithApps(t)
  await a.send(followItem(a, 1, { text: 'SECRET message', candidates: [{ sessionId: 'sa1', title: 'A', owner: a.id }, { sessionId: 'sa2', title: 'B', owner: a.id }], suggested: { sessionId: 'sa2', title: 'B', reason: 'r', owner: a.id } }))
  autopilot(t, a, () => ({ ok: true, state: 'starting' }))
  await p.call('POST', P + '/v1/todo-confirm', { id: a.itemId(1), sessionId: 'sa1' })
  await p.call('POST', P + '/v1/todo-confirm', { id: a.itemId(1) }) // the suggested session
  assert.deepEqual(audit(h), [
    'followup-confirm: device ' + p.deviceId + ' item ' + a.itemId(1) + ' session sa1 chars 14',
    'followup-confirm: device ' + p.deviceId + ' item ' + a.itemId(1) + ' session sa2 chars 14',
  ])
  assert.equal(h.logs.join('\n').includes('SECRET'), false)
})

test('the audit lines are written for a refused follow-up confirm too, with the session as the phone named it; a hostile id or session cannot forge a line', async (t) => {
  const { h, a, p } = await phoneWithApps(t)
  await a.send(followItem(a, 1, { candidates: [{ sessionId: 'sa1', title: 'A', owner: a.id }] }))
  await p.call('POST', P + '/v1/todo-confirm', { id: a.itemId(1), sessionId: 'x\nforged: line ' + 'y'.repeat(200) })
  const lines = audit(h)
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0], /[\r\n]/)
  assert.ok(lines[0].length < 200, 'bounded: ' + lines[0].length)
  assert.match(lines[0], /^followup-confirm: device \S+ item \S+ session x\?forged\?\?line/)
  const odd = await p.call('POST', P + '/v1/todo-confirm', { id: a.itemId(1), sessionId: { not: 'a string' } })
  assert.equal(odd.status, 400)
  assert.match(audit(h)[1], /session \? chars/)
})

test('nothing is audited for an ordinary todo or its confirm, for the desktop, or for a confirm of an item that is not a follow-up', async (t) => {
  const { h, a, b, p } = await phoneWithApps(t)
  autopilot(t, a, (cmd) => (cmd.kind === 'sessions-list' ? { ok: true, sessions: [] } : { ok: true, state: 'starting', id: a.itemId(9) }))
  autopilot(t, b, answers(b, []))
  await a.send(followItem(a, 1, { candidates: [{ sessionId: 'sa1', title: 'A', owner: a.id }] }))
  await a.send(a.add(2, { type: 'todo', text: 'fix it', state: 'awaiting-confirm', suggested: { workspaceId: 'aaaa/w1', title: 'alpha' } }))
  await p.call('POST', P + '/v1/todo', { text: 'fix it' })
  await p.call('POST', P + '/v1/todo-confirm', { id: a.itemId(2) })
  await p.call('POST', P + '/v1/todo-confirm', { id: 'nope', sessionId: 'sa1' })
  await h.desktop('POST', P + '/v1/todo', { text: 'x', followUp: 'words' })
  await h.desktop('POST', P + '/v1/todo-confirm', { id: a.itemId(1), sessionId: 'sa1' })
  assert.deepEqual(audit(h), [])
})

// ---- the phone never reads or posts into a session through a SENT follow-up (a phone may ask for a message to any session of any app, but it gets no window into it) ----

const SENT = (agent, n) => followItem(agent, n, { state: 'started', sessionId: 's2', sessionTitle: 'Docs', candidates: [{ sessionId: 's2', title: 'Docs', owner: agent.id }] })

test('a phone cannot read or post into the session of a sent follow-up: thread is no-session, post is not-a-session, nothing reaches the app', async (t) => {
  const { a, p } = await phoneWithApps(t)
  await a.send(SENT(a, 1))
  const read = await p.call('POST', P + '/v1/thread', { id: a.itemId(1) })
  assert.deepEqual([read.status, read.json], [409, { ok: false, error: 'no-session' }])
  const post = await p.call('POST', P + '/v1/post', { id: a.itemId(1), text: 'sneaky' })
  assert.deepEqual([post.status, post.json], [409, { ok: false, error: 'not-a-session' }])
  await nothingQueued(a)
})

test('the desktop still reaches the session of a sent follow-up: thread and post go to the owner app', async (t) => {
  const { h, a } = await phoneWithApps(t)
  await a.send(SENT(a, 1))
  const reading = h.desktop('POST', P + '/v1/thread', { id: a.itemId(1) })
  const cmd = (await a.poll(0, 3000)).json.commands[0]
  assert.deepEqual([cmd.kind, cmd.args.sessionId], ['thread', 's2'])
  await a.result(cmd.cid, { ok: true, messages: [], hasMore: false })
  assert.equal((await reading).status, 200)
  const posting = h.desktop('POST', P + '/v1/post', { id: a.itemId(1), text: 'and the lint' })
  const post = (await a.poll(cmd.cid, 3000)).json.commands[0]
  assert.equal(post.kind, 'post')
  await a.result(post.cid, { ok: true })
  assert.deepEqual([(await posting).status, (await posting).json], [200, { ok: true }])
})
